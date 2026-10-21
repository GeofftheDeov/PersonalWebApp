/**
 * The overview's mic (#149 of spec #135, W3): push to talk with the Web Speech
 * API (SpeechRecognition, or webkitSpeechRecognition). One press captures one
 * utterance; the interim transcript shows in the text box while speaking, and
 * the final transcript goes through the same path as typing,
 * OS.ask(text, 'voice'). Chrome sends the audio to Google's speech service;
 * that's accepted for now (spec #135).
 *
 * The page (os/page.ts) puts MIC_BUTTON in #ask-controls, MIC_NOTE under the
 * ask row and micScript() after the ask box's script, which it extends:
 *
 *   OS.listen()           starts capturing one utterance (cancelling speech in
 *                         progress, as the mic button does). false when the
 *                         browser can't recognise speech or it's already busy.
 *   OS.stopListening()    stops listening and sends what was heard (pressing the
 *                         mic again does this).
 *   OS.cancelListening()  stops listening and sends nothing (#150's stop button).
 *   OS.micState()         'unsupported' | 'idle' | 'listening' | 'submitting' | 'denied'.
 *   OS.onMicState(fn)     fn({ state, text, message }) on every change, interim
 *                         transcripts included.
 *   OS.onTranscript(fn)   fn(text) with each final transcript before it's asked.
 *                         Returning something truthy takes the utterance (it isn't
 *                         asked); a promise holds the mic busy until it settles.
 *                         #151 checks OS.proposal() here for a spoken yes or no.
 *   OS.busy()             now also true while listening or submitting, so the
 *                         page's reloads can't cut off speech capture.
 *
 * MIC_CONTROLLER_JS is the recognition state machine on its own, with no DOM,
 * so scripts/test-os-mic.ts can drive the shipped code with a fake recognition.
 */

/** Everything the mic says, in the note under the ask box. */
export const MIC_MESSAGES = {
    unsupported: "Voice input isn't available in this browser. Type your ask instead.",
    denied: "Microphone access is blocked for this site. To fix it, open the site settings from the icon at the left "
        + "of the address bar, set Microphone to Allow, then press MIC again. You can still type.",
    listening: "Listening… press MIC again to send.",
    noSpeech: "I didn't catch that. Press MIC and try again.",
    noMic: "No microphone was found. Check one is connected, or type instead.",
    network: "Speech recognition needs a network connection. Try again, or type instead.",
    failed: "Voice input didn't work. Try again, or type instead.",
} as const;

/** Longest a single press listens before it stops by itself, and how long to wait for the browser to end it after a stop. */
export const MIC_MAX_MS = 15_000;
export const MIC_GRACE_MS = 3_000;

/** Goes inside #ask-controls; hidden until the script knows the browser can recognise speech. */
export const MIC_BUTTON = `<button id="ask-mic" class="ask-mic" type="button" aria-label="Speak your ask" aria-pressed="false" hidden>MIC</button>`;

/** Under the ask row: the unsupported note, "Listening…", and errors such as denied permission. */
export const MIC_NOTE = `<div id="ask-mic-note" class="ask-mic-note" role="status" aria-live="polite" hidden></div>`;

/**
 * createMic(opts) → controller. A function expression, as source, so the page
 * and the test run the same code. opts:
 *   Recognition   the SpeechRecognition constructor, or null (unsupported)
 *   lang          recognition language
 *   messages      MIC_MESSAGES
 *   ask(text)     sends a final transcript; may return a promise
 *   onSent(text, result)  after ask (or a transcript hook) settles; result is
 *                 the ask's value (null when it failed) or the hook's
 *   onChange(snapshot)    on every change
 *   setTimeout, clearTimeout, maxMs, graceMs   for tests
 * Controller: start(), stop(), abort(), toggle(), state(), snapshot(), busy(),
 * onTranscript(fn), onState(fn).
 */
export const MIC_CONTROLLER_JS = String.raw`function createMic(opts) {
    var Rec = opts.Recognition || null, M = opts.messages;
    var setT = opts.setTimeout || setTimeout, clearT = opts.clearTimeout || clearTimeout;
    var maxMs = opts.maxMs || ${MIC_MAX_MS}, graceMs = opts.graceMs || ${MIC_GRACE_MS};
    var state = Rec ? 'idle' : 'unsupported', message = Rec ? '' : M.unsupported, text = '';
    // Each press is a session; events from an older recognition are ignored.
    var session = 0, rec = null, error = null, cap = null, grace = null;
    var transcriptHooks = [], stateHooks = [];

    function snapshot() { return { state: state, text: text, message: message }; }
    function set(s, msg) {
        state = s; message = msg || '';
        var snap = snapshot();
        if (opts.onChange) { try { opts.onChange(snap); } catch (e) { console.error(e); } }
        stateHooks.forEach(function (fn) { try { fn(snapshot()); } catch (e) { console.error(e); } });
    }
    function clearTimers() {
        if (cap) { clearT(cap); cap = null; }
        if (grace) { clearT(grace); grace = null; }
    }
    function messageFor(code) {
        if (code === 'not-allowed' || code === 'service-not-allowed') return M.denied;
        if (code === 'no-speech') return M.noSpeech;
        if (code === 'audio-capture') return M.noMic;
        if (code === 'network') return M.network;
        return M.failed;
    }

    function start() {
        if (state === 'unsupported' || state === 'listening' || state === 'submitting') return false;
        var id = ++session, r;
        text = ''; error = null;
        try {
            r = new Rec();
            r.lang = opts.lang || 'en-US';
            r.continuous = false;       // one utterance per press
            r.interimResults = true;
            r.maxAlternatives = 1;
            r.onresult = function (e) {
                if (id !== session || state !== 'listening') return;
                var heard = '';
                for (var i = 0; i < e.results.length; i++) heard += (e.results[i][0] && e.results[i][0].transcript) || '';
                text = heard.replace(/\s+/g, ' ').trim();
                set('listening', M.listening);
            };
            r.onerror = function (e) { if (id === session) error = (e && e.error) || 'unknown'; };
            r.onend = function () { finish(id); };
            rec = r;
            set('listening', M.listening);
            r.start();
        } catch (e) {
            console.error(e);
            rec = null; session++;
            set('idle', M.failed);
            return false;
        }
        cap = setT(function () { if (id === session) stop(); }, maxMs);
        return true;
    }

    // The utterance is over: the browser ended it, or it never did after a stop.
    function finish(id) {
        if (id !== session || state !== 'listening') return;
        clearTimers(); rec = null;
        if (error === 'aborted') return set('idle');
        if (error) return set(error === 'not-allowed' || error === 'service-not-allowed' ? 'denied' : 'idle', messageFor(error));
        if (!text) return set('idle', M.noSpeech);
        submit(text);
    }

    function submit(said) {
        set('submitting');
        var handled = false, result;
        for (var i = 0; i < transcriptHooks.length && !handled; i++) {
            try { result = transcriptHooks[i](said); handled = !!result; } catch (e) { console.error(e); }
        }
        var id = session;
        function done(value) {
            if (id !== session || state !== 'submitting') return;
            set('idle');
            if (opts.onSent) { try { opts.onSent(said, value); } catch (e) { console.error(e); } }
        }
        var p;
        try { p = handled ? result : opts.ask(said); } catch (e) { console.error(e); p = null; }
        Promise.resolve(p).then(function (v) { done(v === undefined ? null : v); }, function (e) { console.error(e); done(null); });
    }

    // Stop listening and send what was heard once the browser ends the utterance.
    function stop() {
        if (state !== 'listening' || !rec) return false;
        var id = session;
        if (cap) { clearT(cap); cap = null; }
        try { rec.stop(); } catch (e) { /* already stopping */ }
        if (!grace) grace = setT(function () { grace = null; finish(id); }, graceMs);
        return true;
    }

    // Stop listening and send nothing.
    function abort() {
        if (state !== 'listening') return false;
        var r = rec;
        clearTimers(); rec = null; session++;
        try { if (r) r.abort(); } catch (e) { /* already ended */ }
        set('idle');
        return true;
    }

    return {
        start: start, stop: stop, abort: abort,
        toggle: function () { return state === 'listening' ? stop() : start(); },
        state: function () { return state; },
        snapshot: snapshot,
        busy: function () { return state === 'listening' || state === 'submitting'; },
        onTranscript: function (fn) { transcriptHooks.push(fn); },
        onState: function (fn) { stateHooks.push(fn); },
    };
}`;

/** The page script: wires createMic to the DOM and extends window.OS. Runs after the ask box's script. */
export function micScript(): string {
    const messagesJson = JSON.stringify(MIC_MESSAGES).replace(/</g, "\\u003c");
    return `
        (function () {
            var OS = window.OS;
            var btn = document.getElementById('ask-mic'), note = document.getElementById('ask-mic-note');
            var input = document.getElementById('ask-text'), form = document.getElementById('ask-form');
            if (!OS || !btn || !note || !input) return;
            var createMic = ${MIC_CONTROLLER_JS};
            var Rec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
            var placeholder = input.placeholder;
            var mic = createMic({
                Recognition: Rec,
                lang: (window.navigator && navigator.language) || 'en-US',
                messages: ${messagesJson},
                ask: function (text) { return OS.ask(text, 'voice'); },
                // Clear the box once the utterance was answered or taken; a failed
                // ask leaves the transcript there to edit and send again.
                onSent: function (text, result) { if (result && input.value === text) input.value = ''; },
                onChange: render,
            });

            function render(s) {
                btn.hidden = s.state === 'unsupported';
                btn.disabled = s.state === 'submitting';
                btn.setAttribute('aria-pressed', s.state === 'listening' ? 'true' : 'false');
                btn.setAttribute('data-state', s.state);
                if (s.state === 'listening') {
                    // Typed text survives a press that hears nothing.
                    if (s.text) input.value = s.text;
                    input.placeholder = 'Listening…';
                } else {
                    input.placeholder = placeholder;
                }
                note.textContent = s.message;
                note.hidden = !s.message;
                note.setAttribute('data-state', s.state);
            }
            render(mic.snapshot());

            function listen() {
                if (mic.state() === 'unsupported' || mic.busy()) return false;
                OS.cancelSpeech();   // don't capture the OS's own voice
                return mic.start();
            }

            btn.addEventListener('click', function () { if (mic.state() === 'listening') mic.stop(); else listen(); });
            // ASK while listening sends the box as typed; the mic lets go.
            if (form) form.addEventListener('submit', function () { mic.abort(); });

            var busy = OS.busy;
            OS.busy = function () { return mic.busy() || busy(); };
            OS.listen = listen;
            OS.stopListening = mic.stop;
            OS.cancelListening = mic.abort;
            OS.micState = mic.state;
            OS.onMicState = mic.onState;
            OS.onTranscript = mic.onTranscript;
        })();`;
}

export const MIC_STYLES = `
        .ask-row .ask-mic { background: transparent; color: #0d9488; border: 1px solid #0d9488; min-width: 44px; min-height: 44px; }
        .ask-row .ask-mic[hidden] { display: none; }
        .ask-row .ask-mic[aria-pressed="true"] { background: #f97316; border-color: #f97316; color: #000; }
        .ask-row .ask-mic:disabled { background: transparent; border-color: #444; color: #777; }
        .ask-mic-note { color: #bbb; font-size: 0.8rem; line-height: 1.4; margin-top: 0.4rem; overflow-wrap: anywhere; }
        .ask-mic-note[hidden] { display: none; }
        .ask-mic-note[data-state="denied"] { color: #fab219; }
`;
