/**
 * Hearthside's own pages are styled by the Hearthside design system, not
 * Tailwind (spec #69). Tailwind is here only for the shared top bar, which
 * keeps the portfolio's look on both sites, so:
 *
 * - it scans only the shared package, never Hearthside's own source;
 * - its base reset (preflight) is off, so it can't restyle Hearthside's pages;
 * - every utility is scoped under `.hs-topbar` (the wrapper the bar is
 *   mounted in, src/components/TopBarMount.tsx), so a class name the bar uses
 *   means nothing outside it, and the bar's utilities outrank the design
 *   system's element rules (`.hs-app button`) inside it.
 *
 * What the bar needs from preflight it gets from a reset scoped to
 * `.hs-topbar` in src/app/globals.css. test/styling-isolation.test.ts checks
 * all of this against the compiled CSS.
 *
 * @type {import('tailwindcss').Config}
 */
module.exports = {
  content: {
    // Paths are relative to this file, not to wherever the build runs from.
    relative: true,
    files: ["../packages/shared/src/**/*.{js,ts,jsx,tsx}"],
  },
  important: ".hs-topbar",
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
};
