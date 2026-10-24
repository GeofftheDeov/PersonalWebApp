/**
 * The overview's mic (#149 of spec #135, W3): voice input with the Web Speech
 * API (SpeechRecognition, or webkitSpeechRecognition). With a mouse, a click
 * starts listening and the next click sends; with touch, listening lasts while
 * the finger is on MIC and letting go sends. Pauses don't end a press: when the
 * browser ends a recognition by itself (silence, its own time limit), a fresh
 * one carries on, so only the user (or MIC_MAX_MS) ends it. The interim
 * transcript shows in the text box while speaking, and the whole transcript
 * goes through the same path as typing, OS.ask(text, 'voice'). Chrome sends the
 * audio to Google's speech service; that's accepted for now (spec #135).
 *
 * The page (os/page.ts) puts MIC_BUTTON in #ask-controls, MIC_NOTE under the
 * ask row and micScript() after the ask box's script, which it extends:
 *
 *   OS.listen(hold)       starts listening (cancelling speech in progress, as
 *                         the mic button does) until OS.stopListening(); hold
 *                         words the note for a touch press ("let go of MIC").
 *                         false when the browser can't recognise speech or
 *                         it's already busy.
 *   OS.stopListening()    stops listening and sends what was heard (pressing the
 *                         mic again does this).
 *   OS.cancelListening()  stops listening and sends nothing (#150's stop button).
 *   OS.micState()         'unsupported' | 'idle' | 'listening' | 'submitting' | 'denied'.
 *   OS.onMicState(fn)     fn({ state, text, message }) on every change, interim
 *                         transcripts included.
 *   OS.onTranscript(fn)   fn(text) with each final transcript before it's asked.
 *                         Returning something truthy takes the utterance (it isn't
 *                         asked); a promise holds the mic busy until it settles.
 *                         (A spoken yes or no to a pending proposal needs no
 *                         hook: OS.ask answers it in the page, #151.)
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
    serviceDenied: "Speech recognition isn't allowed here. Check the microphone is allowed for this site (site settings, "
        + "from the icon at the left of the address bar); on an iPhone, also turn on Siri & Dictation. You can still type.",
    listening: "Listening… press MIC again to send.",
    listeningHold: "Listening… let go of MIC to send.",
    noSpeech: "I didn't catch that. Press MIC and try again.",
    noSpeechHold: "I didn't catch that. Hold MIC while you speak, then let go.",
    noMic: "No microphone was found. Check one is connected, or type instead.",
    network: "Speech recognition needs a network connection. Try again, or type instead.",
    failed: "Voice input didn't work. Try again, or type instead.",
} as const;

/**
 * Longest a single press listens before it stops by itself and sends (a mic left
 * on), how long to wait for the browser to end it after a stop, and how many
 * recognitions in a row may end with nothing heard before the press gives up
 * (the browser ends a silent one after about 8 s; this also keeps one that
 * ends at once from restarting forever).
 */
export const MIC_MAX_MS = 5 * 60_000;
export const MIC_GRACE_MS = 3_000;
export const MIC_MAX_QUIET = 8;

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
 *   setTimeout, clearTimeout, maxMs, graceMs, maxQuiet   for tests
 * Controller: start(hold), stop(), abort(), toggle(), clearMessage(), state(),
 * snapshot(), busy(), onTranscript(fn), onState(fn).
 */
export const MIC_CONTROLLER_JS = String.raw`function createMic(opts) {
    var Rec = opts.Recognition || null, M = opts.messages;
    var setT = opts.setTimeout || setTimeout, clearT = opts.clearTimeout || clearTimeout;
    var maxMs = opts.maxMs || ${MIC_MAX_MS}, graceMs = opts.graceMs || ${MIC_GRACE_MS};
    var maxQuiet = opts.maxQuiet || ${MIC_MAX_QUIET};
    var state = Rec ? 'idle' : 'unsupported', message = Rec ? '' : M.unsupported, text = '';
    // Each press is a session, which may run through several recognitions;
    // events from an older press or recognition are ignored. heard is the text
    // of the press's earlier recognitions, said whether this one heard any, and
    // quiet how many in a row heard nothing.
    var session = 0, rec = null, error = null, cap = null, grace = null;
    var heard = '', said = false, quiet = 0, stopping = false, hold = false;
    var transcriptHooks = [], stateHooks = [];

    function snapshot() { return { state: state, text: text, message: message }; }
    function set(s, msg) {
        state = s; message = msg || '';
        var snap = snapshot();
        if (opts.onChange) { try { opts.onChange(snap); } catch (e) { console.error(e); } }
        stateHooks.forEach(function (fn) { try { fn(snap); } catch (e) { console.error(e); } });
    }
    function clearTimers() {
        if (cap) { clearT(cap); cap = null; }
        if (grace) { clearT(grace); grace = null; }
    }
    // A recognition error code → [state, message]. A browser-raised 'aborted'
    // (another app took the mic) lands on failed; abort() never gets here.
    function outcomeFor(code) {
        if (code === 'not-allowed') return ['denied', M.denied];
        if (code === 'service-not-allowed') return ['denied', M.serviceDenied];
        return ['idle', messageFor(code)];
    }
    function messageFor(code) {
        if (code === 'no-speech') return M.noSpeech;
        if (code === 'audio-capture') return M.noMic;
        if (code === 'network') return M.network;
        return M.failed;
    }

    // hold: a touch press, which ends when the finger lets go (only the wording differs).
    function start(holding) {
        if (state === 'unsupported' || state === 'listening' || state === 'submitting') return false;
        var id = ++session;
        text = ''; heard = ''; quiet = 0; stopping = false; hold = !!holding;
        if (!open(id)) return false;
        cap = setT(function () { if (id === session) stop(); }, maxMs);
        return true;
    }

    // Starts a recognition for press id: its first, or (again) the next after the
    // browser ended one by itself. false if it can't: the first leaves the mic
    // idle with the failure, a later one sends what was heard.
    function open(id, again) {
        var r;
        error = null; said = false;
        try {
            r = new Rec();
            r.lang = opts.lang || 'en-US';
            // Through pauses. Not for touch: Chrome on Android repeats earlier
            // results in continuous mode, and ended() restarting does the same job.
            r.continuous = !hold;
            r.interimResults = true;
            r.maxAlternatives = 1;
            r.onresult = function (e) {
                if (id !== session || r !== rec || state !== 'listening') return;
                var now = '';
                for (var i = 0; i < e.results.length; i++) now += (e.results[i][0] && e.results[i][0].transcript) || '';
                if (now.trim()) said = true;
                text = (heard + ' ' + now).replace(/\s+/g, ' ').trim();
                set('listening', listeningMessage());
            };
            r.onerror = function (e) { if (id === session && r === rec) error = (e && e.error) || 'unknown'; };
            r.onend = function () { if (r === rec) ended(id); };
            rec = r;
            if (state !== 'listening') set('listening', listeningMessage());
            r.start();
        } catch (e) {
            console.error(e);
            rec = null;
            if (again) { finish(id); return false; }
            session++;
            set('idle', M.failed);
            return false;
        }
        return true;
    }

    function listeningMessage() { return hold ? M.listeningHold : M.listening; }

    // A recognition ended. After a stop, or an error other than silence, the
    // press is over; otherwise the browser ended it by itself, and listening
    // carries on with a fresh one, keeping what was heard.
    function ended(id) {
        if (id !== session || state !== 'listening') return;
        quiet = said ? 0 : quiet + 1;
        if (stopping || (error && error !== 'no-speech') || quiet >= maxQuiet) return finish(id);
        heard = text;
        open(id, true);
    }

    // The press is over: stopped and ended, it never ended after a stop, an
    // error, or too long with nothing heard.
    function finish(id) {
        if (id !== session || state !== 'listening') return;
        clearTimers(); rec = null;
        session++;   // done with this press: ignore anything else its recognition sends
        if (error && error !== 'no-speech') { var o = outcomeFor(error); return set(o[0], o[1]); }
        if (!text) return set('idle', hold ? M.noSpeechHold : M.noSpeech);
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

    // Stop listening and send what was heard once the browser ends the recognition.
    function stop() {
        if (state !== 'listening' || !rec) return false;
        var id = session;
        stopping = true;
        if (cap) { clearT(cap); cap = null; }
        try { rec.stop(); } catch (e) { /* already stopping */ }
        // Some browsers never end a stopped recognition: finish without it, and
        // abort it so the microphone is released.
        if (!grace) grace = setT(function () {
            var r = rec;
            grace = null; finish(id);
            try { if (r) r.abort(); } catch (e) { /* already ended */ }
        }, graceMs);
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

    // Drops a leftover note ("I didn't catch that", the permission help) once
    // the user has moved on, e.g. by typing an ask.
    function clearMessage() {
        if ((state === 'idle' || state === 'denied') && message) set('idle');
    }

    return {
        start: start, stop: stop, abort: abort, clearMessage: clearMessage,
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
    // JSON in a <script>: no "<" (it could close the tag) and no raw line or paragraph separators.
    const messagesJson = JSON.stringify(MIC_MESSAGES)
        .replace(new RegExp("[<" + String.fromCharCode(0x2028, 0x2029) + "]", "g"), (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
    return `
        (function () {
            var OS = window.OS;
            var btn = document.getElementById('ask-mic'), note = document.getElementById('ask-mic-note');
            var input = document.getElementById('ask-text'), form = document.getElementById('ask-form');
            if (!OS || !btn || !note || !input) return;
            var createMic = ${MIC_CONTROLLER_JS};
            var send = document.getElementById('ask-send');
            var Rec = window.SpeechRecognition || window.webkitSpeechRecognition || null;
            var placeholder = input.placeholder;
            // What was in the box when the press began; put back if nothing is sent.
            var draft = null, last = 'idle';
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
                    if (s.text) input.value = s.text;
                    input.placeholder = 'Listening…';
                } else {
                    input.placeholder = placeholder;
                    // Ended without sending (nothing heard, an error, a cancel): the typed draft comes back.
                    if (last === 'listening' && s.state !== 'submitting' && draft !== null) input.value = draft;
                    draft = null;
                }
                last = s.state;
                note.textContent = s.message;
                note.hidden = !s.message;
                note.setAttribute('data-state', s.state);
            }
            render(mic.snapshot());

            // An ask or confirm in flight would drop the utterance (OS.ask refuses while pending).
            function inFlight() { return !!(send && send.disabled); }

            function listen(hold) {
                if (mic.state() === 'unsupported' || mic.busy() || inFlight()) return false;
                OS.cancelSpeech();   // don't capture the OS's own voice
                draft = input.value;
                return mic.start(hold);
            }

            // A mouse (or the keyboard) clicks MIC to start and again to send. A
            // finger holds it: listening from touch-down until it lets go, and the
            // click the browser sends after that touch is ignored.
            var holding = false, touched = false;
            btn.addEventListener('pointerdown', function (e) {
                touched = e.pointerType !== 'mouse';
                if (!touched) return;
                e.preventDefault();
                if (mic.state() === 'listening') { mic.stop(); return; }
                holding = listen(true);
                // Keep getting this finger's events even if it slides off MIC.
                if (holding && btn.setPointerCapture) { try { btn.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } }
            });
            function release() { if (holding) { holding = false; mic.stop(); } }
            btn.addEventListener('pointerup', release);
            btn.addEventListener('pointercancel', release);
            // A long press would otherwise open the browser's menu.
            btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
            btn.addEventListener('click', function () {
                if (touched) { touched = false; return; }
                if (mic.state() === 'listening') mic.stop(); else listen();
            });
            // ASK (or Enter, which clicks it) while listening sends the speech as voice, not the box as typed.
            if (send) send.addEventListener('click', function (e) {
                if (mic.state() === 'listening') { e.preventDefault(); mic.stop(); }
            });
            if (form) form.addEventListener('submit', function () {
                // Anything else that submits while listening: the box goes as typed and the mic lets go.
                if (!mic.abort()) mic.clearMessage();
            });
            // Confirm or Cancel while listening: the tap wins.
            ['ask-confirm-yes', 'ask-confirm-no'].forEach(function (id) {
                var b = document.getElementById(id);
                if (b) b.addEventListener('click', function () { mic.abort(); });
            });

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
        .ask-row .ask-mic { background: transparent; color: #0d9488; border: 1px solid #0d9488; min-width: 44px; min-height: 44px;
            touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
        .ask-row .ask-mic[hidden] { display: none; }
        .ask-row .ask-mic[aria-pressed="true"] { background: #f97316; border-color: #f97316; color: #000; }
        .ask-row .ask-mic:disabled { background: transparent; border-color: #444; color: #777; }
        .ask-mic-note { color: #bbb; font-size: 0.8rem; line-height: 1.4; margin-top: 0.4rem; overflow-wrap: anywhere; }
        .ask-mic-note[hidden] { display: none; }
        .ask-mic-note[data-state="denied"] { color: #fab219; }
`;
