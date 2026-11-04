/**
 * The session cookie is the only thing that says somebody is signed in
 * (#210, spec #69). This scans each app's source for the old ways around it:
 *
 *   - reading or writing the token or the user in localStorage (or clearing
 *     it all, which was how logout dropped them);
 *   - building an `Authorization: Bearer` header in the browser. The cookie
 *     carries the auth; bearer tokens are for scripts and the desktop and
 *     mobile apps (the shared API client's `getToken`).
 *
 * Who's signed in comes from the session client (`@gtd/shared/session`).
 * Hearthside (#216) joins APPS when it has source.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const APPS = ["frontend"];

const RULES: { name: string; pattern: RegExp }[] = [
  {
    name: "the token or the user in localStorage",
    pattern: /localStorage\s*(?:\.\s*(?:getItem|setItem|removeItem)\s*\(\s*['"`](?:token|user)['"`]|\[\s*['"`](?:token|user)['"`]\s*\]|\.\s*(?:token|user)\b)/,
  },
  { name: "localStorage.clear() (logout clears the cookie through the session client)", pattern: /localStorage\s*\.\s*clear\s*\(/ },
  { name: "a bearer header built in the browser", pattern: /Bearer\s*\$\{|['"`]Bearer ['"`]\s*\+/ },
];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name.startsWith(".") ? [] : sourceFiles(full);
    return /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(e.name) ? [full] : [];
  });
}

/** Every rule a piece of source breaks, as "file:line  rule". */
function findings(file: string, source: string): string[] {
  const out: string[] = [];
  source.split(/\r?\n/).forEach((line, i) => {
    for (const rule of RULES) if (rule.pattern.test(line)) out.push(`${file}:${i + 1}  ${rule.name}`);
  });
  return out;
}

test("the scan catches each of the old patterns", () => {
  const samples = [
    "const t = localStorage.getItem('token');",
    'localStorage.setItem("user", JSON.stringify(u));',
    "localStorage.removeItem(`token`);",
    "const u = localStorage['user'];",
    "localStorage.token",
    "localStorage.clear();",
    "headers: { Authorization: `Bearer ${t}` }",
    "'Authorization': 'Bearer ' + TOKEN",
  ];
  for (const s of samples) assert.equal(findings("sample", s).length, 1, s);
  for (const fine of ["localStorage.getItem('theme')", "sessionStorage.getItem('prevRouteIndex')", "// the cookie carries the auth"]) {
    assert.deepEqual(findings("sample", fine), [], fine);
  }
});

for (const app of APPS) {
  test(`${app} keeps no session in localStorage and sends no bearer token`, () => {
    const appDir = path.resolve(__dirname, "../../..", app);
    const src = path.join(appDir, "src");
    const files = sourceFiles(src);
    assert.ok(files.length > 0, `${app} has source files`);
    const found = files.flatMap((f) => findings(path.relative(appDir, f), fs.readFileSync(f, "utf8")));
    assert.deepEqual(found, [], `use the session client (@gtd/shared/session) instead`);
  });
}
