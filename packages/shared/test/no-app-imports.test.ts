/**
 * @gtd/shared depends on no app (#211, spec #69). Both sites import it, so it
 * can't reach back into either one: everything an app supplies (its API
 * client, session client, Letters) comes in as an argument or a prop.
 *
 * This reads every import in the package's source and checks each one is
 * another file of the package, a package it declares, or a Node built-in,
 * and that the manifest names no app.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const APPS = ["frontend", "hearthside"];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(e.name) ? [full] : [];
  });
}

/** Every module specifier a file imports, re-exports or requires. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of source.matchAll(re)) out.push(m[1]);
  return out;
}

/** The package name a bare specifier names: `next/link` → `next`, `@scope/x/y` → `@scope/x`. */
const packageOf = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");

/** Why this import reaches outside the package, or null if it doesn't. */
function problem(file: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const target = path.resolve(path.dirname(file), spec);
    return target === SRC || target.startsWith(SRC + path.sep) ? null : "a relative path out of the package's source";
  }
  if (spec.startsWith("node:") || builtinModules.includes(spec)) return null;
  if (spec.startsWith("@/") || spec.startsWith("~/")) return "an app's path alias";
  const name = packageOf(spec);
  if (name === manifest.name) return null;
  return declared.has(name) ? null : `${name}, which package.json doesn't declare`;
}

test("the import check spots each way into an app", () => {
  const file = path.join(SRC, "topbar", "TopBar.tsx");
  assert.deepEqual(specifiers(`import { api } from '../../../frontend/src/lib/api';`), ["../../../frontend/src/lib/api"]);
  assert.match(problem(file, "../../../frontend/src/lib/api") ?? "", /out of the package/);
  assert.match(problem(file, "@/lib/session") ?? "", /alias/);
  assert.match(problem(file, "frontend") ?? "", /doesn't declare/);
  assert.equal(problem(file, "../letters/letters"), null);
  assert.equal(problem(file, "next/navigation"), null);
  assert.equal(problem(file, "node:fs"), null);
  assert.deepEqual(specifiers(`export { x } from "./x";\nexport * from './y';\nimport type { Z } from "z";`), ["./x", "./y", "z"]);
});

test("the package's source imports nothing from an app", () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 0, "the package has source files");
  const found = files.flatMap((f) => {
    const source = fs.readFileSync(f, "utf8");
    return specifiers(source)
      .map((spec) => [spec, problem(f, spec)] as const)
      .filter(([, why]) => why)
      .map(([spec, why]) => `${path.relative(ROOT, f)}: '${spec}' is ${why}`);
  });
  assert.deepEqual(found, []);
});

test("the package's manifest depends on no app", () => {
  const all = {
    ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies,
  };
  for (const app of APPS) assert.equal(all[app], undefined, `@gtd/shared must not depend on ${app}`);
});
