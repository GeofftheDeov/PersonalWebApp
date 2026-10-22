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
} = {}) {
    const html = t150Render();
    const els = t150Dom(html);
    const timers = t150Timers();
    const synth = opts.synth === undefined ? t150Synth() : opts.synth;
    const store = opts.store ?? new Map<string, string>();
    const fetches: { url: string; body: any }[] = [];
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
            const body = JSON.parse(init.body);
            fetches.push({ url, body });
            const raw: any = opts.reply ? opts.reply(fetches.length, body) : { tier: 1, kind: "answer", say: "Up 412 dollars." };
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
            if (!opts.hold) return respond();
            return new Promise((resolve, reject) => { held.push(() => respond().then(resolve, reject)); });
        },
    };
    win.window = win;
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
    return { html, els, win, OS: win.OS, synth, timers, store, fetches, recs, say, display, submit, release, reloadDue };
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
        check(keeps ? "... and the proposal stays, so \"yes\" can try again" : "... and the proposal is gone",
            keeps ? p.OS.proposal()?.id === 101 && !p.els["ask-confirm"].hidden : p.OS.proposal() === null && p.els["ask-confirm"].hidden);
        if (keeps) {
            await t151Say(p, "yes");
            check("... and a second \"yes\" confirms it again", t151Confirms(p).length === 2 && t151Asks(p).length === 1);
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
