/**
 * main.js
 * PDF Signature Verifier — Entry Point
 * Must be loaded as <script type="module" src="main.js"> — the
 * import.meta.url worker-path resolution in runWorker() below requires it.
 */

import { StateController, STATES } from './stateMachine.js';
import { initDropzone } from './dropzone.js';
import { initTheme } from './theme.js';

// Maps each state to the id of the single panel that should be visible.
// index.html must contain exactly one element per id below, each starting
// with the 'hidden' class so this is the single source of truth for which
// panel is shown — no CSS attribute-selector duplication of this logic.
//
// BUG FIX (found via real-device console error, not anticipated in spec):
// this declaration MUST come before any code that calls renderState() —
// including the initial paint call further down this file. `const` is
// hoisted but left in a "temporal dead zone" until its declaration line
// actually executes; the previous version of this file declared
// STATE_PANEL_IDS near the bottom, AFTER the initial renderState() call
// already ran and tried to read it — throwing "Cannot access
// 'STATE_PANEL_IDS' before initialization" and aborting the rest of the
// module's top-level execution entirely. Because that abort happened
// mid-file, everything below the crash point — including this very
// declaration in its old location — never ran, so the error repeated on
// every subsequent state change forever (the exact "first upload does
// nothing, every retry is silently ignored" symptom).
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

// Manual escape hatch (defense-in-depth): unlike the terminal-state reset
// buttons above, this one is reachable WHILE PROCESSING and forcibly tears
// down any in-flight worker/timeout rather than waiting for one to settle
// naturally — for the case where something unforeseen leaves the state
// machine stuck despite the try/catch guards in runWorker().
document.querySelectorAll('[data-action="force-reset"]').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (activeTimeoutId) {
      clearTimeout(activeTimeoutId);
      activeTimeoutId = null;
    }
    if (activeWorker) {
      try {
        activeWorker.terminate();
      } catch (e) {
        // already dead or never fully constructed — nothing to clean up
      }
      activeWorker = null;
    }
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

  let worker;

  /**
   * Idempotent settle: exactly one of {worker.onmessage, worker.onerror,
   * the timeout, a construction/postMessage failure} may actually resolve
   * this run. Without this guard, a worker result that arrives a moment
   * after the 8s timeout already fired would still try to drive a second
   * state transition on top of the timeout's FAIL_PARSE_ERROR — a real
   * race the timeout guard's addition introduces if not closed explicitly.
   */
  function settle(result) {
    if (settled) return;
    settled = true;

    if (activeTimeoutId) {
      clearTimeout(activeTimeoutId);
      activeTimeoutId = null;
    }
    if (activeWorker) {
      try {
        activeWorker.terminate(); // FR-02b cleanup
      } catch (e) {
        // Worker may already be dead/never fully constructed — nothing
        // further to clean up in that case.
      }
      activeWorker = null;
    }

    stateController.toResult(result);
  }

  // FR-02b: import.meta.url-relative instantiation — correct regardless of
  // deployment subpath or nested folder depth. Classic (non-module) worker,
  // deliberately — pdfParser.worker.js has no runtime import/export
  // dependency, and classic-worker support is broader across mobile
  // browsers/WebViews than { type: 'module' }.
  //
  // CRITICAL: this call is wrapped in try/catch. If `new Worker(...)`
  // throws synchronously (blocked by a restrictive WebView, a CSP rule, or
  // any other environment-specific reason), execution would otherwise skip
  // straight past the setTimeout() call below without ever scheduling it —
  // meaning NO timeout, NO onmessage, NO onerror would ever fire, and the
  // state machine would stay in PROCESSING permanently. Because every
  // non-IDLE state locks the dropzone (per FR-03's generalized lock), this
  // exact failure mode presents as "first upload does nothing, every
  // subsequent click is silently ignored forever" — found via real-device
  // testing, not anticipated in the original spec.
  try {
    worker = new Worker(new URL('./pdfParser.worker.js', import.meta.url));
    activeWorker = worker;
  } catch (err) {
    settle({
      status: 'error',
      signatureCount: 0,
      byteRangeValid: false,
      reason: `This browser could not start the verification worker (${err && err.message ? err.message : 'unknown error'}). Try a different browser, or make sure the page was opened over http/https, not as a local file.`,
      parseTimeMs: 0,
    });
    return;
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

  try {
    worker.postMessage(file); // structured-clone of the File object — no Transferable, no neutering
  } catch (err) {
    settle({
      status: 'error',
      signatureCount: 0,
      byteRangeValid: false,
      reason: `Could not hand the file to the verification worker (${err && err.message ? err.message : 'unknown error'}).`,
      parseTimeMs: performance.now() - startedAt,
    });
  }
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
