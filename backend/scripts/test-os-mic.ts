/**
 * The overview's mic (#149 of spec #135, W3). No database, no browser.
 *
 * The spec leaves Web Speech capture to a hand check in desktop Chrome and on a
 * phone (no prior art for browser tests). This script covers what can be
 * checked without one, against the code the page actually ships:
 *
 *   - "controller": the recognition state machine, MIC_CONTROLLER_JS from
 *     os/mic.ts, evaluated in a vm and driven with a fake SpeechRecognition
 *     and fake timers.
 *   - "page": the HTML renderOverviewPage renders (mic button in
 *     #ask-controls, the note, the messages, no CDN scripts).
 *   - "page scripts": every inline script of that page run in a vm against a
 *     tiny fake DOM, a fake recognition and a fake fetch, so a spoken ask is
 *     followed through to the POST body ({ text, source: 'voice' }).
 *
 *   npx tsx scripts/test-os-mic.ts
 *
 * Extending it: #150 (stop button) and #151 (voice yes/no) add cases to the
 * "page scripts" section; `bootPage({ recognition, reply })` returns the fake
 * DOM, the recognitions created, the fetch calls and window.OS.
 */
import vm from "vm";
import { MIC_CONTROLLER_JS, MIC_MESSAGES } from "../os/mic.js";
import { renderOverviewPage } from "../os/page.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !d ? "" : `\n          ${d}`}`);
    cond ? pass++ : fail++;
}
const flush = () => new Promise((r) => setImmediate(r));

// ── fakes ────────────────────────────────────────────────────────────────────

/** A SpeechRecognition stand-in: records its settings and lets a test fire its events. */
function fakeRecognitionClass(opts: { throwOnStart?: boolean } = {}) {
    const instances: FakeRec[] = [];
    class FakeRec {
        lang = ""; continuous = true; interimResults = false; maxAlternatives = 0;
        started = false; stopped = false; aborted = false;
        onresult: ((e: any) => void) | null = null;
        onerror: ((e: any) => void) | null = null;
        onend: (() => void) | null = null;
        constructor() { instances.push(this); }
        start() { if (opts.throwOnStart) throw new Error("InvalidStateError"); this.started = true; }
        stop() { this.stopped = true; }
        abort() { this.aborted = true; }
        /** Fires onresult with the session's results so far: [text, isFinal] pairs. */
        results(...rs: [string, boolean][]) {
            const list: any = rs.map(([t, isFinal]) => Object.assign([{ transcript: t, confidence: 0.9 }], { isFinal }));
            this.onresult?.({ resultIndex: 0, results: list });
        }
        error(code: string) { this.onerror?.({ error: code }); }
        end() { this.onend?.(); }
    }
    return { FakeRec, instances };
}

function fakeTimers() {
    let seq = 0;
    const pending = new Map<number, { fn: () => void; at: number }>();
    let clock = 0;
    return {
        setTimeout: (fn: () => void, ms: number) => { const id = ++seq; pending.set(id, { fn, at: clock + ms }); return id; },
        clearTimeout: (id: number) => { pending.delete(id); },
        advance(ms: number) {
            clock += ms;
            for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
                if (t.at <= clock && pending.has(id)) { pending.delete(id); t.fn(); }
            }
        },
        get count() { return pending.size; },
    };
}

/** createMic from the shipped source, and a controller wired to fakes. */
const createMic = vm.runInNewContext(`(${MIC_CONTROLLER_JS})`, { console, Promise });

function controller(over: Record<string, unknown> = {}) {
    const { FakeRec, instances } = fakeRecognitionClass(over.throwOnStart ? { throwOnStart: true } : {});
    const timers = fakeTimers();
    const asked: string[] = [];
    const sent: [string, unknown][] = [];
    const snaps: any[] = [];
    let answer: (v: unknown) => void = () => {};
    const mic = createMic({
        Recognition: "Recognition" in over ? over.Recognition : FakeRec,
        lang: "en-GB",
        messages: MIC_MESSAGES,
        ask: (text: string) => { asked.push(text); return new Promise((r) => { answer = r; }); },
        onSent: (text: string, result: unknown) => sent.push([text, result]),
        onChange: (s: any) => snaps.push(s),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        maxMs: 15000,
        graceMs: 3000,
        ...over,
    });
    return { mic, instances, timers, asked, sent, snaps, answer: (v: unknown) => answer(v) };
}

// ── a tiny DOM for the page's scripts ────────────────────────────────────────

class El {
    hidden = false; textContent = ""; value = ""; placeholder = ""; disabled = false; type = "";
    attrs: Record<string, string> = {};
    listeners: Record<string, ((e: any) => void)[]> = {};
    children: Record<string, El> = {};
    constructor(public id: string) {}
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k: string) { delete this.attrs[k]; }
    querySelector(sel: string) { return (this.children[sel] ??= new El(sel)); }
    fire(type: string) {
        let prevented = false;
        for (const fn of this.listeners[type] ?? []) fn({ type, preventDefault() { prevented = true; } });
        return prevented;
    }
}

/** The ids the page's scripts look up, with the attributes the server rendered (only `hidden` matters). */
function domFor(html: string) {
    const els: Record<string, El> = {};
    for (const m of html.matchAll(/<(\w+)([^>]*)\sid="([^"]+)"([^>]*)>/g)) {
        const el = new El(m[3]);
        const attrs = m[2] + " " + m[4];
        el.hidden = /\shidden(\s|=|$)/.test(attrs);
        const ph = /placeholder="([^"]*)"/.exec(attrs);
        if (ph) el.placeholder = ph[1];
        els[m[3]] = el;
    }
    return els;
}

const SAMPLE_REPLY = { tier: 1, kind: "answer", say: "Up 412 dollars.", display: "+$412" };

function renderPage() {
    return renderOverviewPage({
        token: "tok<en>", now: new Date("2026-10-18T15:00:00Z"),
        overview: { generatedAt: "2026-10-18T15:00:00Z", tiles: {} }, sources: [],
    });
}

/** Runs the page's inline scripts against fakes. `recognition: false` is a browser without speech recognition. */
function bootPage({ recognition = true, prefixed = true, reply = SAMPLE_REPLY as unknown } = {}) {
    const html = renderPage();
    const els = domFor(html);
    const { FakeRec, instances } = fakeRecognitionClass();
    const fetches: { url: string; body: any }[] = [];
    const docListeners: Record<string, (() => void)[]> = {};
    const intervals: (() => void)[] = [];
    const win: any = {
        console, Promise, Array, JSON, Date, encodeURIComponent,
        setTimeout: (fn: () => void) => 0, clearTimeout: () => {},
        setInterval: (fn: () => void) => { intervals.push(fn); return 0; },
        navigator: { language: "en-GB" },
        location: { href: "/admin/os?token=x", reload() { win.reloaded = (win.reloaded ?? 0) + 1; } },
        document: {
            visibilityState: "visible",
            getElementById: (id: string) => els[id] ?? null,
            addEventListener: (t: string, fn: () => void) => { (docListeners[t] ??= []).push(fn); },
        },
        fetch: (url: string, init: any) => {
            fetches.push({ url, body: JSON.parse(init.body) });
            return Promise.resolve({
                type: "basic", status: 200, ok: true,
                headers: { get: () => "application/json; charset=utf-8" },
                json: () => Promise.resolve(reply),
            });
        },
    };
    win.window = win;
    if (recognition) win[prefixed ? "webkitSpeechRecognition" : "SpeechRecognition"] = FakeRec;
    const ctx = vm.createContext(win);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const s of scripts) vm.runInContext(s, ctx);
    return { html, els, instances, fetches, win, OS: win.OS, intervals };
}

async function main() {
    // ── controller ──────────────────────────────────────────────────────────
    {
        const c = controller({ Recognition: null });
        check("without speech recognition the mic is unsupported, with the note as its message",
            c.mic.state() === "unsupported" && c.mic.snapshot().message === MIC_MESSAGES.unsupported, c.mic.snapshot());
        check("... and pressing it does nothing", c.mic.start() === false && c.instances.length === 0 && !c.mic.busy());
    }
    {
        const c = controller();
        check("supported: the mic starts idle with no message", c.mic.state() === "idle" && c.mic.snapshot().message === "");
        check("a press starts listening", c.mic.start() === true && c.mic.state() === "listening" && c.mic.busy());
        const r = c.instances[0];
        check("... one recognition, started, for one utterance with interim results in the page's language",
            c.instances.length === 1 && r.started && r.continuous === false && r.interimResults === true
                && r.maxAlternatives === 1 && r.lang === "en-GB", r);
        check("a second start while listening is refused (one utterance per press)",
            c.mic.start() === false && c.instances.length === 1);
        r.results(["what's", false]);
        r.results(["what's my", false]);
        check("interim results are reported as they arrive, nothing asked yet",
            c.snaps.at(-1)?.state === "listening" && c.snaps.at(-1)?.text === "what's my" && c.asked.length === 0, c.snaps.at(-1));
        r.results(["what's my P&L", true]);
        check("a final result alone doesn't submit; the end of the utterance does", c.asked.length === 0);
        r.end();
        check("at the end the transcript is asked, once", c.asked.length === 1 && c.asked[0] === "what's my P&L", c.asked);
        check("... and the mic stays busy while the ask is in flight",
            c.mic.state() === "submitting" && c.mic.busy());
        check("... and can't start again until it's answered", c.mic.start() === false && c.instances.length === 1);
        c.answer({ say: "ok" });
        await flush();
        check("once answered, the mic is idle and not busy", c.mic.state() === "idle" && !c.mic.busy());
        check("... and onSent got the text and the reply", c.sent.length === 1 && c.sent[0][0] === "what's my P&L"
            && (c.sent[0][1] as any)?.say === "ok", c.sent);
        r.results(["late", true]); r.end();
        check("late events from a finished recognition are ignored", c.asked.length === 1 && c.mic.state() === "idle");
        check("the next press makes a fresh recognition", c.mic.start() && c.instances.length === 2);
    }
    {
        const c = controller();
        c.mic.start();
        const r = c.instances[0];
        r.results(["open the", false]);
        check("pressing again while listening stops the recognition (submit what's heard)",
            c.mic.stop() === true && r.stopped && c.mic.state() === "listening");
        r.results(["open the briefs", true]); r.end();
        check("... and the final transcript is asked", c.asked[0] === "open the briefs", c.asked);
    }
    {
        const c = controller();
        c.mic.toggle();
        const r = c.instances[0];
        r.results(["  run my   morning brief ", false]);
        c.mic.toggle();
        check("toggle starts and then stops", r.started && r.stopped);
        r.end();
        check("stopped with only an interim result, that interim text is asked, whitespace tidied",
            c.asked[0] === "run my morning brief", c.asked);
    }
    for (const code of ["not-allowed", "service-not-allowed"]) {
        const c = controller();
        c.mic.start();
        c.instances[0].error(code); c.instances[0].end();
        check(`a "${code}" error shows the permission message and asks nothing`,
            c.mic.state() === "denied" && c.mic.snapshot().message === MIC_MESSAGES.denied && c.asked.length === 0 && !c.mic.busy(),
            c.mic.snapshot());
        check(`... and the mic can be pressed again after fixing it (${code})`, c.mic.start() === true && c.instances.length === 2);
    }
    for (const [code, msg] of [["no-speech", MIC_MESSAGES.noSpeech], ["audio-capture", MIC_MESSAGES.noMic],
        ["network", MIC_MESSAGES.network], ["language-not-supported", MIC_MESSAGES.failed]] as const) {
        const c = controller();
        c.mic.start();
        c.instances[0].results(["half a sent", false]);
        c.instances[0].error(code); c.instances[0].end();
        check(`a "${code}" error says so, asks nothing and leaves the mic idle`,
            c.mic.state() === "idle" && c.mic.snapshot().message === msg && c.asked.length === 0 && !c.mic.busy(), c.mic.snapshot());
    }
    {
        const c = controller();
        c.mic.start(); c.instances[0].end();
        check("an utterance that ends with nothing heard says so and asks nothing",
            c.mic.state() === "idle" && c.mic.snapshot().message === MIC_MESSAGES.noSpeech && c.asked.length === 0);
    }
    {
        const c = controller();
        c.mic.start();
        const r = c.instances[0];
        r.results(["never mind", false]);
        check("abort cancels at once: idle, aborted, nothing asked", c.mic.abort() === true && r.aborted
            && c.mic.state() === "idle" && c.mic.snapshot().message === "" && !c.mic.busy());
        r.results(["never mind", true]); r.error("aborted"); r.end();
        check("... and the aborted recognition's late events change nothing", c.asked.length === 0 && c.mic.state() === "idle");
        check("abort with nothing listening returns false", c.mic.abort() === false);
    }
    {
        const c = controller();
        const seen: string[] = [];
        c.mic.onTranscript((t: string) => { seen.push(t); return t === "yes"; });
        c.mic.start(); c.instances[0].results(["yes", true]); c.instances[0].end();
        await flush();
        check("a transcript hook that returns true takes the utterance: no ask", seen[0] === "yes" && c.asked.length === 0
            && c.mic.state() === "idle", { seen, asked: c.asked });
        check("... and onSent still reports it as handled", c.sent.length === 1 && c.sent[0][0] === "yes" && c.sent[0][1] === true, c.sent);
        c.mic.start(); c.instances[1].results(["what's due", true]); c.instances[1].end();
        check("a hook that returns false lets it through to ask", seen[1] === "what's due" && c.asked[0] === "what's due");
    }
    {
        const c = controller();
        let resolveHook: (v: unknown) => void = () => {};
        c.mic.onTranscript(() => new Promise((r) => { resolveHook = r; }));
        c.mic.start(); c.instances[0].results(["no", true]); c.instances[0].end();
        check("a hook returning a promise holds the mic busy until it settles",
            c.mic.state() === "submitting" && c.mic.busy() && c.asked.length === 0);
        resolveHook({ confirmed: true }); await flush();
        check("... then it's idle", c.mic.state() === "idle" && !c.mic.busy());
    }
    {
        const c = controller();
        c.mic.onTranscript(() => { throw new Error("hook bug"); });
        const errors: unknown[] = [];
        const realError = console.error; console.error = (e: unknown) => errors.push(e);
        c.mic.start(); c.instances[0].results(["open alpaca", true]); c.instances[0].end();
        console.error = realError;
        check("a throwing hook is logged and the transcript is still asked", errors.length === 1 && c.asked[0] === "open alpaca");
    }
    {
        const c = controller();
        c.mic.start();
        const r = c.instances[0];
        r.results(["keep talking", false]);
        c.timers.advance(14999);
        check("listening is capped: still listening just before the cap", !r.stopped && c.mic.state() === "listening");
        c.timers.advance(1);
        check("... stopped at the cap", r.stopped);
        c.timers.advance(3000);
        check("... and if the browser never ends it, it's finished after the grace period with what was heard",
            c.asked[0] === "keep talking" && c.mic.state() === "submitting", { asked: c.asked, state: c.mic.state() });
        r.end();
        check("... and the browser's late end doesn't ask twice", c.asked.length === 1);
    }
    {
        const c = controller();
        c.mic.start(); c.instances[0].results(["hi", true]); c.instances[0].end();
        check("no timer outlives the utterance", c.timers.count === 0, c.timers.count);
    }
    {
        const c = controller({ throwOnStart: true });
        const errors: unknown[] = [];
        const realError = console.error; console.error = (e: unknown) => errors.push(e);
        const started = c.mic.start();
        const retried = c.mic.start();
        console.error = realError;
        check("a recognition that fails to start reports it, logs the error and isn't busy",
            started === false && c.mic.state() === "idle" && c.mic.snapshot().message === MIC_MESSAGES.failed
                && !c.mic.busy() && errors.length >= 1);
        check("... and the next press tries again with a fresh recognition", retried === false && c.instances.length === 2);
    }
    {
        const c = controller();
        const states: string[] = [];
        c.mic.onState((s: any) => states.push(s.state));
        c.mic.start(); c.instances[0].results(["hi", true]); c.instances[0].end();
        c.answer(null); await flush();
        check("onState hooks see listening, submitting, idle", states.join(",") === "listening,listening,submitting,idle", states);
        const failed = c.sent.at(-1);
        check("an ask that resolves null (failed or refused) still goes back to idle, reported to onSent",
            c.mic.state() === "idle" && failed?.[0] === "hi" && failed?.[1] === null, c.sent);
    }

    // ── page ────────────────────────────────────────────────────────────────
    {
        const html = renderPage();
        const controls = /<span id="ask-controls"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? "";
        check("the mic button sits in #ask-controls, hidden until the page knows speech works",
            /<button[^>]*id="ask-mic"[^>]*>/.test(controls) && /id="ask-mic"[^>]*\shidden/.test(controls)
                && /id="ask-mic"[^>]*type="button"/.test(controls) && /id="ask-mic"[^>]*aria-label="[^"]+"/.test(controls), controls);
        check("the page has a mic note for status and errors, read out politely",
            /<div[^>]*id="ask-mic-note"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/.test(html));
        check("the unsupported-browser note and the permission message are in the page",
            html.includes(JSON.stringify(MIC_MESSAGES.unsupported)) && html.includes(JSON.stringify(MIC_MESSAGES.denied)));
        check("the permission message says how to fix it", /allow/i.test(MIC_MESSAGES.denied) && /microphone/i.test(MIC_MESSAGES.denied)
            && /settings|address bar/i.test(MIC_MESSAGES.denied), MIC_MESSAGES.denied);
        check("the page reads SpeechRecognition or webkitSpeechRecognition and asks with source 'voice', no CDN scripts",
            /webkitSpeechRecognition/.test(html) && /SpeechRecognition/.test(html) && /OS\.ask\([^)]*'voice'\)/.test(html)
                && !/<script[^>]+src=/.test(html));
    }

    // ── page scripts ────────────────────────────────────────────────────────
    {
        const p = bootPage();
        const mic = p.els["ask-mic"], note = p.els["ask-mic-note"], input = p.els["ask-text"];
        check("with webkitSpeechRecognition the mic is shown and the note hidden", !mic.hidden && note.hidden);
        check("window.OS gains the mic surface", ["listen", "stopListening", "cancelListening", "micState", "onMicState", "onTranscript"]
            .every((k) => typeof p.OS[k] === "function"), Object.keys(p.OS));
        check("OS.micState() is idle and OS.busy() false before a press", p.OS.micState() === "idle" && p.OS.busy() === false);
        mic.fire("click");
        const r = p.instances[0];
        check("pressing the mic starts recognition and marks it pressed", r?.started && mic.getAttribute("aria-pressed") === "true"
            && p.OS.micState() === "listening");
        check("while listening OS.busy() is true, so the page won't reload", p.OS.busy() === true);
        let reloads = 0;
        p.win.location.reload = () => { reloads++; };
        const realNow = Date.now; Date.now = () => realNow() + 10 * 60_000;
        p.intervals.forEach((fn) => fn());
        Date.now = realNow;
        check("... and the reload timer, though due, holds off", reloads === 0, reloads);
        r.results(["show the", false]);
        check("the interim transcript shows in the text box", input.value === "show the", input.value);
        check("... and the note says it's listening", !note.hidden && note.textContent === MIC_MESSAGES.listening, note.textContent);
        r.results(["show the briefs", true]); r.end();
        await flush(); await flush();
        check("at the end of the utterance the page posts it to /admin/os/ask with source 'voice'",
            p.fetches.length === 1 && p.fetches[0].url.startsWith("/admin/os/ask?token=")
                && p.fetches[0].body.text === "show the briefs" && p.fetches[0].body.source === "voice", p.fetches);
        await flush(); await flush();
        check("the reply is shown and the text box cleared", p.els["ask-reply"].querySelector(".ask-say").textContent === SAMPLE_REPLY.say
            && input.value === "", { say: p.els["ask-reply"].querySelector(".ask-say").textContent, input: input.value });
        check("afterwards the mic is idle, unpressed and the page not busy",
            p.OS.micState() === "idle" && mic.getAttribute("aria-pressed") === "false" && p.OS.busy() === false && note.hidden);
    }
    {
        const p = bootPage({ prefixed: false });
        check("the unprefixed SpeechRecognition works too", !p.els["ask-mic"].hidden && p.OS.listen() === true && p.instances.length === 1);
        p.instances[0].results(["what's", false]);
        p.els["ask-form"].fire("submit");
        check("submitting the form while listening cancels the mic, and the shown text goes as typed",
            p.instances[0].aborted && p.OS.micState() === "idle" && p.fetches[0]?.body.source === "typed"
                && p.fetches[0]?.body.text === "what's", p.fetches);
    }
    {
        const p = bootPage();
        const heard: string[] = [];
        p.OS.onTranscript((t: string) => { heard.push(t); return true; });
        p.OS.listen();
        p.instances[0].results(["yes", true]); p.instances[0].end();
        await flush(); await flush();
        check("OS.onTranscript can take an utterance (#151's yes/no): it isn't posted", heard[0] === "yes" && p.fetches.length === 0);
        check("... and the text box is cleared", p.els["ask-text"].value === "", p.els["ask-text"].value);
    }
    {
        const p = bootPage();
        p.els["ask-text"].value = "half-typed";
        p.els["ask-mic"].fire("click");
        p.instances[0].end();
        check("a press that hears nothing leaves typed text alone", p.els["ask-text"].value === "half-typed");
        const states: string[] = [];
        p.OS.onMicState((s: any) => states.push(s.state));
        p.OS.listen(); p.OS.cancelListening();
        check("OS.cancelListening() aborts, and onMicState hooks see it", p.instances[1].aborted && states.join(",") === "listening,idle", states);
    }
    {
        const p = bootPage();
        p.els["ask-mic"].fire("click");
        p.instances[0].error("not-allowed"); p.instances[0].end();
        const note = p.els["ask-mic-note"];
        check("denied permission shows the message in the note and posts nothing",
            !note.hidden && note.textContent === MIC_MESSAGES.denied && p.fetches.length === 0 && note.getAttribute("data-state") === "denied",
            { hidden: note.hidden, text: note.textContent });
        check("... the mic stays visible to try again", !p.els["ask-mic"].hidden && p.OS.busy() === false);
    }
    {
        const p = bootPage({ recognition: false });
        const mic = p.els["ask-mic"], note = p.els["ask-mic-note"];
        check("without speech recognition the mic stays hidden and the note says so",
            mic.hidden && !note.hidden && note.textContent === MIC_MESSAGES.unsupported, { hidden: mic.hidden, note: note.textContent });
        check("... OS.listen() refuses and the mic state is unsupported", p.OS.listen() === false && p.OS.micState() === "unsupported");
        p.els["ask-text"].value = "open alpaca";
        p.els["ask-form"].fire("submit");
        await flush();
        check("... and the text box still asks, as typed", p.fetches.length === 1 && p.fetches[0].body.source === "typed"
            && p.fetches[0].body.text === "open alpaca", p.fetches);
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
