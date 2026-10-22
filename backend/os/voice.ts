/**
 * The overview's speech playback (#150 of spec #135, W3): the OS never talks
 * over the admin. Replies are spoken with speechSynthesis (and always shown as
 * text too); a stop button cuts speech off, a new ask cancels anything still
 * being spoken, and the admin can pick the voice, remembered on this device.
 *
 * Two pieces, both shipped as source so scripts/test-os-speech.ts runs the
 * same code the page does:
 *
 *   SPEAKER_JS     the speech engine, createSpeaker(opts), with no DOM. The ask
 *                  box's script (os/page.ts) builds OS.speak and
 *                  OS.cancelSpeech on it.
 *   voiceScript()  the stop button and the voice picker. Runs after the mic's
 *                  script (os/mic.ts) and extends window.OS:
 *
 *   OS.stop()             what the stop button does: stops listening (sends
 *                         nothing), cuts off speech, drops a navigation waiting
 *                         on its "Opening …", and silences the reply to an ask
 *                         still in flight (it's shown, not spoken or acted on).
 *                         true when there was something to stop.
 *   OS.voices()           the voices on offer, [{ id, name, lang }]; [] until
 *                         the browser has loaded them.
 *   OS.voice()            the chosen SpeechSynthesisVoice, or null for the
 *                         browser's default (also when the saved one isn't on
 *                         this device). The speaker reads it for each speak().
 *   OS.setVoice(id)       choose by voiceURI (or name); null or '' is the
 *                         default. Saved in localStorage under VOICE_STORAGE_KEY.
 *                         false when no such voice is on offer.
 *
 * Every localStorage read and write is in try/catch: with storage blocked the
 * picker still works for the page's lifetime.
 */

/** Where the chosen voice's voiceURI (or name, when it has none) is kept on this device. */
export const VOICE_STORAGE_KEY = "pwa.os.voice";

/**
 * Long text is spoken as a queue of utterances of at most this many characters,
 * split at sentence ends where it can be. Chrome's network voices stop after
 * about 15 seconds of a single utterance, without an end event.
 */
export const SPEECH_CHUNK_CHARS = 180;

/**
 * When a browser never reports the end of speech, the speaker gives up waiting
 * after max(SPEECH_MIN_WAIT_MS, SPEECH_MS_PER_CHAR × length): done() runs (a
 * navigation goes ahead) and the page stops counting as speaking.
 */
export const SPEECH_MIN_WAIT_MS = 3_000;
export const SPEECH_MS_PER_CHAR = 100;

/** How often, and how many times, to look for voices in a browser that never fires voiceschanged. */
export const VOICE_POLL_MS = 250;
export const VOICE_POLL_TRIES = 8;

/**
 * createSpeaker(opts) → speaker. A function expression, as source, so the page
 * and the test run the same code. opts:
 *   synth, Utterance   window.speechSynthesis and SpeechSynthesisUtterance (or null: no speech)
 *   voice()            the voice to use, or null for the default; read on each speak
 *   onChange(speaking) when speech starts or stops
 *   setTimeout, clearTimeout   for tests
 * Speaker:
 *   speak(text, done?)  cuts off anything still being spoken, then speaks text.
 *                       done(cut) runs exactly once: cut is true when it was cut
 *                       off (cancel() or another speak()), false when it ended,
 *                       failed, there's no speech, or the wait ran out.
 *   cancel()            cuts off speech in progress. true when there was some.
 *   speaking()          true from speak() until done.
 */
export const SPEAKER_JS = String.raw`function createSpeaker(opts) {
    var synth = opts.synth || null, Utt = opts.Utterance || null;
    var setT = opts.setTimeout || setTimeout, clearT = opts.clearTimeout || clearTimeout;
    var MAX = ${SPEECH_CHUNK_CHARS}, MIN_WAIT = ${SPEECH_MIN_WAIT_MS}, PER_CHAR = ${SPEECH_MS_PER_CHAR};
    // What's being spoken now: { finish, utterances }. Holding the utterances
    // also stops Chrome garbage-collecting them before their end event fires.
    var current = null;

    function changed() {
        if (opts.onChange) { try { opts.onChange(!!current); } catch (e) { console.error(e); } }
    }

    // Text → utterance-sized pieces, split after sentence-ending punctuation
    // followed by a space (so "0.4" stays whole), else at the last space.
    function chunks(text) {
        var parts = text.split(/([.!?]+\s+)/), out = [], cur = '';
        function push(s) { s = s.trim(); if (s) out.push(s); }
        for (var i = 0; i < parts.length; i += 2) {
            var s = parts[i] + (parts[i + 1] || '');
            if (cur && (cur + s).length > MAX) { push(cur); cur = ''; }
            cur += s;
            while (cur.length > MAX) {
                var at = cur.lastIndexOf(' ', MAX);
                if (at <= 0) at = MAX;
                push(cur.slice(0, at)); cur = cur.slice(at);
            }
        }
        push(cur);
        return out;
    }

    function cancel() {
        var c = current;
        current = null;
        // Some browsers fire the cancelled utterances' error events inside
        // cancel(): they mustn't report the cut as a failure.
        if (c) c.cutting = true;
        try { if (synth) synth.cancel(); } catch (e) { /* nothing to cancel */ }
        if (c) c.finish(true);
        return !!c;
    }

    function speak(text, done) {
        cancel();
        text = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
        var ended = false, timer = null;
        var me = { active: false, cutting: false, utterances: [], finish: finish };
        function finish(cut) {
            if (ended) return;
            ended = true;
            if (timer) { clearT(timer); timer = null; }
            if (current === me) current = null;
            if (me.active) { me.active = false; changed(); }
            if (done) { try { done(!!cut); } catch (e) { console.error(e); } }
        }
        if (!synth || !Utt || !text) { finish(false); return; }
        try {
            var voice = opts.voice ? opts.voice() : null;
            var pieces = chunks(text);
            current = me; me.active = true;
            // A speechSynthesis left paused (Chrome, after the tab was hidden) queues forever.
            if (synth.paused && synth.resume) synth.resume();
            pieces.forEach(function (piece, i) {
                var u = new Utt(piece);
                if (voice) { u.voice = voice; if (voice.lang) u.lang = voice.lang; }
                u.onend = function () { if (i === pieces.length - 1) finish(false); };
                // A failure (not our own cancel, which has already finished it)
                // ends the whole reply: drop the rest of the queue.
                u.onerror = function () {
                    if (ended || me.cutting) return;
                    if (current === me) { current = null; try { synth.cancel(); } catch (e) { /* gone */ } }
                    finish(false);
                };
                me.utterances.push(u);
                synth.speak(u);
            });
            timer = setT(function () { timer = null; finish(false); }, Math.max(MIN_WAIT, PER_CHAR * text.length));
            changed();
        } catch (e) {
            console.error(e);
            if (current === me) current = null;
            finish(false);
        }
    }

    return { speak: speak, cancel: cancel, speaking: function () { return !!current; }, chunks: chunks };
}`;

/** Goes inside #ask-controls, beside the mic; shown only while there's something to stop. */
export const STOP_BUTTON = `<button id="ask-stop" class="ask-stop" type="button" aria-label="Stop speaking and listening" hidden>STOP</button>`;

/** At the end of the ask box; hidden until the browser has voices to offer. */
export const VOICE_PICKER = `
                    <div id="ask-voice-row" class="ask-voice" hidden>
                        <label for="ask-voice">Voice</label>
                        <select id="ask-voice"><option value="">Default voice</option></select>
                    </div>`;

/** The page script: the stop button and the voice picker. Runs after the ask box's and the mic's scripts. */
export function voiceScript(): string {
    return `
        (function () {
            var OS = window.OS;
            var stopBtn = document.getElementById('ask-stop');
            var row = document.getElementById('ask-voice-row'), select = document.getElementById('ask-voice');
            if (!OS) return;
            var KEY = ${JSON.stringify(VOICE_STORAGE_KEY)};
            var synth = null;
            try { synth = window.speechSynthesis || null; } catch (e) { synth = null; }

            // ── stop ──
            function listening() {
                var s = OS.micState ? OS.micState() : 'unsupported';
                return s === 'listening' || s === 'submitting';
            }
            function stop() {
                var any = OS.speaking() || OS.pending() || listening();
                if (OS.cancelListening) OS.cancelListening();
                OS.cancelSpeech();
                return any;
            }
            function syncStop() { if (stopBtn) stopBtn.hidden = !(OS.speaking() || OS.pending() || listening()); }
            if (stopBtn) stopBtn.addEventListener('click', function () { stop(); syncStop(); });
            OS.onActivity(syncStop);
            if (OS.onMicState) OS.onMicState(syncStop);
            syncStop();

            // ── voice ──
            function stored() {
                try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
            }
            function store(id) {
                try {
                    if (id) window.localStorage.setItem(KEY, id); else window.localStorage.removeItem(KEY);
                } catch (e) { /* storage blocked: the choice lasts until the page reloads */ }
            }
            function idOf(v) { return v.voiceURI || v.name || ''; }

            var voices = [], wanted = stored(), chosen = null;
            function find(id) {
                if (!id) return null;
                for (var i = 0; i < voices.length; i++) if (voices[i].voiceURI === id) return voices[i];
                for (var j = 0; j < voices.length; j++) if (voices[j].name === id) return voices[j];
                return null;
            }

            // Voices in the page's language first, then the rest, each in the browser's order.
            function load() {
                var list = [];
                try { list = synth ? Array.prototype.slice.call(synth.getVoices() || []) : []; } catch (e) { list = []; }
                var lang = String((window.navigator && navigator.language) || 'en').slice(0, 2).toLowerCase();
                function mine(v) { return String(v.lang || '').slice(0, 2).toLowerCase() === lang; }
                voices = list.filter(mine).concat(list.filter(function (v) { return !mine(v); }));
                chosen = find(wanted);
                if (!select || !row) return;
                // Nothing to offer (yet): the rendered "Default voice" option stays, hidden.
                if (!voices.length) { row.hidden = true; return; }
                while (select.firstChild) select.removeChild(select.firstChild);
                var def = document.createElement('option');
                def.value = ''; def.textContent = 'Default voice';
                select.appendChild(def);
                voices.forEach(function (v) {
                    var o = document.createElement('option');
                    o.value = idOf(v);
                    o.textContent = v.name + (v.lang ? ' (' + v.lang + ')' : '');
                    select.appendChild(o);
                });
                // A saved voice that isn't on this device (yet) shows as the default but stays saved.
                select.value = chosen ? idOf(chosen) : '';
                row.hidden = false;
            }

            function setVoice(id) {
                id = id ? String(id) : '';
                var v = find(id);
                if (id && !v) return false;
                wanted = v ? idOf(v) : null;
                chosen = v;
                store(wanted);
                if (select) select.value = wanted || '';
                return true;
            }

            if (select) select.addEventListener('change', function () {
                if (!setVoice(select.value)) return;
                // A short sample, so picking by ear works; never over the mic.
                if (!listening()) OS.speak(chosen ? 'This is ' + chosen.name + '.' : 'This is the default voice.');
            });

            if (synth) {
                try {
                    if (synth.addEventListener) synth.addEventListener('voiceschanged', load);
                    else {
                        var prev = synth.onvoiceschanged;
                        synth.onvoiceschanged = function (e) { if (prev) prev.call(this, e); load(); };
                    }
                } catch (e) { /* no event: the poll below covers it */ }
            }
            load();
            // Some browsers never fire voiceschanged: look again a few times.
            var tries = 0;
            (function poll() {
                if (voices.length || !synth || tries++ >= ${VOICE_POLL_TRIES}) return;
                setTimeout(function () { load(); poll(); }, ${VOICE_POLL_MS});
            })();

            OS.stop = stop;
            OS.voices = function () { return voices.map(function (v) { return { id: idOf(v), name: v.name, lang: v.lang }; }); };
            OS.voice = function () { return chosen; };
            OS.setVoice = setVoice;
        })();`;
}

export const VOICE_STYLES = `
        .ask-row .ask-stop { background: #f97316; color: #000; border: 0; min-width: 44px; min-height: 44px; }
        .ask-row .ask-stop[hidden] { display: none; }
        .ask-voice { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; color: #888; font-size: 0.75rem; }
        .ask-voice[hidden] { display: none; }
        .ask-voice select { flex: 0 1 auto; min-width: 0; max-width: 100%; background: #111; color: #ddd; border: 1px solid #444;
            font: inherit; font-size: 0.8rem; padding: 0.2rem 0.3rem; min-height: 32px; text-overflow: ellipsis; }
        .ask-voice select:focus { outline: 2px solid #0d9488; outline-offset: -1px; }
        @media (max-width: 800px) { .ask-voice select { flex: 1 1 auto; min-height: 44px; font-size: 1rem; } }
`;
