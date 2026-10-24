/**
 * Wikilinks in rendered vault markdown (morning briefs, the vault browser).
 *
 * Briefs cite notes as [[projects/personal-web-app/index]]; these used to
 * render as literal brackets. Builds a throwaway vault in the OS temp dir and
 * checks that each wikilink form resolves to its note in /admin/obsidian, that
 * missing notes and private/ stay unlinked, and that code is left alone.
 *
 *   npx tsx scripts/test-wikilinks.ts
 */
import fs from "fs";
import os from "os";
import path from "path";
import { renderMarkdown } from "../utils/markdown.js";
import { vaultWikiLinkHref, wikiLinkResolver } from "../utils/vaultLinks.js";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { console.log(`  PASS  ${name}`); pass++; }
  else { console.log(`  FAIL  ${name}\n          ${JSON.stringify(detail)}`); fail++; }
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "wikilinks-"));
for (const rel of ["projects/personal-web-app/index.md", "projects/salesforce/index.md",
                   "people/Tommy Lee.md", "archive/people/Tommy Lee.md", "private/secret.md"]) {
  fs.mkdirSync(path.join(vault, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(vault, rel), "# note\n");
}

try {
  const resolve = wikiLinkResolver(vault);
  check("full path resolves", resolve("projects/salesforce/index") === "projects/salesforce/index.md");
  check("bare name resolves to the shortest path", resolve("Tommy Lee") === "people/Tommy Lee.md", resolve("Tommy Lee"));
  check("case-insensitive, .md and #heading tolerated", resolve("Projects/Salesforce/INDEX.md#Status") === "projects/salesforce/index.md");
  check("private/ is not linkable", resolve("private/secret") === null);
  check("missing note is null", resolve("projects/nope/index") === null);

  const html = renderMarkdown(
    "- Build it ([[projects/personal-web-app/index]])\n" +
    "- [[projects/salesforce/index|Salesforce]] and [[ghost note]]\n" +
    "- `[[projects/salesforce/index]]` stays code\n",
    { wikiLinkHref: vaultWikiLinkHref(vault, "t&k") });
  check("link points at the vault browser with the token",
    html.includes('<a class="wikilink" href="/admin/obsidian?path=projects%2Fpersonal-web-app%2Findex.md&amp;token=t%26k">projects/personal-web-app/index</a>'), html);
  check("alias becomes the label", html.includes('>Salesforce</a>'), html);
  check("missing note renders unlinked", html.includes('<span class="wikilink wikilink-missing" title="Not in the vault">ghost note</span>'), html);
  check("wikilink inside code is literal", html.includes("<code>[[projects/salesforce/index]]</code>"), html);
  check("no raw brackets left outside code", !html.replace(/<code>[\s\S]*?<\/code>/g, "").includes("[["), html);

  check("without wikiLinkHref, output is unchanged", renderMarkdown("[[a]]").includes("[[a]]"));
} finally {
  fs.rmSync(vault, { recursive: true, force: true });
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
