/**
 * stateMachine.js
 * PDF Signature Verifier — State Controller (FR-03)
 * Zero DOM dependency — pure state logic, independently testable.
 *
 * IMPLEMENTATION NOTE (spec gap found while building, not in PRD v1.7):
 * The PRD's FR-03 table defines exactly 6 states, but its own prose
 * elsewhere (FR-02b's timeout guard, 4.2.1 step 5's `nonstandard_encoding`
 * status) refers to outcomes — "Fail: Unable to Parse" and a distinct
 * literal-string-signature case — that don't map onto any of those 6
 * states. Rather than silently collapsing them into WARNING_ALTERED (which
 * would misrepresent a parse failure as a tamper finding, and misrepresent
 * a nonstandard encoding as file corruption), this file adds two states
 * that were implied but never declared: WARNING_NONSTANDARD and
 * FAIL_PARSE_ERROR. This should be reflected back into the PRD's FR-03
 * table as a v1.8 correction.
 */

export const STATES = Object.freeze({
  IDLE: 'IDLE',
  REJECTED_INVALID_FILE: 'REJECTED_INVALID_FILE',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  WARNING_UNSIGNED: 'WARNING_UNSIGNED',
  WARNING_ALTERED: 'WARNING_ALTERED',
  WARNING_NONSTANDARD: 'WARNING_NONSTANDARD',
  FAIL_PARSE_ERROR: 'FAIL_PARSE_ERROR',
});

/**
 * Maps a pdfParser.worker.js result `status` string onto a UI state.
 * Any unrecognized status fails closed to FAIL_PARSE_ERROR rather than
 * silently defaulting to a misleading state.
 */
export function mapWorkerStatusToState(workerStatus) {
  switch (workerStatus) {
    case 'signed':
      return STATES.SUCCESS;
    case 'unsigned':
      return STATES.WARNING_UNSIGNED;
    case 'altered':
      return STATES.WARNING_ALTERED;
    case 'nonstandard_encoding':
      return STATES.WARNING_NONSTANDARD;
    case 'error':
    default:
      return STATES.FAIL_PARSE_ERROR;
  }
}

export class StateController {
  constructor({ onStateChange } = {}) {
    this.state = STATES.IDLE;
    this.payload = null;
    this.onStateChange = typeof onStateChange === 'function' ? onStateChange : () => {};
  }

  getState() {
    return this.state;
  }

  getPayload() {
    return this.payload;
  }

  /**
   * FR-02b Single-Active-Worker Lock, generalized: per 4.3.2, the dropzone
   * must stay inactive for the ENTIRE lifetime of a non-IDLE state, not
   * just PROCESSING — a terminal result (SUCCESS, WARNING_UNSIGNED,
   * WARNING_ALTERED, etc.) still
   * requires an explicit "Verify Another File" reset before a new drop is
   * accepted. PROCESSING is the state where the memory-exhaustion risk
   * specifically lives, but the UX contract locks input more broadly.
   */
  isLocked() {
    return this.state !== STATES.IDLE;
  }

  _transition(next, payload) {
    this.state = next;
    this.payload = payload || null;
    this.onStateChange(this.state, this.payload);
  }

  toRejectedInvalidFile(reason) {
    this._transition(STATES.REJECTED_INVALID_FILE, { reason });
  }

  toProcessing() {
    this._transition(STATES.PROCESSING, null);
  }

  /** `workerResult` is the structured object posted by pdfParser.worker.js. */
  toResult(workerResult) {
    const next = mapWorkerStatusToState(workerResult && workerResult.status);
    this._transition(next, workerResult);
  }

  reset() {
    this._transition(STATES.IDLE, null);
  }
}
