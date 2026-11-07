/**
 * Hearthside's styling stays out of the portfolio, and the top bar's Tailwind
 * stays out of Hearthside's pages (#216, spec #69).
 *
 * - The portfolio loads none of Hearthside's CSS: nothing in its source or
 *   config reaches into hearthside/, and no `hs-` design-system class or
 *   stylesheet appears there.
 * - Hearthside compiles Tailwind for the shared top bar only, with the base
 *   reset (preflight) off and every utility scoped under `.hs-topbar`, so the
 *   bar's classes can't restyle the page beneath it. This compiles the app's
 *   real global CSS with its real Tailwind config and checks the output.
 * - The design system's stylesheets are Hearthside's global CSS, applied under
 *   the `hs-app` body class.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "tailwindcss";

const APP = path.resolve(__dirname, "..");
const ROOT = path.resolve(APP, "..");
const PORTFOLIO = path.join(ROOT, "frontend");

function files(dir: string, ext: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : files(full, ext);
    return ext.test(e.name) ? [full] : [];
  });
}

test("the portfolio's source and config never reach into Hearthside", () => {
  const sources = [
    ...files(path.join(PORTFOLIO, "src"), /\.(js|jsx|ts|tsx|mjs|cjs|css)$/),
    ...["next.config.js", "tailwind.config.js", "postcss.config.js"].map((f) => path.join(PORTFOLIO, f)),
  ];
  const found = sources.flatMap((f) =>
    fs.readFileSync(f, "utf8").split(/\r?\n/).flatMap((line, i) =>
      /hearthside\/|design-system|\bhs-app\b|\bhs-shell\b|\bhs-gilded\b/.test(line) ? [`${path.relative(ROOT, f)}:${i + 1}`] : []));
  assert.deepEqual(found, [], "the portfolio must not load Hearthside's styles");
});

test("the portfolio's Tailwind scans none of Hearthside's files", () => {
  const content = require(path.join(PORTFOLIO, "tailwind.config.js")).content;
  const globs: string[] = (Array.isArray(content) ? content : content.files).filter((f: unknown) => typeof f === "string");
  assert.deepEqual(globs.filter((g) => g.includes("hearthside")), []);
});

test("Hearthside's Tailwind scans only the shared package, never its own pages", () => {
  const config = require(path.join(APP, "tailwind.config.js"));
  const globs: string[] = (Array.isArray(config.content) ? config.content : config.content.files)
    .filter((f: unknown) => typeof f === "string");
  assert.ok(globs.length > 0);
  for (const g of globs) assert.match(g, /^\.\.\/packages\/shared\/src\//, `${g} is outside the shared package`);
  assert.equal(config.corePlugins?.preflight, false, "Tailwind's base reset is off");
  assert.equal(config.important, ".hs-topbar", "utilities are scoped to the top bar");
});

test("compiled, Hearthside's CSS has no Tailwind reset and every utility sits under .hs-topbar", async () => {
  const cssPath = path.join(APP, "src", "app", "globals.css");
  const config = require(path.join(APP, "tailwind.config.js"));
  // Tailwind resolves content globs against the config file (content.relative).
  const out = await postcss([tailwind({ ...config, content: { ...config.content, files: config.content.files.map((g: string) => path.join(APP, g).split(path.sep).join("/")) } })])
    .process(fs.readFileSync(cssPath, "utf8"), { from: cssPath });
  const css = out.css;

  // Preflight's own rules: none of them made it in.
  assert.doesNotMatch(css, /^\s*html\s*,\s*:host\s*\{/m, "preflight's html rule");
  assert.doesNotMatch(css, /^\s*h1,\s*\n?\s*h2/m, "preflight's heading reset");
  assert.doesNotMatch(css, /^\s*img,\s*\n?\s*svg,\s*\n?\s*video/m, "preflight's media reset");

  // Outside .hs-topbar and Hearthside's own hs- classes, Tailwind may only
  // set its own --tw-* defaults (which its utilities read), never a property
  // a page would see.
  const leaks: string[] = [];
  const scoped: string[] = [];
  out.root.walkRules((rule) => {
    const sel = rule.selector;
    if (sel.includes(".hs-topbar")) { scoped.push(sel); return; }
    // A keyframe step (Tailwind's animate-* utilities') styles nothing by itself.
    if (rule.parent?.type === "atrule" && /keyframes$/.test((rule.parent as { name: string }).name)) return;
    if (/(^|[\s,>+~(])\.hs-/.test(sel) || /^(html|body|:root)\b/.test(sel.trim())) return;
    rule.walkDecls((d) => { if (!d.prop.startsWith("--tw-")) leaks.push(`${sel} { ${d.prop} }`); });
  });
  assert.deepEqual(leaks, [], "Tailwind styles nothing outside the top bar");
  assert.ok(scoped.some((s) => /\.hs-topbar\s+\.border-b-4/.test(s)), "the bar's border-b-4 is compiled, scoped");
  assert.ok(scoped.some((s) => /\.hs-topbar\s+\.sticky/.test(s)), "the bar's sticky is compiled, scoped");
});

test("the design system's stylesheets are the global CSS, and the layout puts hs-app on the body", () => {
  const layout = fs.readFileSync(path.join(APP, "src", "app", "layout.tsx"), "utf8");
  const imports = [...layout.matchAll(/^import\s+["']([^"']+\.css)["'];/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["@/design-system/tokens.css", "@/design-system/components.css", "./globals.css"],
    "tokens, then the components, then the app's own CSS");
  assert.match(layout, /<body[^>]*className=\{[^}]*hs-app/);
  const tokens = fs.readFileSync(path.join(APP, "src", "design-system", "tokens.css"), "utf8");
  assert.match(tokens, /--ground:\s*#1a130e/);
});
