/** @type {import('tailwindcss').Config} */
// tailwind.config.js
// PDF Signature Verifier — build-time Tailwind config (PRD v1.7, Section 6.6)
// This file is a build-time dependency only, per Section 6.6 — never loaded
// via the runtime CDN in production.

module.exports = {
  content: [
    './index.html',
    './js/**/*.js',
  ],

  // Class-based dark mode, per FR-04 (Section 4.4). Default state (dark) is
  // applied by an inline pre-paint script in <head>, not by this config —
  // this only controls which strategy Tailwind compiles for.
  darkMode: 'class',

  theme: {
    extend: {
      colors: {
        // Section 5.1: `slate-850` does not exist in Tailwind's default
        // palette (slate stops at 950 in increments of 100). Extended here
        // exactly as flagged in the PRD to prevent a silent build error.
        'slate-850': '#172033',
      },
      fontFamily: {
        // Section 6.6: no custom display font — system font stack only,
        // to protect the < 1.2s LCP target.
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
      },
    },
  },

  plugins: [],
};
