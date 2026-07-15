/**
 * pdfParser.worker.js
 * ---------------------------------------------------------------------------
 * PDF Signature Verifier — Binary Parser (Web Worker)
 * Implements PRD v1.7: FR-02, FR-02b, section 4.2.0a, 4.2.1, 4.2.1a
 *
 * Zero DOM dependency. Receives a structured-cloned `File` object from the
 * main thread, performs the ONE full-file read internally (buffer =
 * await file.arrayBuffer()), scans it for a PDF digital signature dictionary,
 * and posts back a structured result. Never touches document/window.
 *
 * This file is independently testable: feed it a message with a `File`-like
 * object (or in Node, any object exposing an async .arrayBuffer()) and
 * assert on the posted result shape.
 * ---------------------------------------------------------------------------
 */

// ============================================================================
// Constants (traceable to PRD sections)
// ============================================================================

const CHUNK_SIZE = 65536;          // 64KB — 4.2.0a step 1
const MAX_PATTERN_LENGTH = 10;     // longest search term is "/ByteRange" (10 bytes)
const OVERLAP = 16;                // 4.2.0a: maxPatternLength - 1, rounded up for margin
const TAIL_WINDOW = 524288;        // 512KB — 4.2.0a step 2 (tail-first fast path)
const WINDOW_START_MARGIN = 256;   // 4.2.0a step 3: bytes of context before the match
const INITIAL_DECODE_WINDOW = 4096;   // 4KB — 4.2.0a step 3
const DECODE_GROW_STEP = 4096;        // 4KB increments
const MAX_DECODE_WINDOW = 65536;      // 64KB cap — 4.2.0a step 3
const EOF_TOLERANCE_CAP = 2048;       // 2KB — 4.2.1a step 3
const WORKER_INTERNAL_STEP_LIMIT = 200; // sanity cap on window-growth loop iterations

// ASCII byte-sequence helpers ------------------------------------------------

function bytesOf(str) {
  const arr = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) arr[i] = str.charCodeAt(i) & 0xff;
  return arr;
}

const PATTERN_TYPE_SIG = bytesOf('/Type/Sig');   // 9 bytes
const PATTERN_FT_SIG = bytesOf('/FT/Sig');       // 7 bytes
const SEARCH_PATTERNS = [PATTERN_TYPE_SIG, PATTERN_FT_SIG];

// ============================================================================
// 4.2.0a — Byte-pattern scanning (Uint8Array, no full-buffer decode)
// ============================================================================

/**
 * Naive byte-pattern match within a single Uint8Array slice.
 * Returns an array of match start offsets, relative to the slice.
 */
function findPatternOffsetsInSlice(slice, pattern) {
  const offsets = [];
  const sliceLen = slice.length;
  const patLen = pattern.length;
  if (patLen === 0 || sliceLen < patLen) return offsets;

  outer: for (let i = 0; i <= sliceLen - patLen; i++) {
    for (let j = 0; j < patLen; j++) {
      if (slice[i + j] !== pattern[j]) continue outer;
    }
    offsets.push(i);
  }
  return offsets;
}

/**
 * Scans the byte range [regionStart, regionEnd) of `buffer` using
 * overlapping, fixed-size chunks (per 4.2.0a). Returns a Set of ABSOLUTE
 * buffer offsets where any pattern in SEARCH_PATTERNS matches — deduplicated,
 * because the overlap window can otherwise report the same match twice.
 */
function scanRegionForPatterns(buffer, regionStart, regionEnd) {
  const matches = new Set(); // absolute offsets — dedup requirement, 4.2.0a step 1

  let chunkIndex = 0;
  let pos = regionStart;

  while (pos < regionEnd) {
    // Chunk N starts at (N * CHUNK_SIZE) - OVERLAP, clamped to regionStart.
    const nominalStart = regionStart + chunkIndex * CHUNK_SIZE;
    const readStart = Math.max(regionStart, nominalStart - OVERLAP);
    const readEnd = Math.min(regionEnd, nominalStart + CHUNK_SIZE);

    if (readStart >= readEnd) break;

    const slice = buffer.subarray(readStart, readEnd);

    for (const pattern of SEARCH_PATTERNS) {
      const relativeOffsets = findPatternOffsetsInSlice(slice, pattern);
      for (const rel of relativeOffsets) {
        matches.add(readStart + rel); // absolute offset — dedup via Set
      }
    }

    pos = nominalStart + CHUNK_SIZE;
    chunkIndex++;
  }

  return matches;
}

/**
 * Top-level detection entry point: tail-first fast path with a small-file
 * guard (4.2.0a step 2), falling back to a full-buffer scan only when the
 * tail scan finds nothing and the file is large enough for the two phases
 * to actually differ.
 */
function detectSignatureOffsets(buffer) {
  const totalLength = buffer.byteLength; // buffer.byteLength — NOT file.byteLength (fixes worker scope-leak)

  // Small-file guard: skip the two-phase logic entirely when it would be
  // redundant (tail window >= whole file).
  if (totalLength <= TAIL_WINDOW) {
    return scanRegionForPatterns(buffer, 0, totalLength);
  }

  const tailStart = totalLength - TAIL_WINDOW;
  const tailMatches = scanRegionForPatterns(buffer, tailStart, totalLength);
  if (tailMatches.size > 0) {
    return tailMatches;
  }

  // Fallback: full-buffer forward scan (rare — most real signed PDFs resolve
  // via the tail-first path above).
  return scanRegionForPatterns(buffer, 0, totalLength);
}

// ============================================================================
// 4.2.0a step 3 — Windowed decode (clamped, growable, capped)
// ============================================================================

/**
 * Decodes a small, bounded slice of `buffer` around absolute offset `i`.
 * Start offset is explicitly clamped via Math.max — subarray() treats a
 * negative `begin` as "offset from the end," so an unclamped
 * `i - WINDOW_START_MARGIN` would silently slice the wrong region of the
 * file for matches near the start (fixed per PRD v1.6 audit).
 */
function decodeWindow(buffer, matchOffset, windowSize) {
  const start = Math.max(0, matchOffset - WINDOW_START_MARGIN);
  const end = Math.min(buffer.byteLength, matchOffset + windowSize);
  const slice = buffer.subarray(start, end);
  const decoder = new TextDecoder('latin1'); // NOT utf-8 — 4.2.1 step 2 rationale
  return { text: decoder.decode(slice), windowStart: start };
}

// ============================================================================
// 4.2.1 step 3 — Scoped dictionary block capture (depth-aware, bounded)
// ============================================================================

/**
 * Given a decoded window string and the index of a /Type/Sig (or /FT/Sig)
 * match within it, locates the enclosing `<< ... >>` dictionary block via
 * depth-aware bracket matching — NOT a greedy regex across the window —
 * to avoid the object-key collision risk described in 4.2.0a.
 * Returns { start, end } (indices into `text`) or null if unresolved within
 * the current window (caller should grow the window and retry).
 */
function findEnclosingDictBlock(text, matchIndex) {
  // Scan backward from matchIndex to find the opening "<<" of the block
  // that directly encloses it.
  let depth = 0;
  let openIndex = -1;
  for (let i = matchIndex; i >= 1; i--) {
    if (text[i - 1] === '>' && text[i] === '>') {
      depth++;
      i--; // consume both characters of ">>"
      continue;
    }
    if (text[i - 1] === '<' && text[i] === '<') {
      if (depth === 0) {
        openIndex = i - 1;
        break;
      }
      depth--;
      i--; // consume both characters of "<<"
    }
  }
  if (openIndex === -1) return null;

  // Scan forward from openIndex to find the matching closing "<<...>>" pair.
  depth = 0;
  for (let i = openIndex; i < text.length - 1; i++) {
    if (text[i] === '<' && text[i + 1] === '<') {
      depth++;
      i++;
      continue;
    }
    if (text[i] === '>' && text[i + 1] === '>') {
      depth--;
      i++;
      if (depth === 0) {
        return { start: openIndex, end: i + 1 }; // end is exclusive
      }
    }
  }
  return null; // unbalanced within this window — caller should grow window
}

// ============================================================================
// 4.2.1 step 4 — ByteRange extraction (Number-cast at source, NaN-guarded)
// ============================================================================

const BYTE_RANGE_RE = /\/ByteRange\s*\[\s*(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s*\]/;

/**
 * Extracts and immediately numeric-casts the four /ByteRange integers.
 * Regex capture groups are always strings — summing them with `+` before
 * casting causes string concatenation, not arithmetic (fixed per PRD v1.7
 * audit). Every value is cast here, at the source, so no downstream
 * consumer ever touches a raw string.
 */
function extractByteRange(blockText) {
  const match = BYTE_RANGE_RE.exec(blockText);
  if (!match) return null;

  const byteRange = match.slice(1, 5).map(Number); // cast at extraction time
  if (byteRange.some((n) => Number.isNaN(n))) {
    return null; // malformed /ByteRange — caller treats as parse failure
  }
  return byteRange;
}

// ============================================================================
// 4.2.1 step 5 — Contents extraction (whitespace-tolerant hex + literal fallback)
// ============================================================================

// [\s\S]*? (not `.`) so the match spans line breaks — PDF hex strings are
// legally line-wrapped by legacy producers per ISO 32000.
const CONTENTS_HEX_RE = /\/Contents\s*<([\s\S]*?)>/;
const CONTENTS_LITERAL_RE = /\/Contents\s*\(([\s\S]*?)\)/;

/**
 * Extracts the /Contents signature blob from a scoped dictionary block.
 * Returns { encoding: 'hex', hex: string } | { encoding: 'literal', raw: string } | null
 */
function extractContents(blockText) {
  const hexMatch = CONTENTS_HEX_RE.exec(blockText);
  if (hexMatch) {
    // Whitespace inside a hex string is legal per ISO 32000 and must be
    // stripped before any hex-to-binary conversion, or a line-wrapped
    // signature throws a decode error instead of producing a result.
    const strippedHex = hexMatch[1].replace(/\s/g, '');
    return { encoding: 'hex', hex: strippedHex };
  }

  // Literal-string fallback (4.2.1 step 5). Not expected from any
  // conformant producer — see PRD rationale — but handled distinctly
  // rather than folded into a generic parse failure.
  const literalMatch = CONTENTS_LITERAL_RE.exec(blockText);
  if (literalMatch) {
    return { encoding: 'literal', raw: literalMatch[1] };
  }

  return null;
}

// ============================================================================
// Per-match resolution: grow the decode window until both ByteRange and
// Contents are captured, or the 64KB cap is hit.
// ============================================================================

function resolveSignatureAtOffset(buffer, matchOffset) {
  let windowSize = INITIAL_DECODE_WINDOW;
  let steps = 0;

  while (windowSize <= MAX_DECODE_WINDOW && steps < WORKER_INTERNAL_STEP_LIMIT) {
    steps++;
    const { text, windowStart } = decodeWindow(buffer, matchOffset, windowSize);
    const relativeMatchIndex = matchOffset - windowStart;

    const block = findEnclosingDictBlock(text, relativeMatchIndex);
    if (!block) {
      windowSize += DECODE_GROW_STEP;
      continue;
    }

    const blockText = text.slice(block.start, block.end);
    const byteRange = extractByteRange(blockText);
    const contents = extractContents(blockText);

    if (!byteRange || !contents) {
      // Either piece missing could mean it's just outside the current
      // window — grow and retry, up to the cap.
      windowSize += DECODE_GROW_STEP;
      continue;
    }

    return { byteRange, contents, offset: matchOffset };
  }

  return null; // exceeded cap — malformed/adversarial file (4.2.0a step 3)
}

// ============================================================================
// 4.2.1a — Content-aware EOF tolerance classification
// ============================================================================

// Allow-listed trailing content: whitespace/CR/LF, null-byte padding, and at
// most one well-formed trailing incremental-update block.
const EOF_ALLOWLIST_RE = /^[\s\0]*(?:startxref\s*\d+\s*%%EOF\s*)?[\s\0]*$/;

/**
 * Classifies the relationship between the most recent signature's
 * /ByteRange coverage and the buffer's actual length. Returns
 * { verdict: 'signed' | 'altered', reason: string }.
 */
function classifyEofTolerance(buffer, byteRange) {
  const claimedEnd = byteRange[2] + byteRange[3]; // already Number-cast
  const trailingBytes = buffer.byteLength - claimedEnd;

  if (trailingBytes === 0) {
    return { verdict: 'signed', reason: 'ByteRange coverage matches file length exactly.' };
  }

  if (trailingBytes < 0) {
    // File is SHORTER than the signature claims — content was removed
    // after signing. No tolerance applies in this direction (4.2.1a step 5).
    return {
      verdict: 'altered',
      reason: 'File is shorter than the signed byte range claims — content appears to have been removed after signing.',
    };
  }

  if (trailingBytes > EOF_TOLERANCE_CAP) {
    return {
      verdict: 'altered',
      reason: `${trailingBytes} unaccounted trailing bytes exceed the ${EOF_TOLERANCE_CAP}-byte tolerance cap — not a plausible benign artifact.`,
    };
  }

  // Classify the actual trailing bytes' content, not just their count.
  const trailingSlice = buffer.subarray(claimedEnd, buffer.byteLength);
  const trailingText = new TextDecoder('latin1').decode(trailingSlice);

  if (EOF_ALLOWLIST_RE.test(trailingText)) {
    return {
      verdict: 'signed',
      reason: `${trailingBytes} trailing bytes matched an allow-listed benign pattern (whitespace/padding/incremental-update marker).`,
    };
  }

  return {
    verdict: 'altered',
    reason: `${trailingBytes} trailing bytes did not match any allow-listed benign pattern — treated as injected content.`,
  };
}

// ============================================================================
// Top-level orchestration (4.2.1 full pipeline)
// ============================================================================

async function parsePdfSignature(file) {
  const startTime = performanceNow();

  // Step 1 (revised architecture, PRD v1.7): the ONE full-file read,
  // performed here, inside the worker — never on the main thread.
  const arrayBuffer = await file.arrayBuffer();
  const buffer = new Uint8Array(arrayBuffer);

  // Steps 2–3: byte-level detection, no full-buffer decode.
  const matchOffsets = Array.from(detectSignatureOffsets(buffer)).sort((a, b) => a - b);

  if (matchOffsets.length === 0) {
    return buildResult('unsigned', 0, false, 'No /Type/Sig or /FT/Sig signature dictionary found.', startTime);
  }

  // Steps 3–5: resolve each match to a { byteRange, contents } pair.
  const resolved = [];
  for (const offset of matchOffsets) {
    const sig = resolveSignatureAtOffset(buffer, offset);
    if (sig) resolved.push(sig);
  }

  if (resolved.length === 0) {
    // Matches were found at the byte level, but none resolved to a
    // complete, well-formed signature dictionary within the decode cap.
    return buildResult('error', matchOffsets.length, false, 'Signature marker(s) found but dictionary structure could not be resolved — file may be malformed or adversarially crafted.', startTime);
  }

  // Check whether any resolved signature used the literal-string fallback.
  const nonstandard = resolved.find((s) => s.contents.encoding === 'literal');
  if (nonstandard && resolved.length === 1) {
    return buildResult('nonstandard_encoding', resolved.length, false, 'Signature /Contents used a non-hex (literal string) encoding, which is not expected from any conformant signing tool.', startTime);
  }

  // Step 6: EOF tolerance check against the MOST RECENT signature
  // (multi-revision handling — 4.2.0 note).
  const mostRecent = resolved[resolved.length - 1];
  const { verdict, reason } = classifyEofTolerance(buffer, mostRecent.byteRange);

  const status = verdict === 'signed' ? 'signed' : 'altered';
  return buildResult(status, resolved.length, verdict === 'signed', reason, startTime);
}

function buildResult(status, signatureCount, byteRangeValid, reason, startTime) {
  return {
    status,           // 'signed' | 'unsigned' | 'altered' | 'error' | 'nonstandard_encoding'
    signatureCount,
    byteRangeValid,
    reason,
    parseTimeMs: performanceNow() - startTime,
  };
}

// Worker contexts have `performance.now()`; guarded for standalone testing
// in non-worker environments (e.g. Node-based unit tests).
function performanceNow() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

// ============================================================================
// Worker entry point
// ============================================================================

const handleMessage = async (event) => {
  const file = event.data; // structured-cloned File object — see FR-02b / 4.2.1 step 1

  try {
    const result = await parsePdfSignature(file);
    self.postMessage(result);
  } catch (err) {
    // Internal error boundary: catches thrown exceptions (malformed input,
    // failed allocation, etc.) and reports them as a structured result
    // rather than letting them propagate to the uncatchable OOM case that
    // only the main thread's worker.onerror + timeout guard can handle
    // (see FR-02b "Honest limit on this fix").
    self.postMessage({
      status: 'error',
      signatureCount: 0,
      byteRangeValid: false,
      reason: `Internal parser error: ${err && err.message ? err.message : String(err)}`,
      parseTimeMs: 0,
    });
  }
};

// Guarded assignment: `self` does not exist outside a real Worker global
// scope (e.g. when this module is `require()`d directly by a Node-based
// unit test), so the entry point is only wired up when it's actually safe.
if (typeof self !== 'undefined') {
  self.onmessage = handleMessage;
}

// Exports for standalone/unit testing outside the Worker global scope
// (e.g. `import * as parser from './pdfParser.worker.js'` in a test runner
// that stubs `self`). Harmless no-op inside a real Worker context.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parsePdfSignature,
    detectSignatureOffsets,
    resolveSignatureAtOffset,
    extractByteRange,
    extractContents,
    classifyEofTolerance,
    findEnclosingDictBlock,
    decodeWindow,
  };
}
