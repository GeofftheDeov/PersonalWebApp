/**
 * Letters on Hearthside uses no messaging logic of its own (#221, spec #69):
 * the thread list, the open thread, sending, reading, typing and the live
 * channel all come from the shared hooks (@gtd/shared/letters/react and
 * @gtd/shared/realtime/react, through src/lib/letters.ts), the same ones the
 * portfolio uses. The panel's files only draw markup on top of them.
 *
 *   cd hearthside && npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(__dirname, "..");
const PANEL = path.join(APP, "src", "components", "letters");
const WIRING = path.join(APP, "src", "lib", "letters.ts");

const panelFiles = () =>
  fs.readdirSync(PANEL).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => path.join(PANEL, f));

/** A file's lines of code, comments left out (they may name an endpoint to explain where something goes). */
const code = (file: string) =>
  fs.readFileSync(file, "utf8").split(/\r?\n/)
    .map((text, i) => ({ text, where: `${path.relative(APP, file)}:${i + 1}` }))
    .filter(({ text }) => !/^\s*(\/\/|\/\*|\*)/.test(text));

test("the Letters panel exists", () => {
  assert.ok(panelFiles().length > 0, "src/components/letters/ has the panel");
});

test("the panel calls no API, socket or fetch of its own", () => {
  const banned = [
    /['"`]\/api\//, // an endpoint
    /\bfetch\s*\(/,
    /\bWebSocket\b/,
    /\bliveClient\s*\(/,
    /\.subscribe(Person)?\s*\(/,
    /\bapi\.(get|post|put|patch|delete|request)\s*\(/,
    /\bLiveClient\b/,
    /\bTypingTracker\b/,
  ];
  const found = panelFiles().flatMap(code).filter((l) => banned.some((re) => re.test(l.text))).map((l) => `${l.where}: ${l.text.trim()}`);
  assert.deepEqual(found, []);
});

test("messaging comes only from the shared hooks, through the app's Letters", () => {
  const imports = panelFiles().flatMap(code)
    .map((l) => ({ ...l, from: /from\s+['"]([^'"]+)['"]/.exec(l.text)?.[1] }))
    .filter((l): l is typeof l & { from: string } => !!l.from);
  const messaging = imports.filter((l) => /letters|realtime|\/api\b|session/.test(l.from) && !l.from.startsWith("./"));
  const allowed = new Set(["@/lib/letters", "@/lib/session", "@/lib/lettersFormat", "@gtd/shared/letters"]);
  assert.deepEqual(messaging.filter((l) => !allowed.has(l.from)).map((l) => `${l.where}: ${l.from}`), []);
  // `@gtd/shared/letters` is only for its attachment limits and labels, never a hook or the wiring.
  for (const l of messaging.filter((m) => m.from === "@gtd/shared/letters")) {
    assert.doesNotMatch(l.text, /createLetters|uploadAttachment/, l.where);
  }
});

test("the app's Letters wiring hands out the shared hooks and nothing hand-rolled", () => {
  const source = code(WIRING).map((l) => l.text).join("\n");
  assert.match(source, /from '@gtd\/shared\/letters\/react'/);
  assert.match(source, /from '@gtd\/shared\/realtime\/react'/);
  assert.doesNotMatch(source, /\bfetch\s*\(|['"`]\/api\/|\bapi\.(get|post)\s*\(/);
});
