/** @type {import('tailwindcss').Config} */
module.exports = {
  content: {
    // Paths are relative to this file, not to wherever the build runs from.
    relative: true,
    files: [
      "./src/**/*.{js,ts,jsx,tsx,mdx}",
      // The package shared with Hearthside (#209): classes used only there
      // would otherwise be purged from the portfolio's CSS.
      "../packages/shared/src/**/*.{js,ts,jsx,tsx}",
    ],
  },
  theme: {
    extend: {
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
        "gradient-conic":
          "conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))",
      },
    },
  },
  plugins: [],
};
