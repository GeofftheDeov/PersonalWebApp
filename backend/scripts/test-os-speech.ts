/**
 * The overview's speech playback (#150 of spec #135, W3). No database, no browser.
 *
 * Like scripts/test-os-mic.ts, this runs the code the page actually ships:
 *
 *   - "speaker": SPEAKER_JS from os/voice.ts, evaluated in a vm and driven with
 *     a fake speechSynthesis and fake timers.
 *   - "page": the HTML renderOverviewPage renders (the stop button beside the
 *     mic, the voice picker).
 *   - "page scripts": every inline script of that page run in a vm against a
 *     small fake DOM, a fake speechSynthesis (speak / cancel / getVoices /
 *     voiceschanged, utterances with onend and onerror), a fake recognition, a
 *     fake fetch and a localStorage that can throw. A "reload" is a second boot
 *     with the same storage.
 *   - #153's run watch (os/runWatch.ts) on the same boot: `get` answers the
 *     page's GETs, `session` is the tab's sessionStorage and `startAt` puts
 *     Date.now() on the fake timers' clock, so 45 minutes pass in t153Pass().
 *
 *   npx tsx scripts/test-os-speech.ts
 *
 * Real speech output, real voices and the phone layout are a hand check
 * (desktop Chrome and a phone; see #150).
 */
import vm from "vm";
import { renderOverviewPage } from "../os/page.js";
import { PROPOSAL_REPLY_JS as T151_PROPOSAL_REPLY_JS, proposalReply as t151ServerReply } from "../os/proposalReply.js";
import { normaliseAsk as t151Normalise } from "../os/ask.js";
import { SPEAKER_JS, SPEECH_CHUNK_CHARS, SPEECH_MIN_WAIT_MS, SPEECH_MS_PER_CHAR, VOICE_POLL_MS, VOICE_STORAGE_KEY } from "../os/voice.js";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail: unknown = "") {
    const d = typeof detail === "string" ? detail : JSON.stringify(detail);
    console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${cond || !d ? "" : `\n          ${d}`}`);
    cond ? pass++ : fail++;
}
const flush = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// ── fakes ────────────────────────────────────────────────────────────────────

class T150Utterance {
    voice: unknown = null; lang = "";
    onend: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(public text: string) {}
}

interface T150Voice { name: string; voiceURI: string; lang: string; default?: boolean }

const T150_VOICES: T150Voice[] = [
    { name: "Thomas", voiceURI: "com.apple.voice.Thomas", lang: "fr-FR" },
    { name: "Google UK English Female", voiceURI: "Google UK English Female", lang: "en-GB" },
    { name: "Samantha", voiceURI: "com.apple.voice.compact.en-US.Samantha", lang: "en-US", default: true },
];

/**
 * A speechSynthesis stand-in. `queue` is what's still to be spoken; end() ends
 * the utterance at its head. cancel() fires 'interrupted' on everything queued,
 * asynchronously like Chrome (or at once with syncCancelEvents).
 */
function t150Synth(opts: {
    voices?: T150Voice[]; listeners?: "add" | "prop"; syncCancelEvents?: boolean; cancelFiresEnd?: boolean; paused?: boolean;
    /** A stuck engine: never ends anything, and never reports speaking either. */
    silent?: boolean;
} = {}) {
    const listeners: (() => void)[] = [];
    const synth: any = {
        voices: opts.voices ?? [],
        spoken: [] as T150Utterance[], queue: [] as T150Utterance[],
        cancels: 0, resumes: 0, paused: !!opts.paused,
        get speaking() { return !opts.silent && this.queue.length > 0; },
        get pending() { return this.queue.length > 1; },
        speak(u: T150Utterance) { this.spoken.push(u); this.queue.push(u); },
        cancel() {
            this.cancels++;
            const dropped: T150Utterance[] = this.queue;
            this.queue = [];
            // WebKit and some Firefox builds fire end, not error, for a cancelled utterance.
            const fire = () => dropped.forEach((u) => (opts.cancelFiresEnd ? u.onend?.({}) : u.onerror?.({ error: "interrupted" })));
            if (opts.syncCancelEvents) fire(); else setImmediate(fire);
        },
        resume() { this.resumes++; this.paused = false; },
        getVoices() { return this.voices; },
        /** Ends the utterance being spoken. */
        end() { const u = this.queue.shift(); u?.onend?.({}); return u; },
        endAll() { while (this.queue.length) this.end(); },
        /** A failure on the utterance being spoken. */
        error(code: string) { const u = this.queue[0]; u?.onerror?.({ error: code }); },
        /** New voices arrive, and voiceschanged fires (unless quiet). */
        setVoices(v: T150Voice[], quiet = false) {
            this.voices = v;
            if (quiet) return;
            listeners.forEach((fn) => fn());
            this.onvoiceschanged?.({});
        },
        onvoiceschanged: null as ((e: unknown) => void) | null,
        get text() { return this.spoken.map((u: T150Utterance) => u.text).join(" "); },
    };
    if (opts.listeners !== "prop") synth.addEventListener = (t: string, fn: () => void) => { if (t === "voiceschanged") listeners.push(fn); };
    return synth;
}

function t150Timers() {
    let seq = 0, clock = 0;
    const pending = new Map<number, { fn: () => void; at: number }>();
    return {
        setTimeout: (fn: () => void, ms = 0) => { const id = ++seq; pending.set(id, { fn, at: clock + ms }); return id; },
        clearTimeout: (id: number) => { pending.delete(id); },
        advance(ms: number) {
            const end = clock + ms;
            for (;;) {
                const next = [...pending].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                pending.delete(next[0]);
                clock = Math.max(clock, next[1].at);
                next[1].fn();
            }
            clock = end;
        },
        get count() { return pending.size; },
        /** Milliseconds advanced so far (#153's fake clock reads it). */
        get now() { return clock; },
    };
}

/** localStorage: a working one over `map`, or one whose methods throw, or (getter) one that throws on access. */
function t150Storage(map: Map<string, string>, mode: "ok" | "methods-throw" = "ok") {
    const boom = () => { throw new Error("SecurityError: storage is disabled"); };
    if (mode === "methods-throw") return { getItem: boom, setItem: boom, removeItem: boom };
    return {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => { map.set(k, String(v)); },
        removeItem: (k: string) => { map.delete(k); },
    };
}

/** createSpeaker from the shipped source. */
const createSpeaker = vm.runInNewContext(`(${SPEAKER_JS})`, { console, Promise, setTimeout, clearTimeout });

function speakerWith(over: Record<string, unknown> = {}) {
    const synth = t150Synth(over.synthOpts as any);
    const timers = t150Timers();
    const changes: boolean[] = [];
    let voice: unknown = null;
    const speaker = createSpeaker({
        synth, Utterance: T150Utterance,
        voice: () => voice,
        onChange: (s: boolean) => changes.push(s),
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
        ...over,
    });
    return { speaker, synth, timers, changes, setVoice: (v: unknown) => { voice = v; } };
}

// ── a small DOM for the page's scripts ───────────────────────────────────────

class T150El {
    hidden = false; textContent = ""; placeholder = ""; disabled = false;
    attrs: Record<string, string> = {};
    listeners: Record<string, ((e: any) => void)[]> = {};
    children: Record<string, T150El> = {};
    kids: T150El[] = [];
    private val = "";
    constructor(public id: string, public tag = "div") {}
    get value() { return this.val; }
    set value(v: string) {
        // A <select> only takes the value of one of its options.
        this.val = this.tag === "select" ? (this.kids.some((o) => o.value === String(v)) ? String(v) : "") : String(v);
    }
    get firstChild() { return this.kids[0] ?? null; }
    appendChild(c: T150El) { this.kids.push(c); return c; }
    removeChild(c: T150El) { this.kids = this.kids.filter((k) => k !== c); return c; }
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
    setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
    getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
    removeAttribute(k: string) { delete this.attrs[k]; }
    querySelector(sel: string) { return (this.children[sel] ??= new T150El(sel)); }
    fire(type: string) {
        let prevented = false;
        for (const fn of this.listeners[type] ?? []) fn({ type, preventDefault() { prevented = true; } });
        return prevented;
    }
    /** Picks an option as the admin would, firing change. */
    choose(v: string) { this.value = v; this.fire("change"); }
}

function t150Dom(html: string) {
    const els: Record<string, T150El> = {};
    for (const m of html.matchAll(/<(\w+)([^>]*)\sid="([^"]+)"([^>]*)>/g)) {
        const el = new T150El(m[3], m[1]);
        el.hidden = /\shidden(\s|=|$)/.test(m[2] + " " + m[4]);
        els[m[3]] = el;
    }
    return els;
}

function t150Render() {
    return renderOverviewPage({
        token: "tok", now: new Date("2026-10-18T15:00:00Z"),
        overview: { generatedAt: "2026-10-18T15:00:00Z", tiles: {} }, sources: [],
    });
}

type T150Reply = { status?: number; body?: unknown; json?: boolean; network?: boolean; redirect?: boolean };

/**
 * Boots the page's inline scripts against fakes. `reply(n, body)` answers the
 * n-th POST (default: an answer); with `hold`, each response waits for release().
 */
function t150Boot(opts: {
    synth?: any | null; storage?: "ok" | "methods-throw" | "getter-throws" | "none"; store?: Map<string, string>;
    reply?: (n: number, body: any) => T150Reply | unknown; hold?: boolean; recognition?: boolean;
    /** #153: answers each GET (the run and Say polls); default a 404. */
    get?: (url: string, n: number) => T150Reply | unknown;
    /** #153: the tab's sessionStorage (a fresh one by default), one whose methods throw, or none. */
    session?: Map<string, string> | "methods-throw" | "none";
    /** #153: Date.now() is this plus the fake timers' clock, so deadlines move with timers.advance(). */
    startAt?: number;
} = {}) {
    const html = t150Render();
    const els = t150Dom(html);
    const timers = t150Timers();
    const synth = opts.synth === undefined ? t150Synth() : opts.synth;
    const store = opts.store ?? new Map<string, string>();
    const fetches: { url: string; body: any }[] = [];
    const gets: string[] = [];
    const held: (() => void)[] = [];
    const intervals: (() => void)[] = [];
    const recs: any[] = [];
    const win: any = {
        console, Promise, Array, JSON, Date, String, encodeURIComponent,
        setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
        setInterval: (fn: () => void) => { intervals.push(fn); return 0; },
        navigator: { language: "en-US" },
        location: { href: "/admin/os?token=tok", reload() { win.reloaded = (win.reloaded ?? 0) + 1; } },
        document: {
            visibilityState: "visible",
            getElementById: (id: string) => els[id] ?? null,
            addEventListener: () => {},
            createElement: (tag: string) => new T150El("", tag),
        },
        fetch: (url: string, init: any) => {
            const isGet = (init?.method ?? "GET") === "GET";
            const body = isGet ? null : JSON.parse(init.body);
            if (isGet) gets.push(url); else fetches.push({ url, body });
            const raw: any = isGet ? (opts.get ? opts.get(url, gets.length) : { status: 404, body: { error: "not found" } })
                : opts.reply ? opts.reply(fetches.length, body) : { tier: 1, kind: "answer", say: "Up 412 dollars." };
            const r: T150Reply = raw && ("status" in raw || "network" in raw || "redirect" in raw) ? raw : { status: 200, body: raw };
            const respond = () => {
                if (r.network) return Promise.reject(new TypeError("Failed to fetch"));
                const status = r.redirect ? 0 : r.status ?? 200;
                return Promise.resolve({
                    type: r.redirect ? "opaqueredirect" : "basic", status, ok: status >= 200 && status < 300,
                    headers: { get: () => (r.json === false ? "text/html" : "application/json; charset=utf-8") },
                    json: () => Promise.resolve(r.body),
                });
            };
            if (!opts.hold || isGet) return respond();
            return new Promise((resolve, reject) => { held.push(() => respond().then(resolve, reject)); });
        },
    };
    win.window = win;
    if (opts.startAt !== undefined) {
        const startAt = opts.startAt;
        win.Date = class T153Date extends Date { static now() { return startAt + timers.now; } };
    }
    const session = opts.session ?? new Map<string, string>();
    if (session !== "none") {
        win.sessionStorage = t150Storage(session instanceof Map ? session : new Map(), session instanceof Map ? "ok" : session);
    }
    if (synth) { win.speechSynthesis = synth; win.SpeechSynthesisUtterance = T150Utterance; }
    if (opts.recognition) {
        win.webkitSpeechRecognition = class {
            lang = ""; continuous = true; interimResults = false; maxAlternatives = 0; aborted = false; started = false;
            onresult: any = null; onerror: any = null; onend: any = null;
            constructor() { recs.push(this); }
            start() { this.started = true; } stop() {} abort() { this.aborted = true; }
        };
    }
    const storage = opts.storage ?? "ok";
    if (storage === "getter-throws") {
        Object.defineProperty(win, "localStorage", { get() { throw new Error("SecurityError: The operation is insecure."); } });
    } else if (storage !== "none") {
        win.localStorage = t150Storage(store, storage);
    }
    const ctx = vm.createContext(win);
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(m[1], ctx);
    const say = () => els["ask-reply"].querySelector(".ask-say").textContent;
    const display = () => els["ask-reply"].querySelector(".ask-display").textContent;
    const submit = (text: string) => { els["ask-text"].value = text; els["ask-form"].fire("submit"); };
    const release = async () => { while (held.length) held.shift()!(); await flush(); };
    const reloadDue = () => {
        const realNow = Date.now; Date.now = () => realNow() + 10 * 60_000;
        try { intervals.forEach((fn) => fn()); } finally { Date.now = realNow; }
        return win.reloaded ?? 0;
    };
    /** #153: one tick of the page's reload timer, on the page's own clock. */
    const reloadTick = () => { intervals.forEach((fn) => fn()); return win.reloaded ?? 0; };
    return { html, els, win, OS: win.OS, synth, timers, store, fetches, gets, recs, say, display, submit, release, reloadDue, reloadTick };
}

const lastSpoken = (synth: any) => synth.spoken.at(-1)?.text;

async function main() {
    // ── speaker ─────────────────────────────────────────────────────────────
    {
        const { speaker } = speakerWith();
        check("a short reply is one piece", JSON.stringify(speaker.chunks("Up 412 dollars, 0.4 percent.")) === '["Up 412 dollars, 0.4 percent."]');
        const sentences = Array.from({ length: 6 }, (_, i) => `Sentence ${i + 1} says something about the day, with a figure of ${i}.5 percent in it.`);
        const long = sentences.join(" ");
        const pieces: string[] = speaker.chunks(long);
        check(`long text is split into pieces of at most ${SPEECH_CHUNK_CHARS} characters, nothing lost`,
            pieces.length > 1 && pieces.every((p) => p.length <= SPEECH_CHUNK_CHARS) && pieces.join(" ") === long, pieces);
        check("... at sentence ends, never inside a number like 0.5",
            pieces.every((p) => /[.!?]$/.test(p)) && !pieces.some((p) => /^\d/.test(p)), pieces);
        const run = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");
        const runPieces: string[] = speaker.chunks(run);
        check("a long run with no sentence end is split between words",
            runPieces.length > 1 && runPieces.every((p) => p.length <= SPEECH_CHUNK_CHARS) && runPieces.join(" ") === run, runPieces);
    }
    {
        const s = speakerWith();
        const done: boolean[] = [];
        const text = Array.from({ length: 5 }, (_, i) => `This is sentence number ${i + 1} of the brief, read aloud in full.`).join(" ");
        s.speaker.speak(text, (cut: boolean) => done.push(cut));
        const n = s.synth.queue.length;
        check("speak() queues the pieces in order and reports speaking",
            n > 1 && s.synth.text === text && s.speaker.speaking() && s.changes.join() === "true", { n, changes: s.changes });
        s.synth.end();
        check("... ending a piece that isn't the last doesn't finish it", done.length === 0 && s.speaker.speaking());
        s.synth.endAll();
        check("... the last piece's end runs done(false) once, and it's no longer speaking",
            done.join() === "false" && !s.speaker.speaking() && s.changes.join() === "true,false", { done, changes: s.changes });
        check("... and leaves no timer behind", s.timers.count === 0);
    }
    for (const [how, synthOpts] of [
        ["(cancel events later)", {}],
        ["(cancel events at once)", { syncCancelEvents: true }],
        ["(cancel fires end at once, like WebKit)", { syncCancelEvents: true, cancelFiresEnd: true }],
    ] as const) {
        const s = speakerWith({ synthOpts });
        const first: boolean[] = [], second: boolean[] = [];
        s.speaker.speak("Opening Alpaca.", (cut: boolean) => first.push(cut));
        s.speaker.speak("Something else.", (cut: boolean) => second.push(cut));
        await flush();
        check(`speaking over speech cuts it off: done(true), the browser's queue cancelled ${how}`,
            first.join() === "true" && s.synth.cancels >= 1 && s.synth.queue.length === 1 && s.synth.queue[0].text === "Something else.",
            { first, cancels: s.synth.cancels, queue: s.synth.queue.map((u: T150Utterance) => u.text) });
        check(`... and the new speech isn't touched by the old one's cancel events ${how}`, second.length === 0 && s.speaker.speaking());
        s.synth.end();
        check(`... and finishes normally ${how}`, second.join() === "false" && first.length === 1);
    }
    {
        const s = speakerWith();
        const done: boolean[] = [];
        s.speaker.speak("A long reply.", (cut: boolean) => done.push(cut));
        check("cancel() stops speech: true, done(true), not speaking", s.speaker.cancel() === true && done.join() === "true"
            && !s.speaker.speaking() && s.synth.queue.length === 0 && s.changes.join() === "true,false", { done, changes: s.changes });
        check("... a second cancel() has nothing to stop", s.speaker.cancel() === false && done.length === 1);
        await flush();
        check("... and the browser's late interrupted event changes nothing", done.length === 1 && s.timers.count === 0);
    }
    {
        const s = speakerWith();
        s.speaker.speak("First.", (cut: boolean) => { if (cut) s.speaker.speak("Said from the cut-off callback."); });
        s.speaker.cancel();
        await flush();
        check("speech started from a cut-off callback survives the cancel that cut it",
            s.speaker.speaking() && s.synth.queue.length === 1 && s.synth.queue[0].text === "Said from the cut-off callback.");
    }
    {
        const done: boolean[] = [];
        const noSynth = speakerWith({ synth: null });
        noSynth.speaker.speak("Hello.", (cut: boolean) => done.push(cut));
        check("without speechSynthesis done(false) runs at once and nothing is speaking",
            done.join() === "false" && !noSynth.speaker.speaking() && noSynth.changes.length === 0);
        const s = speakerWith();
        s.speaker.speak("   ", (cut: boolean) => done.push(cut));
        check("empty text: done(false) at once, nothing queued", done.join() === "false,false" && s.synth.spoken.length === 0);
    }
    {
        const s = speakerWith({ synthOpts: { silent: true } });
        const done: boolean[] = [];
        s.speaker.speak("Opening Alpaca.", (cut: boolean) => done.push(cut));
        s.timers.advance(SPEECH_MIN_WAIT_MS - 1);
        check("a browser that never ends speech: still waiting just before the minimum wait", done.length === 0 && s.speaker.speaking());
        s.timers.advance(1);
        check(`... done(false) at ${SPEECH_MIN_WAIT_MS} ms, and no longer speaking`, done.join() === "false" && !s.speaker.speaking());
        const t = "x".repeat(100);
        s.speaker.speak(t, (cut: boolean) => done.push(cut));
        s.timers.advance(SPEECH_MS_PER_CHAR * 100 - 1);
        const before = done.length;
        s.timers.advance(1);
        check(`... a longer text waits ${SPEECH_MS_PER_CHAR} ms a character`, before === 1 && done.join() === "false,false", done);
    }
    {
        const s = speakerWith();
        const done: boolean[] = [];
        s.speaker.speak("Opening Alpaca.", (cut: boolean) => done.push(cut));
        s.timers.advance(SPEECH_MIN_WAIT_MS);
        check("a voice slower than the wait: while the browser still reports speaking, it waits on", done.length === 0 && s.speaker.speaking());
        s.synth.end();
        check("... and the real end finishes it", done.join() === "false" && s.timers.count === 0);
        s.speaker.speak("Opening Alpaca.", (cut: boolean) => done.push(cut));
        s.timers.advance(2 * SPEECH_MIN_WAIT_MS - 1);
        const stillWaiting = done.length === 1;
        s.timers.advance(1);
        check("... but an engine stuck 'speaking' is given up on at twice the wait", stillWaiting && done.join() === "false,false"
            && !s.speaker.speaking(), done);
    }
    {
        const s = speakerWith();
        const run = "\u{1F600}".repeat(120);   // 240 UTF-16 units, no spaces
        const pieces: string[] = s.speaker.chunks(run);
        check("a long run with no spaces is never split inside an emoji",
            pieces.length > 1 && pieces.join("") === run && pieces.every((p) => !/[\uD800-\uDBFF]$/.test(p) && !/^[\uDC00-\uDFFF]/.test(p)),
            pieces.map((p) => p.length));
    }
    {
        let made = 0;
        class Flaky extends T150Utterance { constructor(t: string) { if (++made === 3) throw new Error("bad voice"); super(t); } }
        const s = speakerWith({ Utterance: Flaky });
        const done: boolean[] = [];
        const errors: unknown[] = [];
        const realError = console.error; console.error = (e: unknown) => errors.push(e);
        s.speaker.speak(Array.from({ length: 6 }, (_, i) => `Sentence ${i} is long enough that the reply needs several pieces to say.`).join(" "),
            (cut: boolean) => done.push(cut));
        console.error = realError;
        check("a failure while queuing drops the pieces already queued: nothing plays untracked",
            done.join() === "false" && !s.speaker.speaking() && s.synth.queue.length === 0 && errors.length === 1, { q: s.synth.queue.length, done });
    }
    {
        const s = speakerWith();
        const done: boolean[] = [];
        const text = Array.from({ length: 5 }, (_, i) => `Sentence ${i + 1} is a fairly long one so the reply needs several pieces.`).join(" ");
        s.speaker.speak(text, (cut: boolean) => done.push(cut));
        s.synth.error("synthesis-failed");
        check("a speech failure ends the reply: done(false), the rest of the queue dropped",
            done.join() === "false" && !s.speaker.speaking() && s.synth.queue.length === 0 && s.synth.cancels >= 2, { done, q: s.synth.queue.length });
    }
    {
        const s = speakerWith({ synthOpts: { paused: true } });
        const v = T150_VOICES[1];
        s.setVoice(v);
        s.speaker.speak("Hello. Again.");
        check("each utterance gets the chosen voice and its language", s.synth.spoken.length >= 1
            && s.synth.spoken.every((u: T150Utterance) => u.voice === v && u.lang === "en-GB"));
        check("a paused speechSynthesis is resumed before speaking", s.synth.resumes === 1);
    }
    {
        const s = speakerWith();
        const errors: unknown[] = [];
        const realError = console.error; console.error = (e: unknown) => errors.push(e);
        s.speaker.speak("Hi.", () => { throw new Error("callback bug"); });
        s.synth.end();
        console.error = realError;
        check("a throwing done() is logged, not raised", errors.length === 1 && !s.speaker.speaking());
    }

    // ── page ────────────────────────────────────────────────────────────────
    {
        const html = t150Render();
        const controls = /<span id="ask-controls"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? "";
        check("the stop button sits in #ask-controls beside the mic, a hidden type=button with a label",
            /id="ask-mic"[\s\S]*id="ask-stop"/.test(controls) && /<button[^>]*id="ask-stop"[^>]*type="button"[^>]*aria-label="[^"]+"[^>]*hidden/.test(controls),
            controls);
        check("the voice picker is in the ask box, labelled, hidden until there are voices, with a default option",
            /<form id="ask-form"[\s\S]*id="ask-voice-row"[^>]*hidden[\s\S]*<label for="ask-voice">[\s\S]*<select id="ask-voice"><option value="">Default voice<\/option><\/select>[\s\S]*<\/form>/.test(html));
        check("no CDN scripts", !/<script[^>]+src=/.test(html));
    }

    // ── page scripts: every reply spoken and shown ──────────────────────────
    const kinds: [string, (n: number, b: any) => unknown, string][] = [
        ["an answer", () => ({ tier: 1, kind: "answer", say: "Up 412 dollars, 0.4 percent.", display: "+$412" }), "Up 412 dollars, 0.4 percent."],
        ["unavailable", () => ({ tier: 1, kind: "unavailable", say: "Alpaca is unavailable: no snapshots yet." }), "Alpaca is unavailable: no snapshots yet."],
        ["not understood", () => ({ tier: 1, kind: "not_understood", say: "I didn't understand that." }), "I didn't understand that."],
        ["a run proposal", () => ({ tier: 3, kind: "confirm_run", say: "Run the Morning brief?",
            confirmation: { id: 1, skill: "morning-brief", label: "Morning brief", expiresAt: new Date(Date.now() + 60_000).toISOString() } }), "Run the Morning brief?"],
        ["a navigation", () => ({ tier: 1, kind: "navigate", say: "Opening Alpaca.", url: "/admin/alpaca" }), "Opening Alpaca."],
        ["a server error", () => ({ status: 500, body: { error: "boom" } }), "Sorry: boom."],
        ["a 400", () => ({ status: 400, body: {} }), "The ask failed."],
        ["an expired session", () => ({ redirect: true }), "Your session has expired. Sign in again."],
        ["a non-admin", () => ({ status: 403, json: false }), "This account is not an administrator."],
        ["no server", () => ({ network: true }), "Couldn't reach the server."],
    ];
    for (const [what, reply, expected] of kinds) {
        const p = t150Boot({ reply });
        p.submit("anything");
        await flush();
        check(`${what}: the reply is shown and spoken, the same text`, p.say() === expected && lastSpoken(p.synth) === expected,
            { shown: p.say(), spoken: lastSpoken(p.synth) });
    }
    {
        const p = t150Boot({ reply: (n) => n === 2
            ? { status: 201, body: { run: { id: 3 }, created: true, say: "Queued the Morning brief." } }
            : { tier: 3, kind: "confirm_run", say: "Run the Morning brief?",
                confirmation: { id: n, skill: "morning-brief", label: "Morning brief", expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
        p.submit("run my morning brief"); await flush();
        p.els["ask-confirm-yes"].fire("click"); await flush();
        check("a confirmation's outcome is shown and spoken", p.say() === "Queued the Morning brief." && lastSpoken(p.synth) === "Queued the Morning brief.");
        p.submit("run my morning brief"); await flush();
        p.els["ask-confirm-no"].fire("click");
        check("... and so is a cancel", p.say() === "Cancelled." && lastSpoken(p.synth) === "Cancelled.");
    }

    // ── page scripts: stop ──────────────────────────────────────────────────
    {
        const p = t150Boot();
        const stop = p.els["ask-stop"];
        check("OS gains speaking(), pending(), onActivity(), stop(), voices(), voice(), setVoice()",
            ["speaking", "pending", "onActivity", "stop", "voices", "voice", "setVoice"].every((k) => typeof p.OS[k] === "function"));
        check("stop is hidden while nothing is happening", stop.hidden && !p.OS.speaking() && !p.OS.busy());
        p.submit("what's my p&l");
        check("stop shows while the ask is in flight", !stop.hidden && p.OS.pending());
        await flush();
        check("... and while the reply is spoken; the page counts as busy and won't reload",
            !stop.hidden && p.OS.speaking() && p.OS.busy() && p.reloadDue() === 0);
        stop.fire("click");
        check("pressing stop cuts the speech off", p.synth.queue.length === 0 && p.synth.cancels >= 1 && !p.OS.speaking());
        check("... the button hides, the reply stays shown, and the page can reload again",
            stop.hidden && p.say() === "Up 412 dollars." && !p.OS.busy() && p.reloadDue() === 1);
        check("OS.stop() with nothing going on returns false", p.OS.stop() === false);
    }
    {
        const p = t150Boot();
        p.submit("first"); await flush();
        check("(precondition) the first reply is being spoken", p.OS.speaking() && p.synth.queue.length === 1);
        p.submit("second");
        check("a new ask cuts off speech in progress as it's sent", p.synth.queue.length === 0 && !p.OS.speaking() && p.fetches.length === 2);
        await flush();
        check("... and its own reply is spoken", p.OS.speaking() && p.synth.spoken.length === 2);
    }
    {
        const p = t150Boot({ recognition: true });
        p.submit("first"); await flush();
        p.OS.listen();
        check("pressing the mic cuts off speech in progress", !p.OS.speaking() && p.synth.queue.length === 0);
        check("... and stop shows while listening", !p.els["ask-stop"].hidden);
        p.els["ask-stop"].fire("click");
        check("stop while listening lets go of the mic and sends nothing",
            p.recs[0].aborted && p.OS.micState() === "idle" && p.fetches.length === 1 && p.els["ask-stop"].hidden);
    }
    {
        const p = t150Boot({ reply: () => ({ tier: 1, kind: "navigate", say: "Opening Alpaca.", url: "/admin/alpaca" }) });
        p.submit("open alpaca"); await flush();
        check("a navigation waits for its 'Opening …' to finish", p.win.location.href === "/admin/os?token=tok" && p.OS.busy());
        p.synth.end();
        check("... then goes", p.win.location.href === "/admin/alpaca?token=tok", p.win.location.href);
    }
    {
        const p = t150Boot({ reply: () => ({ tier: 1, kind: "navigate", say: "Opening Alpaca.", url: "/admin/alpaca" }) });
        p.submit("open alpaca"); await flush();
        p.els["ask-stop"].fire("click");
        await flush(); p.timers.advance(60_000);
        check("stop during 'Opening …' cancels the navigation", p.win.location.href === "/admin/os?token=tok" && !p.OS.busy());
    }
    {
        const p = t150Boot({ reply: () => ({ tier: 1, kind: "navigate", say: "Opening Alpaca.", url: "/admin/alpaca" }) });
        p.submit("open alpaca"); await flush();
        p.OS.speak("The brief has landed.");
        await flush();
        check("OS.speak() over 'Opening …' cancels the navigation rather than leaving at once",
            p.win.location.href === "/admin/os?token=tok" && lastSpoken(p.synth) === "The brief has landed.");
        p.synth.end();
        p.timers.advance(60_000);
        check("... it stays cancelled, and the page isn't left busy", p.win.location.href === "/admin/os?token=tok" && !p.OS.busy());
    }
    {
        const p = t150Boot({ reply: (n) => n === 1 ? { tier: 1, kind: "navigate", say: "Opening Alpaca.", url: "/admin/alpaca" }
            : { tier: 1, kind: "answer", say: "Nothing due." } });
        p.submit("open alpaca"); await flush();
        p.submit("what's due"); await flush();
        p.synth.endAll(); p.timers.advance(60_000);
        check("a new ask during 'Opening …' cancels the navigation", p.win.location.href === "/admin/os?token=tok" && p.say() === "Nothing due.");
    }
    {
        const p = t150Boot({ hold: true });
        p.submit("what's my p&l");
        p.els["ask-stop"].fire("click");
        await p.release();
        check("stop while an ask is in flight: the reply is shown but not spoken",
            p.say() === "Up 412 dollars." && p.synth.spoken.length === 0 && !p.OS.busy() && p.els["ask-stop"].hidden);
        p.submit("again"); await p.release();
        check("... and the next ask is spoken again", lastSpoken(p.synth) === "Up 412 dollars." && p.OS.speaking());
    }
    {
        const p = t150Boot({ hold: true, reply: () => ({ tier: 1, kind: "navigate", say: "Opening Alpaca.", url: "/admin/alpaca" }) });
        p.submit("open alpaca");
        p.OS.stop();
        await p.release(); p.timers.advance(60_000);
        check("stop while a navigation is in flight: shown as stopped, not spoken, and the page stays",
            p.say() === "Opening Alpaca." && p.display() === "Stopped." && p.synth.spoken.length === 0
                && p.win.location.href === "/admin/os?token=tok" && !p.OS.busy(), { say: p.say(), display: p.display() });
    }
    {
        const p = t150Boot({ hold: true, reply: () => ({ network: true }) });
        p.submit("anything");
        p.OS.stop();
        await p.release();
        check("stop while an ask is in flight also silences its error", p.say() === "Couldn't reach the server." && p.synth.spoken.length === 0);
    }
    {
        const p = t150Boot({ synth: t150Synth({ silent: true }) });
        p.submit("anything"); await flush();
        p.timers.advance(60_000);
        check("a browser that never ends speech doesn't hold the page busy (or the stop button up) forever",
            !p.OS.speaking() && !p.OS.busy() && p.els["ask-stop"].hidden);
    }

    // ── page scripts: the voice ─────────────────────────────────────────────
    {
        const synth = t150Synth();
        const p = t150Boot({ synth });
        const row = p.els["ask-voice-row"], select = p.els["ask-voice"];
        check("voices not loaded yet: the picker stays hidden", row.hidden && p.OS.voices().length === 0);
        synth.setVoices(T150_VOICES);
        check("once voiceschanged fires the picker shows the default and every voice, the page's language first",
            !row.hidden && select.kids.map((o) => o.value).join("|")
                === "|Google UK English Female|com.apple.voice.compact.en-US.Samantha|com.apple.voice.Thomas"
                && select.kids[1].textContent === "Google UK English Female (en-GB)" && select.value === "",
            select.kids.map((o) => [o.value, o.textContent]));
        select.choose("com.apple.voice.compact.en-US.Samantha");
        check("picking a voice saves its voiceURI on this device", p.store.get(VOICE_STORAGE_KEY) === "com.apple.voice.compact.en-US.Samantha",
            [...p.store]);
        check("... and plays a short sample in it", lastSpoken(synth) === "This is Samantha." && synth.spoken.at(-1).voice === T150_VOICES[2]);
        p.submit("what's my p&l"); await flush();
        check("replies are then spoken in that voice", synth.spoken.at(-1).text === "Up 412 dollars."
            && synth.spoken.at(-1).voice === T150_VOICES[2] && synth.spoken.at(-1).lang === "en-US");

        // A reload: same device storage, and this time the voices arrive late again.
        const synth2 = t150Synth();
        const again = t150Boot({ synth: synth2, store: p.store });
        synth2.setVoices(T150_VOICES);
        check("after a reload the chosen voice is selected again", again.els["ask-voice"].value === "com.apple.voice.compact.en-US.Samantha"
            && again.OS.voice() === T150_VOICES[2]);
        again.submit("what's due"); await flush();
        check("... and replies use it", synth2.spoken.at(-1).voice === T150_VOICES[2]);
        again.els["ask-voice"].choose("");
        check("picking the default forgets the choice", !again.store.has(VOICE_STORAGE_KEY) && again.OS.voice() === null
            && lastSpoken(synth2) === "This is the default voice.");
        again.submit("what's due"); await flush();
        check("... and replies use the browser's default voice", synth2.spoken.at(-1).voice === null);
    }
    {
        const store = new Map([[VOICE_STORAGE_KEY, "com.apple.voice.Thomas"]]);
        const p = t150Boot({ synth: t150Synth({ voices: T150_VOICES, listeners: "prop" }), store });
        check("voices already loaded at boot (and onvoiceschanged as a property): the saved voice is selected",
            !p.els["ask-voice-row"].hidden && p.els["ask-voice"].value === "com.apple.voice.Thomas" && p.OS.voice() === T150_VOICES[0]);
        const before = p.els["ask-voice"].kids[1];
        p.synth.setVoices([...T150_VOICES]);
        check("... and a later voiceschanged keeps it, without rebuilding an unchanged list",
            p.els["ask-voice"].value === "com.apple.voice.Thomas" && p.els["ask-voice"].kids.length === 4 && p.els["ask-voice"].kids[1] === before);
        p.synth.setVoices(T150_VOICES.slice(0, 2));
        check("... a changed list is rebuilt", p.els["ask-voice"].kids.length === 3 && p.els["ask-voice"].value === "com.apple.voice.Thomas");
    }
    {
        const store = new Map([[VOICE_STORAGE_KEY, "Google UK English Female"]]);
        const voices = T150_VOICES.map((v) => (v.lang === "en-GB" ? { ...v, voiceURI: "urn:moz-tts:speechd:Google%20UK" } : v));
        const p = t150Boot({ synth: t150Synth({ voices }), store });
        check("a saved name still finds its voice when the voiceURI differs", p.OS.voice()?.name === "Google UK English Female");
    }
    {
        const store = new Map([[VOICE_STORAGE_KEY, "com.example.gone"]]);
        const p = t150Boot({ synth: t150Synth({ voices: T150_VOICES }), store });
        p.submit("anything"); await flush();
        check("a saved voice that isn't on this device: the default is used, the choice is kept",
            p.OS.voice() === null && p.els["ask-voice"].value === "" && p.synth.spoken.at(-1).voice === null
                && store.get(VOICE_STORAGE_KEY) === "com.example.gone");
        check("OS.setVoice() refuses a voice that isn't on offer", p.OS.setVoice("com.example.nope") === false
            && store.get(VOICE_STORAGE_KEY) === "com.example.gone");
    }
    {
        const synth = t150Synth();
        const p = t150Boot({ synth });
        synth.setVoices(T150_VOICES, true);   // no voiceschanged, ever
        p.timers.advance(VOICE_POLL_MS * 2);
        check("a browser that never fires voiceschanged: the page looks again and the picker shows",
            !p.els["ask-voice-row"].hidden && p.OS.voices().length === 3);
    }
    for (const storage of ["getter-throws", "methods-throw", "none"] as const) {
        const errors: unknown[] = [];
        let p: ReturnType<typeof t150Boot> | null = null;
        try { p = t150Boot({ synth: t150Synth({ voices: T150_VOICES }), storage }); } catch (e) { errors.push(e); }
        check(`storage ${storage}: the page boots`, !!p && errors.length === 0 && typeof p.OS?.ask === "function", errors.map(String));
        if (!p) continue;
        check(`storage ${storage}: the picker still shows the voices, on the default`, !p.els["ask-voice-row"].hidden && p.OS.voice() === null);
        let threw: unknown = null;
        try { p.els["ask-voice"].choose("Google UK English Female"); } catch (e) { threw = e; }
        check(`storage ${storage}: picking a voice works for this page`, threw === null && p.OS.voice() === T150_VOICES[1], String(threw));
        p.submit("what's my p&l"); await flush();
        check(`storage ${storage}: asks are answered and spoken in the chosen voice`,
            p.say() === "Up 412 dollars." && p.synth.spoken.at(-1).voice === T150_VOICES[1]);
        try { p.els["ask-voice"].choose(""); } catch (e) { threw = e; }
        check(`storage ${storage}: going back to the default doesn't throw either`, threw === null && p.OS.voice() === null);
    }

    // ── page scripts: confirm or cancel by voice (#151) ─────────────────────
    {
        // The page's matcher agrees with the server's (os/commands.ts matches the same patterns after normaliseAsk).
        const t151PageReply = vm.runInNewContext(`(${T151_PROPOSAL_REPLY_JS})`, {});
        const t151Phrases: [string, "confirm" | "cancel" | null][] = [
            ["yes", "confirm"], ["Yes.", "confirm"], ["Yes!", "confirm"], ["  YES  ", "confirm"], ["yeah", "confirm"], ["yep", "confirm"],
            ["Yes please", "confirm"], ["yes, do it", "confirm"], ["Yeah, go ahead.", "confirm"], ["OK, run it", "confirm"],
            ["sure", "confirm"], ["confirm", "confirm"], ["Confirmed.", "confirm"], ["do it", "confirm"], ["Do it!", "confirm"],
            ["go ahead", "confirm"], ["go for it", "confirm"], ["run it", "confirm"],
            ["no", "cancel"], ["No.", "cancel"], ["nope", "cancel"], ["No thanks", "cancel"], ["no, cancel it", "cancel"],
            ["cancel", "cancel"], ["Cancel that.", "cancel"], ["stop", "cancel"], ["Stop!", "cancel"], ["never mind", "cancel"],
            ["Nevermind", "cancel"], ["forget it", "cancel"], ["don't", "cancel"], ["Don't run it.", "cancel"],
            ["yes and also open alpaca", null], ["what's due today", null], ["run my morning brief", null], ["no way that's my P&L", null],
            ["yesterday", null], ["notes", null], ["stop the music", null], ["", null],
        ];
        const t151Mismatch = t151Phrases.filter(([text, want]) =>
            t151PageReply(text) !== want || t151ServerReply(t151Normalise(text)) !== want);
        check("the page and the server read the same short phrasings as confirm, cancel or neither", t151Mismatch.length === 0,
            t151Mismatch.map(([text, want]) => ({ text, want, page: t151PageReply(text), server: t151ServerReply(t151Normalise(text)) })));
    }

    const t151Expiry = (ms = 60_000) => new Date(Date.now() + ms).toISOString();
    /** Answers asks (a proposal for anything starting "run", else an echo) and confirms (`confirmReply`). */
    const t151Replies = (confirmReply: (body: any) => unknown = () =>
        ({ status: 201, body: { run: { id: 42, skill: "morning-brief" }, created: true, say: "Queued the morning brief." } })) => {
        let nextId = 100;
        return (_n: number, body: any) => {
            if ("id" in body) return confirmReply(body);
            if (/^run/.test(body.text)) return { tier: 3, kind: "confirm_run", say: "Run the morning brief?",
                confirmation: { id: ++nextId, skill: "morning-brief", label: "Morning brief", expiresAt: t151Expiry() } };
            return { tier: 1, kind: "answer", say: `Router heard: ${body.text}` };
        };
    };
    /** One spoken utterance through the mic: press, a final result, the end of speech. */
    const t151Say = async (p: ReturnType<typeof t150Boot>, text: string) => {
        const listening = p.OS.listen();
        const r = p.recs.at(-1);
        r.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: true })] });
        r.onend?.();
        await flush();
        return listening;
    };
    const t151Confirms = (p: ReturnType<typeof t150Boot>) => p.fetches.filter((f) => f.url.startsWith("/admin/os/ask/confirm?"));
    const t151Asks = (p: ReturnType<typeof t150Boot>) => p.fetches.filter((f) => f.url.startsWith("/admin/os/ask?"));
    {
        const p = t150Boot({ recognition: true, reply: t151Replies() });
        const ran: any[] = [];
        p.OS.onConfirm((run: any) => ran.push(run));
        p.submit("run my morning brief"); await flush();
        check("(precondition) a proposal is pending", p.OS.proposal()?.id === 101 && !p.els["ask-confirm"].hidden);
        await t151Say(p, "Yes.");
        check("a spoken \"yes\" to a pending proposal confirms it: one POST to /admin/os/ask/confirm with its id, nothing asked",
            t151Confirms(p).length === 1 && t151Confirms(p)[0].body.id === 101 && t151Asks(p).length === 1, p.fetches);
        check("... the run is queued (onConfirm gets it) and the outcome is shown and spoken",
            ran.length === 1 && ran[0].id === 42 && p.say() === "Queued the morning brief."
                && lastSpoken(p.synth) === "Queued the morning brief.", { ran, shown: p.say(), spoken: lastSpoken(p.synth) });
        check("... the proposal is gone, its buttons hidden, the mic idle and the text box cleared",
            p.OS.proposal() === null && p.els["ask-confirm"].hidden && p.OS.micState() === "idle" && p.els["ask-text"].value === "");
        await t151Say(p, "yes");
        check("a second \"yes\", with nothing pending now, goes to the router as an ask (it answers \"Nothing to confirm\")",
            t151Confirms(p).length === 1 && t151Asks(p).length === 2 && t151Asks(p)[1].body.text === "yes"
                && t151Asks(p)[1].body.source === "voice", p.fetches);
    }
    for (const said of ["no", "Cancel.", "never mind", "stop"]) {
        const p = t150Boot({ recognition: true, reply: t151Replies() });
        p.submit("run my morning brief"); await flush();
        await t151Say(p, said);
        check(`a spoken "${said}" dismisses the pending proposal: nothing posted, "Cancelled." shown and spoken`,
            p.fetches.length === 1 && p.OS.proposal() === null && p.els["ask-confirm"].hidden && p.say() === "Cancelled."
                && lastSpoken(p.synth) === "Cancelled." && p.OS.micState() === "idle" && p.els["ask-text"].value === "",
            { fetches: p.fetches.length, shown: p.say(), proposal: p.OS.proposal() });
    }
    {
        const p = t150Boot({ reply: t151Replies() });
        p.submit("run my morning brief"); await flush();
        p.submit("Yes, do it.");
        await flush();
        check("a typed \"yes\" to a pending proposal confirms it the same way (handled in the page, not the router)",
            t151Confirms(p).length === 1 && t151Asks(p).length === 1 && p.say() === "Queued the morning brief."
                && p.els["ask-text"].value === "", p.fetches);
        p.submit("run my morning brief"); await flush();
        p.submit("no"); await flush();
        check("... and a typed \"no\" dismisses it", p.fetches.length === 3 && p.OS.proposal() === null && p.say() === "Cancelled."
            && p.els["ask-text"].value === "");
        p.submit("no"); await flush();
        check("... while a typed \"no\" with nothing pending goes to the router", t151Asks(p).length === 3
            && t151Asks(p)[2].body.text === "no");
    }
    {
        const p = t150Boot({ recognition: true, reply: t151Replies() });
        p.submit("run my morning brief"); await flush();
        await t151Say(p, "what's due today");
        check("anything else said while a proposal is pending is asked as usual, and the proposal is dropped",
            t151Asks(p).length === 2 && t151Asks(p)[1].body.text === "what's due today" && t151Confirms(p).length === 0
                && p.OS.proposal() === null && p.say() === "Router heard: what's due today", p.fetches);
    }
    const t151Outcomes: [string, unknown, string, boolean][] = [
        ["410 (expired)", { status: 410, body: { error: "This proposal has expired" } }, "That proposal expired. Ask again to run it.", false],
        ["409 (already confirmed)", { status: 409, body: { error: "Already confirmed" } }, "That run was already confirmed.", false],
        ["404 (unknown)", { status: 404, body: { error: "No such proposal" } }, "Nothing to confirm.", false],
        ["500", { status: 500, body: { error: "enqueue failed" } }, "Sorry, the run couldn't be queued. Try again.", true],
    ];
    for (const [what, confirmReply, expected, keeps] of t151Outcomes) {
        const p = t150Boot({ recognition: true, reply: t151Replies(() => confirmReply) });
        p.submit("run my morning brief"); await flush();
        await t151Say(p, "yes");
        check(`a voice confirm answered ${what} is shown and spoken: "${expected}"`,
            t151Confirms(p).length === 1 && p.say() === expected && lastSpoken(p.synth) === expected,
            { shown: p.say(), spoken: lastSpoken(p.synth) });
        p.synth.endAll();
        check(keeps ? "... and the proposal stays, so \"yes\" can try again (left in the text box)"
            : "... and the proposal is gone, the text box cleared (so the page isn't held busy)",
            keeps ? p.OS.proposal()?.id === 101 && !p.els["ask-confirm"].hidden && p.els["ask-text"].value === "yes"
                : p.OS.proposal() === null && p.els["ask-confirm"].hidden && p.els["ask-text"].value === "" && !p.OS.busy(),
            { proposal: p.OS.proposal(), box: p.els["ask-text"].value });
        if (keeps) {
            await t151Say(p, "yes");
            check("... and a second \"yes\" confirms it again", t151Confirms(p).length === 2 && t151Asks(p).length === 1);
            p.synth.endAll();
            p.timers.advance(61_000);
            check("... and when it then lapses, the question comes back marked expired, not the confirm's error",
                p.OS.proposal() === null && p.say() === "Run the morning brief?" && /Expired/.test(p.display()),
                { shown: p.say(), display: p.display() });
        }
    }
    {
        const p = t150Boot({ recognition: true, reply: t151Replies(() => ({ status: 410, body: { error: "expired" } })) });
        p.submit("run my morning brief"); await flush();
        await t151Say(p, "yes");
        await t151Say(p, "yes");
        check("after a 410, saying \"yes\" again still says it expired, without posting",
            t151Confirms(p).length === 1 && t151Asks(p).length === 1 && p.say() === "That proposal expired. Ask again to run it."
                && lastSpoken(p.synth) === "That proposal expired. Ask again to run it.", p.fetches);
    }
    {
        const p = t150Boot({ recognition: true, reply: t151Replies() });
        p.submit("run my morning brief"); await flush();
        p.timers.advance(61_000);
        check("(precondition) the proposal lapsed on the page's own timer", p.OS.proposal() === null && p.els["ask-confirm"].hidden
            && /Expired/.test(p.display()), p.display());
        await t151Say(p, "Yes");
        check("a \"yes\" after the proposal lapsed says it expired, and queues nothing",
            p.fetches.length === 1 && p.say() === "That proposal expired. Ask again to run it."
                && lastSpoken(p.synth) === "That proposal expired. Ask again to run it.", { fetches: p.fetches, shown: p.say() });
        await t151Say(p, "what's due");
        await t151Say(p, "yes");
        check("... but once something else is asked, \"yes\" goes to the router again",
            t151Asks(p).length === 3 && t151Asks(p)[2].body.text === "yes" && t151Confirms(p).length === 0, p.fetches);
    }
    {
        const p = t150Boot({ recognition: true, hold: true, reply: t151Replies() });
        p.submit("run my morning brief"); await p.release();
        const sayThen = t151Say(p, "yes");
        await flush();
        check("(precondition) the spoken confirm is in flight", t151Confirms(p).length === 1 && p.OS.pending());
        check("stop while a spoken confirm is in flight: stop has something to stop", p.OS.stop() === true);
        await p.release(); await sayThen;
        check("... the outcome is shown but not spoken (the run is still queued)",
            p.say() === "Queued the morning brief." && lastSpoken(p.synth) !== "Queued the morning brief." && !p.OS.pending());
    }

    // ── page scripts: a confirmed run is followed and its outcome said (#153) ──
    const T153_START = Date.parse("2026-10-22T11:45:00Z");
    const T153_SAY = "Good morning. You have three things due today, and the first is the dentist at ten. "
        + "The paper account is up 47 dollars, half a percent, with SPY flat. The lint wiki run found two stale pages. "
        + "Nothing in the inbox needs you before noon, and the runner is online. That's the brief.";
    const T153_LABELS: Record<string, string> = { "morning-brief": "Morning brief", "lint-wiki": "Lint wiki", "weekly-review": "Weekly review" };
    /** A fake server for one run: `s.run` is what GET /runs/:id says; `s.say` and `s.runReply` override the replies. */
    const t153Server = (id: number, skill: string) => {
        const s = {
            run: { status: "queued", summary: null as string | null, outputPath: null as string | null, finishedAt: null as string | null },
            say: { status: 404, body: { error: "no brief", date: "2026-10-22" } } as T150Reply,
            runReply: null as T150Reply | null,
        };
        const get = (url: string) => {
            if (url.startsWith(`/admin/os/api/runs/${id}?`)) {
                return s.runReply ?? { status: 200, body: { id, skill, label: T153_LABELS[skill], trigger: "button",
                    requestedAt: new Date(T153_START).toISOString(), claimedAt: null, ...s.run } };
            }
            if (url.startsWith("/admin/os/api/brief/say")) return s.say;
            return { status: 404, body: { error: "no such run" } };
        };
        return { s, get };
    };
    /** Asks propose `skill`; the confirm queues run `id` (or `confirmBody` says otherwise). */
    const t153Replies = (id: number, skill: string, confirmBody?: () => unknown) => (_n: number, body: any) => {
        if ("id" in body) return confirmBody ? confirmBody()
            : { status: 201, body: { run: { id, skill, status: "queued" }, created: true, say: `Queued the ${T153_LABELS[skill].toLowerCase()}.` } };
        if (/^run/.test(body.text)) return { tier: 3, kind: "confirm_run", say: `Run the ${T153_LABELS[skill].toLowerCase()}?`,
            confirmation: { id: 500 + id, skill, label: T153_LABELS[skill], expiresAt: new Date(Date.now() + 60_000).toISOString() } };
        return { tier: 1, kind: "answer", say: `Router heard: ${body.text}` };
    };
    /** Time passes on the page, a second at a time, letting each poll's response land. */
    const t153Pass = async (p: ReturnType<typeof t150Boot>, ms: number) => {
        for (let t = 0; t < ms; t += 1000) { p.timers.advance(Math.min(1000, ms - t)); await flush(); }
    };
    type T153Opts = Parameters<typeof t150Boot>[0] & { id?: number; skill?: string };
    /** A page with run `id` of `skill` proposed and confirmed with a tap, its "Queued …" already spoken. */
    const t153Confirmed = async (o: T153Opts = {}) => {
        const id = o.id ?? 7, skill = o.skill ?? "morning-brief";
        const srv = t153Server(id, skill);
        const p = t150Boot({ startAt: T153_START, reply: t153Replies(id, skill), get: srv.get, ...o });
        p.submit(`run the ${skill}`); await flush();
        p.els["ask-confirm-yes"].fire("click"); await flush();
        p.synth.endAll();
        return { p, srv, id, skill };
    };
    const t153Line = (p: ReturnType<typeof t150Boot>) => p.els["ask-watch"].textContent;
    const t153Spoken = (p: ReturnType<typeof t150Boot>, from = 0) => p.synth.spoken.slice(from).map((u: T150Utterance) => u.text).join(" ");

    {
        const { p, srv } = await t153Confirmed();
        check("a tap-confirmed brief run is followed: OS.watching() has it, and the status line says so",
            JSON.stringify(p.OS.watching()) === JSON.stringify([{ id: 7, skill: "morning-brief", label: "morning brief", phase: "run" }])
                && !p.els["ask-watch"].hidden && t153Line(p) === "Waiting for the morning brief run (queued)…" && p.say() === "Queued the morning brief.",
            { watching: p.OS.watching(), line: t153Line(p), say: p.say() });
        await t153Pass(p, 14_000);
        check("... nothing is polled before 15 seconds", p.gets.length === 0, p.gets);
        await t153Pass(p, 1_000);
        check("... then GET /admin/os/api/runs/7 with the token", p.gets.length === 1 && p.gets[0] === "/admin/os/api/runs/7?token=tok", p.gets);
        srv.s.run.status = "running";
        await t153Pass(p, 15_000);
        check("... every 15 seconds while it runs, and the line follows its status",
            p.gets.length === 2 && t153Line(p) === "Waiting for the morning brief run (running)…", { gets: p.gets, line: t153Line(p) });
        const spokenBefore = p.synth.spoken.length;
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md", summary: "brief status: ok" });
        await t153Pass(p, 15_000);
        check("once it succeeds, the Say endpoint is asked at once, for the day in its output path",
            p.gets.length === 4 && p.gets[3] === "/admin/os/api/brief/say?date=2026-10-22&token=tok", p.gets);
        check("... a 404 (no brief in the vault yet) says nothing, and the line says what it's waiting for",
            p.synth.spoken.length === spokenBefore && p.OS.watching()[0]?.phase === "say"
                && t153Line(p) === "The morning brief run finished. Waiting for the brief to reach the vault…", t153Line(p));
        await t153Pass(p, 14_000);
        check("... and it doesn't ask again before 15 seconds", p.gets.length === 4);
        srv.s.say = { status: 200, body: { date: "2026-10-22", source: "say", text: T153_SAY, status: "ok", generated: "2026-10-22T11:58:00Z" } };
        await t153Pass(p, 1_000);
        check("when the Say block is there, it's spoken, all of it, in sentence-sized pieces",
            t153Spoken(p, spokenBefore) === T153_SAY && p.synth.spoken.length - spokenBefore > 1, t153Spoken(p, spokenBefore));
        check("... and shown in the status line; the ask reply is left alone",
            t153Line(p) === T153_SAY && p.say() === "Queued the morning brief.", { line: t153Line(p), say: p.say() });
        check("... while it's spoken the page counts as busy and won't reload", p.OS.busy() && p.reloadTick() === 0);
        p.synth.endAll();
        const getsAfter = p.gets.length;
        await t153Pass(p, 20 * 60_000);
        check("... it's said once: no more polls, nothing more spoken, the watch gone from the tab's storage",
            p.gets.length === getsAfter && t153Spoken(p, spokenBefore) === T153_SAY && p.OS.watching().length === 0
                && !p.store.has("pwa.os.watch") && !p.OS.busy(), { gets: p.gets.length - getsAfter, watching: p.OS.watching() });
    }
    {
        const { p, srv } = await t153Confirmed();
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md" });
        await t153Pass(p, 15_000);
        const sayGets = () => p.gets.filter((u) => u.startsWith("/admin/os/api/brief/say")).length;
        await t153Pass(p, 15 * 60_000 - 1_000);
        check("a brief that never reaches the vault: the Say endpoint is asked every 15 s for 15 minutes, nothing spoken yet",
            sayGets() === 60 && p.OS.watching().length === 1 && !/brief isn't/.test(t153Spoken(p)), sayGets());
        await t153Pass(p, 1_000);
        const said = "The morning brief run finished, but the brief isn't in the vault yet, so I've stopped waiting for it.";
        check("... then it stops and says so, shown and spoken", sayGets() === 60 && t153Line(p) === said && p.synth.spoken.at(-1)?.text === said,
            { line: t153Line(p), gets: sayGets() });
        await t153Pass(p, 5 * 60_000);
        check("... and asks nothing more", sayGets() === 60 && p.OS.watching().length === 0);
    }
    {
        const { p, srv } = await t153Confirmed();
        srv.s.run.status = "running";
        await t153Pass(p, 45 * 60_000 - 1_000);
        check("a run that never finishes is polled every 15 s for 45 minutes (179 polls), nothing said yet",
            p.gets.length === 179 && p.OS.watching().length === 1, p.gets.length);
        await t153Pass(p, 1_000);
        const said = "The morning brief run hasn't finished after 45 minutes, so I've stopped waiting for it.";
        check("... at 45 minutes it stops and says so", p.gets.length === 179 && t153Line(p) === said && lastSpoken(p.synth) === said,
            { line: t153Line(p), gets: p.gets.length });
        await t153Pass(p, 30 * 60_000);
        check("... and polls no more", p.gets.length === 179 && p.OS.watching().length === 0);
    }
    for (const [summary, said] of [
        ["morning_brief.ps1 exited 1; see private\\logs\\morning_brief_2026-10-22.log", "The morning brief run failed: morning_brief.ps1 exited 1; see private\\logs\\morning_brief_2026-10-22.log."],
        ["no result from runner within 45 minutes.", "The morning brief run failed: no result from runner within 45 minutes."],
        [null, "The morning brief run failed."],
    ] as const) {
        const { p, srv } = await t153Confirmed();
        Object.assign(srv.s.run, { status: "failed", summary });
        await t153Pass(p, 15_000);
        check(`a failed run is said with its reason: "${said}"`, lastSpoken(p.synth) === said && t153Line(p) === said,
            { spoken: lastSpoken(p.synth), line: t153Line(p) });
        await t153Pass(p, 5 * 60_000);
        check("... once, with no Say poll and no more run polls", p.gets.length === 1 && t153Spoken(p).split(said).length === 2, p.gets);
    }
    for (const [skill, said] of [["lint-wiki", "The lint wiki run finished."], ["weekly-review", "The weekly review run finished."]] as const) {
        const { p, srv } = await t153Confirmed({ id: 11, skill });
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/lint/2026-10-22.md" });
        await t153Pass(p, 15_000);
        check(`another skill that succeeds is said as such: "${said}", without asking for a brief`,
            lastSpoken(p.synth) === said && t153Line(p) === said && p.gets.every((u) => u.startsWith("/admin/os/api/runs/11?")), p.gets);
    }
    {
        const { p, srv } = await t153Confirmed({ id: 12, skill: "lint-wiki" });
        Object.assign(srv.s.run, { status: "failed", summary: "lint status: partial (unavailable: Notion)" });
        await t153Pass(p, 15_000);
        check("... and one that fails, with its reason", lastSpoken(p.synth) === "The lint wiki run failed: lint status: partial (unavailable: Notion).");
    }
    {
        const { p, srv } = await t153Confirmed();
        srv.s.runReply = { status: 500, body: { error: "could not read the run" } };
        await t153Pass(p, 15_000);
        srv.s.runReply = { network: true };
        await t153Pass(p, 15_000);
        srv.s.runReply = { status: 502, json: false };
        await t153Pass(p, 15_000);
        check("a 500, no answer, or a non-JSON reply just means look again in 15 s",
            p.gets.length === 3 && p.OS.watching().length === 1 && lastSpoken(p.synth) === "Queued the morning brief.", p.gets);
        srv.s.runReply = null;
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md" });
        srv.s.say = { status: 500, body: { error: "brief unreadable", date: "2026-10-22" } };
        await t153Pass(p, 15_000);
        check("... the Say endpoint's 500 (a brief caught mid-pull) too", p.OS.watching()[0]?.phase === "say" && lastSpoken(p.synth) === "Queued the morning brief.");
        srv.s.say = { status: 200, body: { date: "2026-10-22", source: "top3", text: "Ship the release.\nCall Sam.", status: "ok", generated: null } };
        await t153Pass(p, 15_000);
        check("... and an older brief's Top 3 is read when there's no Say block", lastSpoken(p.synth) === "Ship the release. Call Sam." || t153Spoken(p).endsWith("Ship the release. Call Sam."),
            t153Spoken(p));
    }
    for (const [what, reply, said] of [
        ["a Say reply with nothing to read", { status: 200, body: { date: "2026-10-22", source: "none", text: "", status: "ok", generated: null } },
            "The morning brief run finished, but the brief has nothing to read aloud."],
        ["no vault configured (503)", { status: 503, body: { error: "OBSIDIAN_VAULT_PATH is not configured" } },
            "The morning brief run finished, but I can't read the brief here."],
    ] as const) {
        const { p, srv } = await t153Confirmed();
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md" });
        srv.s.say = reply;
        await t153Pass(p, 15_000);
        check(`${what}: "${said}", and the watch ends`, lastSpoken(p.synth) === said && p.OS.watching().length === 0, lastSpoken(p.synth));
    }
    {
        const { p, srv } = await t153Confirmed();
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "projects/somewhere/else.md" });
        await t153Pass(p, 15_000);
        check("a brief with no dated output path asks for the server's today", p.gets[1] === "/admin/os/api/brief/say?token=tok", p.gets);
    }
    {
        // A re-run (claimed 11:46Z, 6:46 Central): the vault still has the day's earlier brief until this run's arrives.
        const { p, srv } = await t153Confirmed();
        const claimed = new Date(T153_START + 60_000).toISOString();
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md", claimedAt: claimed });
        srv.s.say = { status: 200, body: { date: "2026-10-22", source: "say", text: "The old brief, from earlier.", status: "ok",
            generated: "2026-10-22T06:30-05:00" } };
        await t153Pass(p, 30_000);
        check("a brief generated before the run was claimed is an earlier one: not read, and asked for again",
            !/old brief/.test(t153Spoken(p)) && p.OS.watching()[0]?.phase === "say"
                && p.gets.filter((u) => u.startsWith("/admin/os/api/brief/say")).length === 2, t153Spoken(p));
        // The new one is stamped to the minute and the PC's clock may lag: a minute "before" the claim still counts as this run's.
        srv.s.say = { status: 200, body: { date: "2026-10-22", source: "say", text: T153_SAY, status: "ok",
            generated: new Date(T153_START).toISOString().slice(0, 16) + "Z" } };
        await t153Pass(p, 15_000);
        check("... and this run's brief is read once it's there", lastSpoken(p.synth) !== undefined && t153Spoken(p).endsWith(T153_SAY), t153Spoken(p));
    }
    {
        const { p, srv } = await t153Confirmed();
        srv.s.runReply = { status: 400, body: { error: "id must be a run id" } };
        await t153Pass(p, 15_000);
        await t153Pass(p, 60_000);
        check("a refusal that won't change (a 400) ends the watch at once, said",
            p.gets.length === 1 && lastSpoken(p.synth) === "I couldn't check on the morning brief run, so I've stopped following it.", lastSpoken(p.synth));
    }
    for (const [what, reply, said] of [
        ["an expired session (redirect)", { redirect: true }, "I stopped following the morning brief run: your session has expired."],
        ["a non-admin (403)", { status: 403, json: false }, "I stopped following the morning brief run: this account is not an administrator."],
        ["a run that's gone (404)", { status: 404, body: { error: "no such run" } }, "I can't find the morning brief run any more."],
    ] as const) {
        const { p, srv } = await t153Confirmed();
        srv.s.runReply = reply;
        await t153Pass(p, 15_000);
        await t153Pass(p, 60_000);
        check(`${what}: it stops following the run and says why, once`, p.gets.length === 1 && lastSpoken(p.synth) === said
            && t153Line(p) === said && p.OS.watching().length === 0, { gets: p.gets.length, spoken: lastSpoken(p.synth) });
    }

    // Never over the admin.
    {
        const srv = t153Server(21, "lint-wiki");
        const p = t150Boot({ startAt: T153_START, hold: true, reply: t153Replies(21, "lint-wiki"), get: srv.get });
        p.submit("run the lint wiki"); await p.release();
        p.els["ask-confirm-yes"].fire("click"); await p.release(); p.synth.endAll();
        check("(precondition) the run is followed", p.OS.watching().length === 1);
        p.submit("what's due today");
        Object.assign(srv.s.run, { status: "succeeded" });
        await t153Pass(p, 15_000);
        check("an outcome landing while an ask is in flight waits: shown, not spoken, and the page is held",
            t153Line(p) === "The lint wiki run finished." && !/lint wiki run finished/.test(t153Spoken(p)) && p.OS.busy(), t153Spoken(p));
        await p.release();
        check("... the ask's reply is spoken first", lastSpoken(p.synth) === "Router heard: what's due today");
        await t153Pass(p, 1_000);
        check("... and the outcome still waits while that reply is being spoken", lastSpoken(p.synth) === "Router heard: what's due today");
        p.synth.endAll(); await flush();
        check("... then it's said", lastSpoken(p.synth) === "The lint wiki run finished.", lastSpoken(p.synth));
    }
    {
        const { p, srv } = await t153Confirmed({ recognition: true });
        await t153Pass(p, 10_000);
        p.OS.listen();   // the mic gives up by itself after 15 s: the poll lands at 15 s, 5 s in
        Object.assign(srv.s.run, { status: "failed", summary: "boom" });
        await t153Pass(p, 10_000);
        check("an outcome landing while the mic listens waits (and isn't heard by it)",
            p.OS.micState() === "listening" && !/failed/.test(t153Spoken(p)) && t153Line(p) === "The morning brief run failed: boom.");
        p.OS.cancelListening(); await t153Pass(p, 1_000);
        check("... and is said once the mic lets go", lastSpoken(p.synth) === "The morning brief run failed: boom.", lastSpoken(p.synth));
    }
    {
        const { p, srv } = await t153Confirmed({ id: 22, skill: "lint-wiki" });
        p.submit("run the lint-wiki"); await flush();   // a new proposal, waiting for yes or no
        p.synth.endAll();
        Object.assign(srv.s.run, { status: "succeeded" });
        await t153Pass(p, 15_000);
        check("an outcome waits while a run proposal is waiting for an answer", !!p.OS.proposal() && lastSpoken(p.synth) === "Run the lint wiki?");
        p.els["ask-confirm-no"].fire("click"); p.synth.endAll();
        await t153Pass(p, 1_000);
        check("... and is said once it's answered", lastSpoken(p.synth) === "The lint wiki run finished.", lastSpoken(p.synth));
    }
    {
        const { p, srv } = await t153Confirmed();
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md" });
        srv.s.say = { status: 200, body: { date: "2026-10-22", source: "say", text: T153_SAY, status: "ok", generated: null } };
        await t153Pass(p, 15_000);
        check("(precondition) the brief is being read", p.OS.speaking() && t153Line(p) === T153_SAY);
        p.els["ask-stop"].fire("click");
        const n = p.synth.spoken.length;
        await t153Pass(p, 5 * 60_000);
        check("STOP cuts the brief off, and it isn't read again", !p.OS.speaking() && p.synth.spoken.length === n
            && t153Line(p) === T153_SAY && p.OS.watching().length === 0);
    }
    {
        // Two runs land together: the second waits for the first, and STOP during the first silences both.
        const lint = t153Server(81, "lint-wiki"), review = t153Server(82, "weekly-review");
        const get = (url: string) => (url.startsWith("/admin/os/api/runs/81?") ? lint.get(url) : review.get(url));
        let confirms = 0;
        const p = t150Boot({ startAt: T153_START, get, reply: (_n, body) => "id" in body
            ? (++confirms === 1 ? { status: 201, body: { run: { id: 81, skill: "lint-wiki", status: "queued" }, created: true, say: "Queued the lint wiki." } }
                : { status: 201, body: { run: { id: 82, skill: "weekly-review", status: "queued" }, created: true, say: "Queued the weekly review." } })
            : { tier: 3, kind: "confirm_run", say: "Run it?", confirmation: { id: 900 + confirms, skill: "lint-wiki", label: "Lint wiki",
                expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
        for (let i = 0; i < 2; i++) { p.submit("run it"); await flush(); p.els["ask-confirm-yes"].fire("click"); await flush(); p.synth.endAll(); }
        check("(precondition) both runs are followed", p.OS.watching().length === 2);
        lint.s.run.status = "succeeded"; review.s.run.status = "succeeded";
        await t153Pass(p, 15_000);
        check("two outcomes at once: the first is said, the second waits for it", lastSpoken(p.synth) === "The lint wiki run finished."
            && t153Line(p) === "The weekly review run finished." && p.OS.busy(), { spoken: lastSpoken(p.synth), line: t153Line(p) });
        p.els["ask-stop"].fire("click");
        await t153Pass(p, 60_000);
        check("... STOP during the first silences the second too (it stays shown)", lastSpoken(p.synth) === "The lint wiki run finished."
            && !p.OS.speaking() && !p.OS.busy() && t153Line(p) === "The weekly review run finished.", t153Spoken(p));
    }
    {
        const lint = t153Server(83, "lint-wiki"), review = t153Server(84, "weekly-review");
        const get = (url: string) => (url.startsWith("/admin/os/api/runs/83?") ? lint.get(url) : review.get(url));
        let confirms = 0;
        const p = t150Boot({ startAt: T153_START, get, reply: (_n, body) => "id" in body
            ? { status: 201, body: { run: ++confirms === 1 ? { id: 83, skill: "lint-wiki" } : { id: 84, skill: "weekly-review" }, created: true, say: "Queued." } }
            : { tier: 3, kind: "confirm_run", say: "Run it?", confirmation: { id: 950 + confirms, skill: "lint-wiki", label: "Lint wiki",
                expiresAt: new Date(Date.now() + 60_000).toISOString() } } });
        for (let i = 0; i < 2; i++) { p.submit("run it"); await flush(); p.els["ask-confirm-yes"].fire("click"); await flush(); p.synth.endAll(); }
        lint.s.run.status = "succeeded"; review.s.run.status = "failed";
        await t153Pass(p, 15_000);
        p.synth.end(); await flush();
        check("... left alone, the second is said after the first, each once",
            t153Spoken(p).endsWith("The lint wiki run finished. The weekly review run failed.") && t153Spoken(p).split("The lint wiki run finished.").length === 2,
            t153Spoken(p));
    }

    // Typed and spoken confirms start a watch too; a confirm that finds the same run doesn't start a second.
    {
        const srv = t153Server(31, "morning-brief");
        const p = t150Boot({ startAt: T153_START, recognition: true, reply: t153Replies(31, "morning-brief", () =>
            ({ status: 200, body: { run: { id: 31, skill: "morning-brief", status: "running" }, created: false, say: "The morning brief is already running." } })),
            get: srv.get });
        p.submit("run my morning brief"); await flush();
        p.submit("yes"); await flush();
        check("a typed \"yes\" starts following the run", p.OS.watching().length === 1 && p.OS.watching()[0].id === 31
            && t153Line(p) === "Waiting for the morning brief run (running)…", t153Line(p));
        p.submit("run my morning brief"); await flush();
        await t151Say(p, "yes");
        check("a spoken \"yes\" that finds the same run doesn't follow it twice", p.OS.watching().length === 1);
        await t153Pass(p, 15_000);
        check("... one poll per 15 s", p.gets.length === 1, p.gets);
    }

    // Reloads: the watch is kept in the tab's sessionStorage, so the reload carries on as usual.
    {
        const session = new Map<string, string>();
        const { p, srv } = await t153Confirmed({ session, id: 41 });
        srv.s.run.status = "running";
        await t153Pass(p, 20_000);
        check("a followed run is kept in the tab's sessionStorage, with wall-clock deadlines",
            (() => { const w = JSON.parse(session.get("pwa.os.watch") ?? "[]")[0];
                return w?.id === 41 && w.phase === "run" && w.runUntil === T153_START + 45 * 60_000 && w.nextAt === T153_START + 30_000; })(),
            session.get("pwa.os.watch"));
        await t153Pass(p, 2 * 60_000);
        check("... and the page that's following it holds the overview's reload off (a reloaded page can't speak unprompted)",
            p.OS.busy() && p.reloadTick() === 0);
        // The admin reloads by hand (or leaves for another admin page and comes back in this tab).
        const reloaded = t150Boot({ startAt: p.win.Date.now(), session, get: srv.get });
        check("after a reload the run is still followed, its status kept", reloaded.OS.watching().length === 1 && reloaded.OS.watching()[0].id === 41
            && t153Line(reloaded) === "Waiting for the morning brief run (running)…", t153Line(reloaded));
        await t153Pass(reloaded, 4_000);
        check("... on the same 15 s beat: not polled again at once", reloaded.gets.length === 0, reloaded.gets);
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md" });
        srv.s.say = { status: 200, body: { date: "2026-10-22", source: "say", text: T153_SAY, status: "ok", generated: null } };
        await t153Pass(reloaded, 15_000);
        check("... and the brief is read by the reloaded page", t153Spoken(reloaded) === T153_SAY && !session.has("pwa.os.watch"),
            t153Spoken(reloaded));
    }
    {
        const session = new Map<string, string>();
        const { p, srv } = await t153Confirmed({ session, id: 42 });
        srv.s.run.status = "running";
        await t153Pass(p, 44 * 60_000);
        const reloaded = t150Boot({ startAt: p.win.Date.now(), session, get: srv.get });
        await t153Pass(reloaded, 59_000);
        check("reloads don't extend the 45 minutes: still followed at 44:59", reloaded.OS.watching().length === 1);
        await t153Pass(reloaded, 1_000);
        check("... and it gives up at 45:00 from the confirm", reloaded.OS.watching().length === 0
            && lastSpoken(reloaded.synth) === "The morning brief run hasn't finished after 45 minutes, so I've stopped waiting for it.");
    }
    {
        const session = new Map<string, string>();
        const { p, srv } = await t153Confirmed({ session, id: 43 });
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md" });
        await t153Pass(p, 15_000);
        await t153Pass(p, 10 * 60_000);
        const reloaded = t150Boot({ startAt: p.win.Date.now(), session, get: srv.get });
        check("a reload while waiting for the Say block carries on waiting for it",
            reloaded.OS.watching()[0]?.phase === "say" && t153Line(reloaded) === "The morning brief run finished. Waiting for the brief to reach the vault…");
        await t153Pass(reloaded, 5 * 60_000);
        check("... and still stops 15 minutes after the run finished", reloaded.OS.watching().length === 0
            && lastSpoken(reloaded.synth) === "The morning brief run finished, but the brief isn't in the vault yet, so I've stopped waiting for it.",
            lastSpoken(reloaded.synth));
    }
    for (const session of ["methods-throw", "none"] as const) {
        const { p, srv } = await t153Confirmed({ session });
        srv.s.run.status = "running";
        await t153Pass(p, 2 * 60_000);
        check(`sessionStorage ${session}: the run is still followed, and the reload held`, p.OS.watching().length === 1 && p.OS.busy() && p.reloadTick() === 0);
        Object.assign(srv.s.run, { status: "failed", summary: "boom" });
        await t153Pass(p, 15_000);
        check(`sessionStorage ${session}: the outcome is said, and only then may the page reload`,
            lastSpoken(p.synth) === "The morning brief run failed: boom." && p.OS.busy() && (p.synth.endAll(), !p.OS.busy()) && p.reloadTick() === 1);
    }
    {
        const { p, srv } = await t153Confirmed();
        srv.s.run.status = "queued";   // a runner that never comes (#170)
        await t153Pass(p, 45 * 60_000);
        p.synth.endAll();
        check("the hold on the reload never outlasts the 45 minutes", p.OS.watching().length === 0 && !p.OS.busy() && p.reloadTick() === 1);
    }
    {
        const { p, srv } = await t153Confirmed();
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md" });   // the Say endpoint keeps saying 404
        await t153Pass(p, 15_000 + 15 * 60_000 - 1_000);
        const heldAtTheEnd = p.OS.busy() && p.reloadTick() === 0;
        await t153Pass(p, 1_000);
        p.synth.endAll();
        check("... nor the 15 for the Say block", heldAtTheEnd && p.OS.watching().length === 0 && !p.OS.busy() && p.reloadTick() === 1);
    }
    for (const [what, stored] of [
        ["a deadline further off than 45 minutes (a skewed or tampered entry)",
            [{ id: 51, skill: "lint-wiki", phase: "run", runUntil: T153_START + 10 * 3600_000, sayUntil: null, date: null, nextAt: T153_START }]],
        ["a Say deadline further off than 15 minutes",
            [{ id: 52, skill: "morning-brief", phase: "say", runUntil: T153_START, sayUntil: T153_START + 3600_000, date: null, nextAt: T153_START }]],
        ["a watch whose deadline passed long ago (the tab came back hours later)",
            [{ id: 53, skill: "lint-wiki", phase: "run", runUntil: T153_START - 3600_000, sayUntil: null, date: null, nextAt: T153_START - 3600_000 }]],
        ["a skill that isn't runnable", [{ id: 54, skill: "rm -rf", phase: "run", runUntil: T153_START + 60_000, sayUntil: null, date: null, nextAt: T153_START }]],
        ["a bad date", [{ id: 55, skill: "morning-brief", phase: "say", runUntil: T153_START, sayUntil: T153_START + 60_000, date: "../x", nextAt: T153_START }]],
        ["not JSON", "{oops"],
        ["not a list", { id: 56 }],
    ] as const) {
        const session = new Map([["pwa.os.watch", typeof stored === "string" ? stored : JSON.stringify(stored)]]);
        let p: ReturnType<typeof t150Boot> | null = null, threw: unknown = null;
        try { p = t150Boot({ startAt: T153_START, session, get: () => ({ status: 200, body: { id: 51, skill: "lint-wiki", status: "running" } }) }); }
        catch (e) { threw = e; }
        if (!p) { check(`stored ${what}: the page boots`, false, String(threw)); continue; }
        await t153Pass(p, 60 * 60_000);
        check(`stored ${what}: dropped, never polled or spoken, and the page isn't held`,
            p.OS.watching().length === 0 && p.gets.length === 0 && p.synth.spoken.length === 0 && !p.OS.busy() && p.els["ask-watch"].hidden,
            { watching: p.OS.watching(), gets: p.gets });
    }
    {
        const session = new Map([["pwa.os.watch", JSON.stringify(
            [{ id: 57, skill: "lint-wiki", phase: "run", runUntil: T153_START + 10_000, sayUntil: null, date: null, nextAt: T153_START }])]]);
        const p = t150Boot({ startAt: T153_START, session, get: (url) => url.startsWith("/admin/os/api/runs/57?")
            ? { status: 200, body: { id: 57, skill: "lint-wiki", status: "running" } } : { status: 404, body: {} } });
        p.timers.advance(0); await flush();
        check("a stored watch that's due is polled as soon as the page loads", p.gets.length === 1 && p.OS.watching().length === 1, p.gets);
        await t153Pass(p, 15_000);
        check("... and keeps its stored deadline", p.OS.watching().length === 0
            && lastSpoken(p.synth) === "The lint wiki run hasn't finished after 45 minutes, so I've stopped waiting for it.");
    }

    // Closing the page ends it: nothing is pushed or spoken anywhere else.
    {
        const { p, srv } = await t153Confirmed({ id: 61 });
        await t153Pass(p, 15_000);
        // The tab closes (its timers never run again); its sessionStorage goes with it. A new tab starts clean.
        Object.assign(srv.s.run, { status: "succeeded", outputPath: "outputs/briefs/2026-10-22.md" });
        srv.s.say = { status: 200, body: { date: "2026-10-22", source: "say", text: T153_SAY, status: "ok", generated: null } };
        const newTab = t150Boot({ startAt: T153_START + 20 * 60_000, get: srv.get });
        await t153Pass(newTab, 60 * 60_000);
        check("a run confirmed in a tab that's since closed is never followed or spoken in a new one",
            newTab.gets.length === 0 && newTab.synth.spoken.length === 0 && newTab.els["ask-watch"].hidden);
        check("... and the page has no push, notification or background channel to speak through",
            !/serviceWorker|Notification|sendBeacon|EventSource|WebSocket|BroadcastChannel/.test(p.html));
        p.OS.unwatch("61");
        await t153Pass(p, 60 * 60_000);
        check("OS.unwatch(id) stops following, silently, and frees the page", p.OS.watching().length === 0 && p.gets.length === 1
            && lastSpoken(p.synth) === "Queued the morning brief." && !p.OS.busy());
    }
    {
        const p = t150Boot({ startAt: T153_START, synth: null, reply: t153Replies(71, "lint-wiki"),
            get: () => ({ status: 200, body: { id: 71, skill: "lint-wiki", status: "succeeded" } }) });
        p.submit("run the lint wiki"); await flush();
        p.els["ask-confirm-yes"].fire("click"); await flush();
        await t153Pass(p, 15_000);
        check("without speechSynthesis the outcome is still shown", t153Line(p) === "The lint wiki run finished." && !p.OS.busy());
    }

    // ── page scripts: no speechSynthesis ────────────────────────────────────
    {
        const p = t150Boot({ synth: null, reply: () => ({ tier: 1, kind: "navigate", say: "Opening Alpaca.", url: "/admin/alpaca" }) });
        check("without speechSynthesis the picker and stop stay hidden", p.els["ask-voice-row"].hidden && p.els["ask-stop"].hidden);
        p.submit("open alpaca"); await flush();
        check("... replies are still shown, and a navigation goes at once", p.say() === "Opening Alpaca."
            && p.win.location.href === "/admin/alpaca?token=tok" && !p.OS.speaking());
    }

    console.log(`\n  ${pass} passed, ${fail} failed\n`);
    process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
