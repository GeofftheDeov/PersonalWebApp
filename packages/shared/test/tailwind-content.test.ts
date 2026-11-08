/**
 * Tailwind classes used inside @gtd/shared must survive each app's production
 * build (#209). Tailwind only generates the classes it finds in the files its
 * `content` globs match, so every app that imports this package must scan
 * all of the package's source. This resolves each app's globs the way
 * Tailwind 3 does (relative to the config file when `content.relative` is
 * set, otherwise to the app's folder, where its build runs) and checks they
 * cover every source file here.
 *
 * Hearthside (#216) keeps its styles out of Tailwind except for the shared top
 * bar, so it joins APPS once it scans this package.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";

const SHARED_SRC = path.resolve(__dirname, "../src");
const APPS = ["frontend", "hearthside"];

type Content = string[] | { relative?: boolean; files: (string | { raw: string })[] };

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(js|ts|jsx|tsx)$/.test(e.name) ? [full] : [];
  });
}

for (const app of APPS) {
  test(`${app}'s Tailwind scans every source file of @gtd/shared`, () => {
    const appDir = path.resolve(__dirname, "../../..", app);
    const configPath = path.join(appDir, "tailwind.config.js");
    const content: Content = require(configPath).content;
    const files = Array.isArray(content) ? content : content.files;
    // Tailwind's own build runs from the app's folder, so cwd-relative and
    // config-relative globs both start there.
    const globs = files.filter((f): f is string => typeof f === "string")
      .map((g) => path.posix.join(appDir.split(path.sep).join("/"), g));
    const scanned = new Set(fg.sync(globs, { absolute: true }).map((f) => path.normalize(f)));

    const shared = sourceFiles(SHARED_SRC);
    assert.ok(shared.length > 0, "the package has source files");
    const missed = shared.filter((f) => !scanned.has(path.normalize(f)));
    assert.deepEqual(missed, [], `not scanned by ${app}'s Tailwind`);
  });
}
