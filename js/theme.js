/**
 * theme.js
 * PDF Signature Verifier — Theme Switcher (FR-04)
 *
 * NOTE: the initial-load, pre-paint decision (avoiding a flash of
 * incorrect theme) MUST happen synchronously in an inline <script> in
 * index.html's <head>, before this module or any stylesheet loads — see
 * Section 4.4 and the Step 4 acceptance-gate checklist (Section 8.2). This
 * module owns TOGGLE-TIME behavior and mirrors the same storage key and
 * "explicit choice beats system preference" rule so the two stay in sync,
 * but it does not run early enough to prevent the initial flash by itself.
 */

const STORAGE_KEY = 'pdfverifier-theme';

/**
 * @param {Object} deps
 * @param {HTMLElement} deps.toggleEl - the accessible switch control
 */
export function initTheme({ toggleEl }) {
  syncToggleAria();

  toggleEl.addEventListener('click', () => {
    const isCurrentlyDark = document.documentElement.classList.contains('dark');
    setTheme(isCurrentlyDark ? 'light' : 'dark');
  });

  toggleEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleEl.click();
    }
  });

  function setTheme(mode) {
    document.documentElement.classList.toggle('dark', mode === 'dark');
    syncToggleAria();
    try {
      // Once the user makes an explicit choice, it takes precedence over
      // prefers-color-scheme on every subsequent visit (FR-04).
      localStorage.setItem(STORAGE_KEY, mode);
    } catch (err) {
      // Storage may be unavailable (private browsing / quota exceeded) —
      // theme still applies for this session, it just won't persist.
    }
  }

  function syncToggleAria() {
    const isDark = document.documentElement.classList.contains('dark');
    toggleEl.setAttribute('role', 'switch');
    toggleEl.setAttribute('aria-checked', String(isDark));
    toggleEl.setAttribute('aria-label', isDark ? 'Switch to light mode' : 'Switch to dark mode');
  }
}
