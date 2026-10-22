import { renderPage } from "../utils/adminUi.js";
import { centralTime, esc } from "./format.js";
import { ADMIN_PAGES } from "./commands.js";
import { MIC_BUTTON, MIC_NOTE, MIC_STYLES, micScript } from "./mic.js";
import { PROPOSAL_REPLY_JS } from "./proposalReply.js";
import { SPEAKER_JS, STOP_BUTTON, VOICE_PICKER, VOICE_STYLES, voiceScript } from "./voice.js";
import { WATCH_LINE, WATCH_STYLES, runWatchScript } from "./runWatch.js";
import { describeError, type Overview, type Tile, type TileSource, type ViewContext } from "./overview.js";

/** The page reloads itself this often while it's visible. */
export const OVERVIEW_REFRESH_MS = 2 * 60_000;

export interface OverviewPageOptions {
    token: string;
    now: Date;
    overview: Overview;
    sources: readonly TileSource<any>[];
    /** Overrides OVERVIEW_REFRESH_MS (#142: faster while a run is queued or running). */
    refreshMs?: number;
}

const unavailableBody = (reason: string) => `
    <div class="unavail"><span class="unavail-tag">UNAVAILABLE</span> ${esc(reason)}</div>`;

function renderTile(source: TileSource<any>, tile: Tile | undefined, view: ViewContext): string {
    const state: Tile = tile ?? { status: "unavailable", reason: "not built" };
    let body: string;
    let status = state.status;
    if (state.status === "ok") {
        try { body = source.render(state, view); }
        catch (err) {
            console.error(`[os] tile ${source.id} render failed:`, (err as any)?.message ?? err);
            status = "unavailable";
            body = unavailableBody(`could not render: ${describeError(err)}`);
        }
    } else {
        body = unavailableBody(state.reason);
    }
    // A tile whose data carries `stale: boolean` gets the flag; the label and
    // icon carry it, never colour alone.
    const stale = status === "ok" && (state as any).stale === true;
    return `
        <section class="tile tile-${status}" data-tile="${esc(source.id)}" data-status="${status}" data-stale="${stale}">
            <header class="tile-head">
                <a class="tile-title" href="${esc(view.link(source.href))}">${esc(source.title)} <span aria-hidden="true">→</span></a>
                ${stale ? `<span class="badge badge-warn" title="This data is older than it should be">⚠ STALE</span>` : ""}
            </header>
            <div class="tile-body">${body}</div>
        </section>`;
}

/**
 * The ask box (#146). Typed asks go through the same path as voice: the mic
 * (#149) and the stop button (#150) go in #ask-controls and call window.OS;
 * the voice picker (#150) sits at the end.
 */
const ASK_BOX = `
                <form id="ask-form" class="ask" autocomplete="off">
                    <label for="ask-text" class="sr-only">Ask the OS</label>
                    <div class="ask-row">
                        <span id="ask-controls" class="ask-controls">${MIC_BUTTON}${STOP_BUTTON}</span>
                        <input id="ask-text" name="text" type="text" maxlength="500" enterkeyhint="send"
                            placeholder="Ask, e.g. “open alpaca” or “show the briefs”">
                        <button id="ask-send" type="submit">ASK</button>
                    </div>
                    ${MIC_NOTE}
                    <div id="ask-reply" class="ask-reply" aria-live="polite" hidden>
                        <div class="ask-say"></div>
                        <div class="ask-display muted"></div>
                        <div id="ask-confirm" class="ask-confirm" hidden>
                            <button id="ask-confirm-yes" type="button">CONFIRM</button>
                            <button id="ask-confirm-no" type="button">CANCEL</button>
                        </div>
                    </div>
                    ${WATCH_LINE}${VOICE_PICKER}
                </form>`;

/**
 * The ask box's client. It exposes window.OS for the pieces that plug in later:
 *
 *   OS.ask(text, source)  POST /admin/os/ask; shows, speaks and acts on the reply.
 *                         The mic (#149) calls OS.ask(transcript, 'voice').
 *   OS.speak(text, done?) speaks with speechSynthesis in the chosen voice (#150),
 *                         cutting off anything still being spoken. Long text is
 *                         queued in sentence-sized pieces (os/voice.ts). done(cut)
 *                         runs once: cut is true when stop, a new ask or another
 *                         speak() cut it off. Speaking over a navigation's
 *                         "Opening …" drops that navigation.
 *   OS.cancelSpeech()     stops speech in progress, drops a navigation still
 *                         waiting on its "Opening …", and silences the reply to an
 *                         ask or confirm in flight: it's shown, not spoken, and a
 *                         navigation in it isn't followed (the request isn't
 *                         aborted: a confirm already sent still queues its run).
 *                         A new ask cancels speech too.
 *   OS.speaking()         true while the OS is speaking (#150).
 *   OS.pending()          true while an ask or confirm is in flight (#150).
 *   OS.onActivity(fn)     fn() whenever speaking() or pending() changes (#150).
 *   OS.onReply(fn)        fn(reply) after each reply is shown, before it's spoken.
 *   OS.busy()             true while there's unsent text, an ask or confirm in
 *                         flight, speech, a pending navigation or a pending
 *                         proposal; the reload holds off.
 *
 * Run proposals (#148). A `confirm_run` reply shows Confirm and Cancel until
 * it's answered, a new ask replaces it, or it expires (at its expiresAt; the
 * server has the last word with a 410):
 *
 *   OS.proposal()         the pending confirmation { id, skill, label, expiresAt },
 *                         or null.
 *   OS.confirm()          POST /admin/os/ask/confirm for the pending proposal;
 *                         shows and speaks the outcome. Resolves to the response
 *                         body { run, created, say }, or null.
 *   OS.dismiss()          Cancel: client-side only, the proposal just expires.
 *                         Returns false when nothing was pending.
 *   OS.onConfirm(fn)      fn(run, body) after a confirm queues (or finds) the run,
 *                         before the outcome is spoken. os/runWatch.ts (#153)
 *                         follows the run from here and says how it went.
 *
 * Answering by voice or text (#151). OS.ask() reads a short reply to a pending
 * proposal itself (os/proposalReply.ts), so the mic's transcript and the text
 * box take the same path, and neither reaches the router while one is pending:
 *
 *   yes / confirm / do it / go ahead …   OS.confirm(); resolves to its body, or
 *                                        after a 404, 409 or 410 to { kind: 'error',
 *                                        say }, or null when the proposal is
 *                                        still up to try again (a 500).
 *   no / cancel / stop / never mind …    OS.dismiss(); resolves to
 *                                        { kind: 'cancelled', say: 'Cancelled.' }.
 *   anything else                        asked as usual; the new ask abandons
 *                                        the proposal (it expires on the server).
 *
 * After a proposal lapses (the page's timer, or a 410), a "yes" before any
 * other ask says it expired instead of reaching the router, and resolves to
 * { kind: 'expired', say }. With nothing pending at all, "yes" and "no" go to
 * the router, which answers "Nothing to confirm." / "Nothing to cancel." at tier 1.
 *
 * The JSON API sits behind the HTML gate: an expired token comes back as a
 * redirect to login and a non-admin as an HTML 403, never a JSON error.
 */
function askScript(token: string): string {
    // JSON in a <script>: escape "<" so the token can't close the tag.
    const tokenJson = JSON.stringify(token).replace(/</g, "\\u003c");
    const pagesJson = JSON.stringify(ADMIN_PAGES.map((p) => p.path)).replace(/</g, "\\u003c");
    return `
        (function () {
            var token = ${tokenJson};
            // Navigation only ever goes to an allowlisted admin page (os/commands.ts ADMIN_PAGES).
            var PAGES = ${pagesJson};
            var form = document.getElementById('ask-form'), input = document.getElementById('ask-text');
            var send = document.getElementById('ask-send'), out = document.getElementById('ask-reply');
            var sayEl = out.querySelector('.ask-say'), displayEl = out.querySelector('.ask-display');
            var pending = false, hooks = [], confirmHooks = [], activityHooks = [];
            // Stop pressed while an ask or confirm was in flight: its reply is shown, not spoken or acted on.
            var hushed = false;
            var confirmBox = document.getElementById('ask-confirm');
            var yesBtn = document.getElementById('ask-confirm-yes'), noBtn = document.getElementById('ask-confirm-no');
            // The run proposal waiting for Confirm or Cancel, and its expiry timer.
            var proposal = null, proposalTimer = null;
            // A proposal lapsed (its timer ran out, or the server said 410) and nothing has been asked since.
            var lapsed = false;
            var EXPIRED = 'That proposal expired. Ask again to run it.';
            // 'confirm', 'cancel' or null for a short reply to a proposal (#151, os/proposalReply.ts).
            var proposalReply = ${PROPOSAL_REPLY_JS};
            // The navigation waiting for its "Opening …" to finish; a new ask or a stop drops it.
            var leaving = null;

            function withToken(path) { return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token); }

            function show(say, display, kind) {
                out.hidden = false;
                out.setAttribute('data-kind', kind || '');
                sayEl.textContent = say || '';
                displayEl.textContent = display || '';
            }

            function activity() { activityHooks.forEach(function (fn) { try { fn(); } catch (e) { console.error(e); } }); }
            function setPending(on) { pending = on; send.disabled = on; activity(); }

            // Speech (#150): os/voice.ts createSpeaker, in the voice the picker chose.
            var synth = null, Utt = null;
            try { synth = window.speechSynthesis || null; Utt = window.SpeechSynthesisUtterance || null; } catch (e) { /* no speech */ }
            var createSpeaker = ${SPEAKER_JS};
            var speaker = createSpeaker({
                synth: synth, Utterance: Utt,
                voice: function () { return window.OS && typeof window.OS.voice === 'function' ? window.OS.voice() : null; },
                onChange: activity,
            });

            // Stop: silence, drop a navigation still waiting on its "Opening …", and
            // hush the reply to anything in flight.
            function cancelSpeech() {
                leaving = null;
                if (pending) hushed = true;
                speaker.cancel();
            }

            // Speaks text, cutting off anything still being spoken. done(cut) runs once:
            // when speech ends or fails, when the wait for its end runs out, at once
            // without speech, or with cut = true when it's cut off.
            function speak(text, done) { speaker.speak(text, done); }

            // A reply's speech: nothing when stop hushed it.
            function say(text, done) {
                if (hushed) { if (done) done(true); return; }
                speak(text, done);
            }

            // Shows (c) or clears (null) the pending proposal's Confirm and Cancel.
            function setProposal(c) {
                if (proposalTimer) { clearTimeout(proposalTimer); proposalTimer = null; }
                proposal = c || null;
                if (proposal) lapsed = false;
                confirmBox.hidden = !proposal;
                yesBtn.disabled = noBtn.disabled = false;
                if (!proposal) return;
                var ms = Date.parse(proposal.expiresAt) - Date.now();
                // A skewed client clock: fall back to the full two minutes; the server still says 410.
                if (!(ms > 0 && ms <= 120000)) ms = 120000;
                proposalTimer = setTimeout(function () {
                    if (proposal !== c) return;
                    setProposal(null);
                    lapsed = true;
                    show(sayEl.textContent, 'Expired. Ask again to run it.', 'expired');
                }, ms);
            }

            function handle(reply) {
                show(reply.say, reply.display, reply.kind);
                setProposal(reply.kind === 'confirm_run' && reply.confirmation ? reply.confirmation : null);
                hooks.forEach(function (fn) { try { fn(reply); } catch (e) { console.error(e); } });
                if (reply.kind === 'navigate' && PAGES.indexOf(reply.url) >= 0) {
                    if (hushed) { show(reply.say, 'Stopped.', reply.kind); return; }
                    var trip = leaving = { url: reply.url };
                    say(reply.say, function (cut) {
                        if (leaving !== trip) return;
                        // Cut off (stop, a new ask, another speak()): stay on the page.
                        if (cut) leaving = null; else location.href = withToken(trip.url);
                    });
                } else {
                    say(reply.say);
                }
            }

            function fail(message) { show(message, '', 'error'); say(message); }

            // POSTs JSON behind the admin gate. Resolves to { status, ok, body }, or to
            // null once a failure (expired session, not an admin, no JSON, no server) is shown.
            function postJson(path, payload) {
                return fetch(withToken(path), {
                    method: 'POST', redirect: 'manual', credentials: 'same-origin',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                }).then(function (res) {
                    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
                        fail('Your session has expired. Sign in again.'); return null;
                    }
                    if (res.status === 403) { fail('This account is not an administrator.'); return null; }
                    var json = (res.headers.get('content-type') || '').indexOf('application/json') >= 0;
                    if (!json) { fail('The request failed (status ' + res.status + ').'); return null; }
                    return res.json().then(function (body) { return { status: res.status, ok: res.ok, body: body }; });
                }).catch(function () {
                    fail("Couldn't reach the server."); return null;
                });
            }

            function ask(text, source) {
                // 500 characters as the server counts them (code points; never half an emoji).
                text = Array.from(String(text || '').trim()).slice(0, 500).join('');
                if (!text || pending) return Promise.resolve(null);
                // A short yes or no to a pending (or just lapsed) proposal is answered here, not by the router.
                var answer = proposalReply(text);
                if (proposal && answer === 'confirm') {
                    return confirm().then(function (body) {
                        // A final refusal (404, 409, 410) is an answer too, so the box clears;
                        // anything that leaves the proposal up (a 500) keeps the "yes" to try again.
                        return body || (proposal ? null : { kind: 'error', say: sayEl.textContent });
                    });
                }
                if (proposal && answer === 'cancel') {
                    dismiss();
                    return Promise.resolve({ kind: 'cancelled', say: 'Cancelled.' });
                }
                if (lapsed && answer === 'confirm') {
                    cancelSpeech();
                    hushed = false;
                    show(EXPIRED, '', 'expired');
                    say(EXPIRED);
                    return Promise.resolve({ kind: 'expired', say: EXPIRED });
                }
                lapsed = false;
                cancelSpeech();
                hushed = false;
                // A new ask abandons a pending proposal; it just expires on the server.
                setProposal(null);
                setPending(true);
                show('…', '', 'pending');
                return postJson('/admin/os/ask', { text: text, source: source === 'voice' ? 'voice' : 'typed' }).then(function (r) {
                    if (!r) return null;
                    if (!r.ok) { fail(r.body && r.body.error ? 'Sorry: ' + r.body.error + '.' : 'The ask failed.'); return null; }
                    handle(r.body);
                    return r.body;
                }).then(function (reply) {
                    setPending(false);
                    return reply;
                });
            }

            // Confirm: queue the pending proposal's run.
            function confirm() {
                var p = proposal;
                if (!p || pending) return Promise.resolve(null);
                cancelSpeech();
                hushed = false;
                setPending(true); yesBtn.disabled = noBtn.disabled = true;
                show('…', '', 'pending');
                return postJson('/admin/os/ask/confirm', { id: p.id }).then(function (r) {
                    if (!r) return null;
                    // 404, 409 and 410 are final; anything else (a 500) leaves the proposal to try again.
                    var final = r.ok || r.status === 404 || r.status === 409 || r.status === 410;
                    if (final && proposal === p) setProposal(null);
                    if (r.status === 410 && !proposal) lapsed = true;
                    if (!r.ok) {
                        fail(r.status === 410 ? EXPIRED
                            : r.status === 409 ? 'That run was already confirmed.'
                            : r.status === 404 ? 'Nothing to confirm.'
                            : "Sorry, the run couldn't be queued. Try again.");
                        return null;
                    }
                    show(r.body.say, '', 'confirmed');
                    confirmHooks.forEach(function (fn) { try { fn(r.body.run, r.body); } catch (e) { console.error(e); } });
                    say(r.body.say);
                    return r.body;
                }).then(function (body) {
                    setPending(false);
                    if (proposal === p) yesBtn.disabled = noBtn.disabled = false;
                    return body;
                });
            }

            // Cancel: client-side only; the proposal expires on the server.
            function dismiss() {
                if (!proposal || pending) return false;
                setProposal(null);
                show('Cancelled.', '', 'cancelled');
                speak('Cancelled.');
                return true;
            }

            yesBtn.addEventListener('click', function () { confirm(); });
            noBtn.addEventListener('click', function () { dismiss(); });

            form.addEventListener('submit', function (e) {
                e.preventDefault();
                ask(input.value, 'typed').then(function (reply) { if (reply) input.value = ''; });
            });

            window.OS = {
                ask: ask, speak: speak, cancelSpeech: cancelSpeech,
                speaking: speaker.speaking,
                pending: function () { return pending; },
                onActivity: function (fn) { activityHooks.push(fn); },
                onReply: function (fn) { hooks.push(fn); },
                confirm: confirm, dismiss: dismiss,
                proposal: function () {
                    return proposal ? { id: proposal.id, skill: proposal.skill, label: proposal.label, expiresAt: proposal.expiresAt } : null;
                },
                onConfirm: function (fn) { confirmHooks.push(fn); },
                // Speech counts as busy, so a reload never cuts a reply off; the
                // speaker's own wait bounds it if the browser never ends speech.
                busy: function () {
                    return pending || speaker.speaking() || !!leaving || !!proposal || input.value.trim() !== '';
                },
            };
        })();`;
}

/** /admin/os: the tiles through the shared admin shell. Server-rendered; no chart library, no CDN scripts. */
export function renderOverviewPage({ token, now, overview, sources, refreshMs = OVERVIEW_REFRESH_MS }: OverviewPageOptions): string {
    const view: ViewContext = {
        now,
        link: (path) => `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`,
    };
    const tiles = sources.map((s) => renderTile(s, overview.tiles[s.id], view)).join("");
    // Never let a bad interval turn the reload timer into a busy loop.
    const every = Number.isFinite(refreshMs) && refreshMs >= 5000 ? Math.round(refreshMs) : OVERVIEW_REFRESH_MS;

    const content = `
        <div class="os-layout">
            <div class="os-inner">
                <div class="os-head">
                    <div class="os-title">AGENTIC OS</div>
                    <div class="muted">updated ${esc(centralTime(new Date(overview.generatedAt), now))}</div>
                </div>
                ${ASK_BOX}
                <div class="os-tiles">${tiles}</div>
            </div>
        </div>
        <script>${askScript(token)}</script>
        <script>${micScript()}</script>
        <script>${voiceScript()}</script>
        <script>${runWatchScript(token)}</script>
        <script>
        // Reload while the page is visible; catch up as soon as a hidden tab comes back.
        // Never while the ask box is in use (typing, waiting, or speaking a reply).
        (function () {
            var every = ${every}, loaded = Date.now();
            function tick() {
                if (window.OS && window.OS.busy()) return;
                if (document.visibilityState === 'visible' && Date.now() - loaded >= every) location.reload();
            }
            setInterval(tick, Math.min(every, 5000));
            document.addEventListener('visibilitychange', tick);
        })();
        </script>`;

    const extraStyles = `
        /* The shared admin shell centres a 100vh flex body, which pushes anything
           taller than the viewport off the top: pin the page below the nav and
           scroll inside it. */
        .os-layout { width: 100%; height: calc(100vh - 60px); height: calc(100dvh - 60px); overflow-y: auto;
            box-sizing: border-box; padding: 1.5rem; position: relative; z-index: 95; }
        .os-inner { max-width: 1100px; margin: 0 auto; }
        .os-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1rem; gap: 1rem; }
        .os-title { color: #0d9488; font-weight: bold; letter-spacing: 3px; }
        .os-tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
        @media (max-width: 800px) {
            .os-layout { padding: 1rem; }
            .os-tiles { grid-template-columns: 1fr; }
        }
        .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        .ask { margin-bottom: 1rem; }
        .ask-row { display: flex; gap: 0.5rem; align-items: stretch; }
        .ask-controls { display: contents; }
        .ask-row input { flex: 1; min-width: 0; background: #111; color: #fff; border: 1px solid #444;
            padding: 0.6rem 0.75rem; font: inherit; font-size: 1rem; }
        .ask-row input:focus { outline: 2px solid #0d9488; outline-offset: -1px; border-color: #0d9488; }
        .ask-row button { background: #0d9488; color: #000; border: 0; padding: 0 1rem; font: inherit;
            font-weight: bold; letter-spacing: 1px; }
        .ask-row button:disabled { background: #444; color: #999; }
        .ask-reply { border-left: 3px solid #0d9488; background: #1e1e1e; padding: 0.6rem 0.9rem; margin-top: 0.5rem; }
        .ask-reply[data-kind="error"], .ask-reply[data-kind="unavailable"] { border-left-color: #fab219; }
        .ask-reply[data-kind="not_understood"] { border-left-color: #666; }
        .ask-say { color: #fff; font-size: 0.95rem; line-height: 1.4; overflow-wrap: anywhere; }
        .ask-display:empty { display: none; }
        .ask-display { margin-top: 0.3rem; }
        .ask-reply[data-kind="confirm_run"] { border-left-color: #f97316; }
        .ask-confirm { display: flex; gap: 0.5rem; margin-top: 0.6rem; flex-wrap: wrap; }
        .ask-confirm[hidden] { display: none; }
        .ask-confirm button { font: inherit; font-weight: bold; letter-spacing: 1px; padding: 0 1.1rem; min-height: 44px; }
        #ask-confirm-yes { background: #0d9488; color: #000; border: 0; }
        #ask-confirm-no { background: transparent; color: #ddd; border: 1px solid #555; }
        .ask-confirm button:disabled { opacity: 0.5; }
        ${MIC_STYLES}
        ${VOICE_STYLES}
        ${WATCH_STYLES}
        .tile { border: 1px solid #333; background: #1e1e1e; padding: 1rem 1.25rem; min-width: 0; box-sizing: border-box; }
        .tile-head { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
        .tile-title { color: #0d9488; font-size: 0.75rem; letter-spacing: 2px; font-weight: bold; text-transform: uppercase; text-decoration: none; }
        .tile-title:hover { color: #fff; }
        .badge { font-size: 0.65rem; padding: 0.1rem 0.45rem; letter-spacing: 1px; font-weight: bold; white-space: nowrap; }
        .badge-warn { background: #fab219; color: #000; }
        .stat-label { color: #aaa; font-size: 0.8rem; }
        .stat-value { color: #fff; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; font-weight: 600;
            font-size: 2.25rem; line-height: 1.2; overflow-wrap: anywhere; }
        .stat-delta { color: #e0e0e0; font-size: 0.95rem; margin-top: 0.25rem; }
        .dir { font-size: 0.75rem; margin-right: 0.15rem; }
        .dir-up { color: #0d9488; } .dir-down { color: #f97316; } .dir-flat { color: #666; }
        .stat-meta { color: #888; font-size: 0.75rem; margin-top: 0.6rem; }
        /* The usage tile's per-run cost sparkline (#145): scales to the tile's width, so it
           reads in the one-column phone layout; strokes stay 2px/1px at any scale. */
        .spark { display: block; width: 100%; max-width: 480px; height: auto; margin-top: 0.75rem; }
        .spark * { vector-effect: non-scaling-stroke; }
        .spark-base { stroke: #333; stroke-width: 1; }
        .spark-line { fill: none; stroke: #777; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; pointer-events: none; }
        .spark-hit { fill: transparent; }
        .spark-pt:hover .spark-hit { fill: rgba(255, 255, 255, 0.08); }
        .spark-dot { fill: #aaa; stroke: #1e1e1e; stroke-width: 2; pointer-events: none; }
        .spark-last .spark-dot { fill: #0d9488; }
        .spark-failed .spark-dot { fill: #1e1e1e; stroke: #aaa; stroke-width: 1.5; }
        .spark-last.spark-failed .spark-dot { stroke: #0d9488; }
        .spark-cap { margin-top: 0.3rem; }
        .spark-runs { margin-top: 0.3rem; }
        .spark-runs summary { color: #888; font-size: 0.75rem; cursor: pointer; }
        .spark-scroll { overflow-x: auto; }
        .spark-runs table { border-collapse: collapse; font-size: 0.75rem; color: #ccc; margin-top: 0.3rem; }
        .spark-runs th { color: #888; font-weight: normal; text-align: left; }
        .spark-runs th, .spark-runs td { padding: 0.1rem 0.75rem 0.1rem 0; white-space: nowrap; }
        .spark-runs .num { text-align: right; font-variant-numeric: tabular-nums; }
        .task-counts { color: #aaa; font-size: 0.8rem; margin-bottom: 0.5rem; }
        .task-counts b { color: #fff; font-size: 0.95rem; }
        .task-count.warn b { color: #fab219; }
        .task-clear { color: #0d9488; font-weight: 600; font-size: 1.5rem; line-height: 1.3; }
        .task-list { list-style: none; margin: 0; padding: 0; }
        .task-list li { color: #e0e0e0; font-size: 0.9rem; line-height: 1.4; padding: 0.2rem 0; overflow-wrap: anywhere; }
        .task-list a { color: #e0e0e0; }
        .task-list a:hover { color: #fff; }
        .task-tag { background: #fab219; color: #000; font-size: 0.6rem; letter-spacing: 1px; font-weight: bold; padding: 0.05rem 0.3rem; }
        .task-more { margin-top: 0.3rem; }
        .warn { color: #fab219; }
        .muted { color: #777; font-size: 0.75rem; }
        .unavail { color: #bbb; font-size: 0.85rem; line-height: 1.5; overflow-wrap: anywhere; }
        .unavail-tag { display: inline-block; background: #444; color: #ddd; font-size: 0.65rem; letter-spacing: 1px;
            padding: 0.05rem 0.4rem; margin-right: 0.3rem; font-weight: bold; }
    `;

    return renderPage({ token, title: "Agentic OS", activePage: "os", content, extraStyles, deviceWidth: true });
}
