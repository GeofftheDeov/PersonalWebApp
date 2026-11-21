/**
 * MessageBody (#265) draws a message's Markdown as rich text, and stays safe
 * doing it: no raw HTML, no script URLs, no remote images, links that open
 * without a hold on the page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import MessageBody from "../src/letters/MessageBody";

const html = (body: string) => renderToStaticMarkup(createElement(MessageBody, { body, className: "b" }));

test("bold, italics, code, lists and quotes come out as their elements", () => {
  const out = html("**hello** _there_ `code`\n\n- one\n- two\n\n> quoted");
  assert.match(out, /<strong>hello<\/strong>/);
  assert.match(out, /<em>there<\/em>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/);
  assert.match(out, /<blockquote>\s*<p>quoted<\/p>\s*<\/blockquote>/);
});

test("a single newline stays a line break", () => {
  assert.match(html("first\nsecond"), /first<br\/>\s*second/);
});

test("raw HTML shows as text, not markup", () => {
  const out = html('<img src=x onerror="alert(1)"> <b>bold</b>');
  assert.doesNotMatch(out, /<img|<b>/);
  assert.match(out, /&lt;b&gt;bold&lt;\/b&gt;/);
});

test("links open in a new tab without the opener, and script URLs are dropped", () => {
  const out = html("[site](https://example.com) and [bad](javascript:alert(1)) and https://bare.example");
  assert.match(out, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">site<\/a>/);
  assert.match(out, /<a href="https:\/\/bare.example" target="_blank" rel="noopener noreferrer">/);
  assert.doesNotMatch(out, /javascript:/);
});

test("an image is a link to it, never loaded", () => {
  const out = html("![a map](https://example.com/map.png)");
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /<a href="https:\/\/example.com\/map.png" target="_blank" rel="noopener noreferrer">a map<\/a>/);
});

test("a heading is a bold line, not a heading", () => {
  const out = html("# Big news");
  assert.doesNotMatch(out, /<h1/);
  assert.match(out, /<p><strong>Big news<\/strong><\/p>/);
});
