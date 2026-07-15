/**
 * main.js
 * PDF Signature Verifier — Entry Point
 * Must be loaded as <script type="module" src="main.js"> — the
 * import.meta.url worker-path resolution in runWorker() below requires it.
 */

import { StateController, STATES } from './stateMachine.js';
import { initDropzone } from './dropzone.js';
import { initTheme } from './theme.js';

const WORKER_TIMEOUT_MS = 8000;   // FR-02b timeout guard
const PROCESSING_MIN_MS = 400;    // 4.3.1 artificial floor — PROCESSING only, never REJECTED_INVALID_FILE

// --- DOM references ---------------------------------------------------------

const dropzoneEl = document.getElementById('dropzone');
const fileInputEl = document.getElementById('file-input');
const themeToggleEl = document.getElementById('theme-toggle');
const resultEl = document.getElementById('result');
const resetButtons = document.querySelectorAll('[data-action="reset"]');

// --- State + module wiring ---------------------------------------------------------

const stateController = new StateController({ onStateChange: renderState });

let activeWorker = null;
let activeTimeoutId = null;

initTheme({ toggleEl: themeToggleEl });

const dz = initDropzone({
  dropzoneEl,
  fileInputEl,
  stateController,
  onValidFile: handleValidFile,
});

resetButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    dz.resetFileInput();
    stateController.reset();
  });
});

// Initial paint, matching whatever state the pre-paint inline script left
// the DOM in (theme) plus the machine's own IDLE default.
renderState(stateController.getState(), stateController.getPayload());

// --- File handling ---------------------------------------------------------

function handleValidFile(file) {
  // dropzone.js already checked isLocked() before calling this, but the
  // transition below is what ACTUALLY enforces the Single-Active-Worker
  // Lock from this point forward — it's a state-machine guarantee, not
  // merely an event-handler check that a race could slip past.
  stateController.toProcessing();
  runWorker(file);
}

function runWorker(file) {
  const startedAt = performance.now();
  let settled = false;

  // FR-02b: import.meta.url-relative instantiation — correct regardless of
  // deployment subpath or nested folder depth. Requires this file to be
  // loaded as a module (see file header).
  // Classic (non-module) worker, deliberately — pdfParser.worker.js has no
  // runtime import/export dependency (its module.exports block is guarded
  // and only used for Node-based unit testing), so there is no need for
  // module-worker semantics here. { type: 'module' } support is narrower
  // across mobile browsers/WebViews than plain classic Worker support, and
  // the import.meta.url-based path resolution below works identically
  // either way, since it's main.js (already a module) resolving the URL,
  // not the worker itself.
  const worker = new Worker(new URL('./pdfParser.worker.js', import.meta.url));
  activeWorker = worker;

  /**
   * Idempotent settle: exactly one of {worker.onmessage, worker.onerror,
   * the timeout} may actually resolve this run. Without this guard, a
   * worker result that arrives a moment after the 8s timeout already fired
   * would still try to drive a second state transition on top of the
   * timeout's FAIL_PARSE_ERROR — a real race the timeout guard's addition
   * introduces if not closed explicitly.
   */
  function settle(result) {
    if (settled) return;
    settled = true;

    if (activeTimeoutId) {
      clearTimeout(activeTimeoutId);
      activeTimeoutId = null;
    }
    if (activeWorker) {
      activeWorker.terminate(); // FR-02b cleanup
      activeWorker = null;
    }

    stateController.toResult(result);
  }

  activeTimeoutId = setTimeout(() => {
    settle({
      status: 'error',
      signatureCount: 0,
      byteRangeValid: false,
      reason: 'Verification timed out after 8 seconds — the file may be malformed or unusually large for in-browser processing.',
      parseTimeMs: performance.now() - startedAt,
    });
  }, WORKER_TIMEOUT_MS);

  worker.onmessage = (event) => {
    applyProcessingFloor(startedAt, () => settle(event.data));
  };

  worker.onerror = (err) => {
    // Catches thrown exceptions inside the worker (per FR-02b's error
    // boundary). Does NOT catch a true OS-level OOM kill — that class of
    // failure has no in-page event and relies on the timeout guard above.
    applyProcessingFloor(startedAt, () =>
      settle({
        status: 'error',
        signatureCount: 0,
        byteRangeValid: false,
        reason: `Worker error: ${err && err.message ? err.message : 'unknown failure inside the parser worker'}`,
        parseTimeMs: performance.now() - startedAt,
      })
    );
  };

  worker.postMessage(file); // structured-clone of the File object — no Transferable, no neutering
}

/**
 * Enforces the 4.3.1 artificial minimum PROCESSING duration. Applies only
 * to the worker-result path — REJECTED_INVALID_FILE (handled entirely
 * inside dropzone.js, before PROCESSING is ever entered) never passes
 * through this function.
 */
function applyProcessingFloor(startedAt, callback) {
  const elapsed = performance.now() - startedAt;
  const remaining = PROCESSING_MIN_MS - elapsed;
  if (remaining <= 0) {
    callback();
  } else {
    setTimeout(callback, remaining);
  }
}

// --- Rendering ---------------------------------------------------------

// Maps each state to the id of the single panel that should be visible.
// index.html must contain exactly one element per id below, each starting
// with the 'hidden' class so this is the single source of truth for which
// panel is shown — no CSS attribute-selector duplication of this logic.
const STATE_PANEL_IDS = {
  [STATES.IDLE]: 'panel-idle',
  [STATES.REJECTED_INVALID_FILE]: 'panel-rejected',
  [STATES.PROCESSING]: 'panel-processing',
  [STATES.SUCCESS]: 'panel-success',
  [STATES.WARNING_UNSIGNED]: 'panel-unsigned',
  [STATES.WARNING_ALTERED]: 'panel-altered',
  [STATES.WARNING_NONSTANDARD]: 'panel-nonstandard',
  [STATES.FAIL_PARSE_ERROR]: 'panel-fail',
};

function renderState(state, payload) {
  document.body.setAttribute('data-state', state);

  dropzoneEl.setAttribute('aria-disabled', String(stateController.isLocked()));
  dropzoneEl.classList.toggle('pointer-events-none', stateController.isLocked());

  // Show exactly one panel — the one mapped to the current state — hide
  // every other known panel. Unknown/missing ids are skipped rather than
  // throwing, so a partially-built page still renders something.
  Object.values(STATE_PANEL_IDS).forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const activeId = STATE_PANEL_IDS[state];
  const activeEl = activeId && document.getElementById(activeId);
  if (activeEl) activeEl.classList.remove('hidden');

  if (resultEl) {
    resultEl.setAttribute('data-status', (payload && payload.status) || '');
  }

  // Bug fix: scope the field lookups to the ACTIVE panel only. Querying
  // resultEl broadly would match the FIRST [data-field="reason"] in
  // document order across all 8 panels — not necessarily the one that
  // just became visible — silently writing the result into an invisible
  // panel while the visible one stays blank.
  renderPayloadDetails(activeEl, payload);
}

/**
 * Populates the plain-English verdict and the FR-05 progressive-disclosure
 * technical detail panel (signature count, byte-range values, parse time,
 * reason string) for whichever panel is currently active.
 */
function renderPayloadDetails(activeEl, payload) {
  if (!activeEl) return;

  const reasonEl = activeEl.querySelector('[data-field="reason"]');
  if (reasonEl) {
    reasonEl.textContent = (payload && payload.reason) || '';
  }

  const detailsEl = activeEl.querySelector('[data-field="technical-details"]');
  if (detailsEl && payload && typeof payload.signatureCount === 'number') {
    detailsEl.textContent =
      `Signatures found: ${payload.signatureCount} · ` +
      `Byte-range valid: ${payload.byteRangeValid} · ` +
      `Parse time: ${Math.round(payload.parseTimeMs || 0)}ms`;
  }
}
