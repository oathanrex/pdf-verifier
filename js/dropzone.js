/**
 * dropzone.js
 * PDF Signature Verifier — Dropzone Component (FR-01)
 * DOM-dependent by nature (drag/drop, click-to-browse, keyboard input).
 * Validated via the acceptance-gate checklist (Section 8.2) and browser
 * integration testing at Step 4, not Node unit tests.
 */

const MAGIC_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
const SIZE_SOFT_CAP_BYTES = 25 * 1024 * 1024; // 25MB — Section 4.1

/**
 * @param {Object} deps
 * @param {HTMLElement} deps.dropzoneEl
 * @param {HTMLInputElement} deps.fileInputEl
 * @param {import('./stateMachine.js').StateController} deps.stateController
 * @param {(file: File) => void} deps.onValidFile
 * @returns {{ resetFileInput: () => void }}
 */
export function initDropzone({ dropzoneEl, fileInputEl, stateController, onValidFile }) {
  let dragCounter = 0; // FR-01: fixes the dragenter/dragleave child-bubbling flicker

  // Defense-in-depth alongside the dragCounter: direct children can never
  // themselves be the target of a drag event, eliminating the
  // enter/leave-on-child-boundary problem at the DOM level.
  Array.from(dropzoneEl.children).forEach((child) => {
    child.style.pointerEvents = 'none';
  });

  function isTouchDevice() {
    return 'ontouchstart' in window;
  }

  function setActiveDragUI(active) {
    dropzoneEl.classList.toggle('is-dragging', active);
  }

  function resetFileInput() {
    // 4.3.2 — required so re-selecting the identical file still fires
    // a fresh 'change' event.
    fileInputEl.value = '';
  }

  function bytesEqualPdfHeader(bytes) {
    if (bytes.length < MAGIC_BYTES.length) return false;
    for (let i = 0; i < MAGIC_BYTES.length; i++) {
      if (bytes[i] !== MAGIC_BYTES[i]) return false;
    }
    return true;
  }

  /**
   * FR-01: cheap, main-thread magic-byte check via a 5-byte Blob slice —
   * never a full-file read. Synchronous decision point for whether this
   * drop becomes PROCESSING or an instant REJECTED_INVALID_FILE.
   */
  async function handleCandidateFile(file) {
    if (stateController.isLocked()) return; // FR-02b / 4.3.2 lock — ignore input entirely

    if (!(file instanceof File)) {
      stateController.toRejectedInvalidFile('No file was provided.');
      resetFileInput();
      return;
    }

    if (file.size > SIZE_SOFT_CAP_BYTES) {
      stateController.toRejectedInvalidFile(
        `File is ${(file.size / (1024 * 1024)).toFixed(1)}MB, which exceeds the 25MB guardrail for reliable in-browser processing.`
      );
      resetFileInput();
      return;
    }

    let header;
    try {
      const headerBuffer = await file.slice(0, 5).arrayBuffer();
      header = new Uint8Array(headerBuffer);
    } catch (err) {
      stateController.toRejectedInvalidFile('Could not read the beginning of the file.');
      resetFileInput();
      return;
    }

    if (!bytesEqualPdfHeader(header)) {
      stateController.toRejectedInvalidFile('This does not appear to be a PDF file (missing %PDF- header).');
      resetFileInput();
      return;
    }

    onValidFile(file);
  }

  // --- Drag and drop -------------------------------------------------------

  dropzoneEl.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (stateController.isLocked()) return;
    dragCounter++;
    setActiveDragUI(true);
  });

  dropzoneEl.addEventListener('dragover', (event) => {
    // preventDefault is required on dragover for drop to fire at all.
    event.preventDefault();
  });

  dropzoneEl.addEventListener('dragleave', (event) => {
    event.preventDefault();
    if (stateController.isLocked()) return;
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) setActiveDragUI(false);
  });

  dropzoneEl.addEventListener('drop', (event) => {
    event.preventDefault();
    dragCounter = 0; // hard reset — drop always terminates the drag session
    setActiveDragUI(false);
    if (stateController.isLocked()) return;
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) handleCandidateFile(file);
  });

  // --- Click-to-browse -------------------------------------------------------

  dropzoneEl.addEventListener('click', () => {
    if (stateController.isLocked()) return;
    fileInputEl.click();
  });

  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files && fileInputEl.files[0];
    if (file) handleCandidateFile(file);
  });

  // --- Keyboard accessibility -------------------------------------------------------

  dropzoneEl.setAttribute('tabindex', '0');
  dropzoneEl.setAttribute('role', 'button');
  dropzoneEl.setAttribute(
    'aria-label',
    isTouchDevice() ? 'Tap to select a PDF file to verify' : 'Drag and drop a PDF file here, or press Enter to browse'
  );

  dropzoneEl.addEventListener('keydown', (event) => {
    if (stateController.isLocked()) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInputEl.click();
    }
  });

  return { resetFileInput };
}
