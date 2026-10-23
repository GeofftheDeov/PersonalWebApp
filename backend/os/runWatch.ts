/**
 * Saying "run my morning brief" ends with hearing it (#153 of spec #135, W3).
 *
 * After a confirmed run (OS.onConfirm, so a tap, a typed "yes" and a spoken
 * "yes" alike) the overview page follows the run and says how it went:
 *
 *   1. GET /admin/os/api/runs/:id every RUN_POLL_MS (15 s), for up to
 *      RUN_WATCH_MS (45 minutes, the server's STALE_AFTER) from the confirm.
 *   2. A morning brief that succeeded: GET /admin/os/api/brief/say for the day
 *      in its output path at once, then every 15 s for up to SAY_WATCH_MS
 *      (15 minutes; the vault reaches the server through Obsidian Git, which
 *      lags the run). A 404 (no brief yet), a 500, or a brief generated before
 *      the run started (an earlier brief the vault still holds; BRIEF_SLACK_MS
 *      allows for the PC's clock) all mean "look again". The Say text is spoken
 *      as is: V#11 writes it for speech.
 *   3. Any other skill that succeeded: "The lint wiki run finished."
 *      A failure: "The morning brief run failed: <the run's summary>."
 *      Running out of time, losing the session or the run: said too, once.
 *
 * Everything it says is also shown, in #ask-watch (a status line under the
 * reply), which also says what it's waiting for meanwhile.
 *
 * Never over the admin: an outcome waits while an ask or confirm is in flight,
 * the OS is speaking, the mic is listening or sending, or a run proposal is
 * waiting for an answer; it's spoken as soon as none of those hold (checked on
 * every activity change, and every second while waiting). If the admin cuts it
 * off (STOP, a new ask, the mic), it isn't repeated, and anything else waiting
 * to be said is dropped too (it stays shown).
 *
 * Reloads. The overview reloads itself every 15 s while a run is active and
 * every 2 minutes otherwise, unless OS.busy(). A watch counts as busy, so the
 * page that confirmed the run stays put until it has said the outcome: Chrome
 * only lets a page speak after the admin has interacted with it, and a
 * reloaded page hasn't been, so an outcome found after a reload would be shown
 * but not heard. The hold is bounded by the watch's own limits (45 minutes,
 * plus 15 for the Say block); meanwhile the status line, not the tiles, shows
 * the run's progress.
 *
 * A watch is also kept in sessionStorage (WATCH_STORAGE_KEY) with wall-clock
 * deadlines and the time of its next poll, so a reload the admin makes, or
 * leaving for another admin page and coming back in the same tab, picks it up
 * without extending a limit or polling faster. (Such a page can say the outcome
 * only once the admin has tapped or typed on it; it's always shown.)
 * sessionStorage belongs to the tab: nothing is ever said in another tab, and
 * closing the tab ends the watch (no push, no background speech). A stored
 * watch whose deadline is more than WATCH_GRACE_MS gone is dropped unspoken,
 * and one claiming a deadline further off than its limit is dropped as bad
 * data, so storage can never keep a watch, or the hold, alive. Storage that
 * can't be read or written just means no pick-up.
 *
 * window.OS gains:
 *   OS.watching()     the runs being followed: [{ id, skill, label, phase: 'run'|'say' }]
 *   OS.unwatch(id?)   stops following one run (or all of them); says nothing
 */
import { SKILLS } from "../services/agentRuns.js";

export const RUN_POLL_MS = 15_000;
/** How long to follow a run from its confirm: the server presumes a run dead after STALE_AFTER (45 minutes). */
export const RUN_WATCH_MS = 45 * 60_000;
/** How long to wait for a finished brief's Say block to reach the server's vault. */
export const SAY_WATCH_MS = 15 * 60_000;
/** A brief whose `generated` is this much before the run was claimed is an earlier one. */
export const BRIEF_SLACK_MS = 2 * 60_000;
/** A stored watch picked up this soon after its deadline still gets its "stopped waiting"; later ones are dropped unspoken. */
export const WATCH_GRACE_MS = 60_000;
/** Runs followed at once (one per skill can be queued or running). */
export const MAX_WATCHES = SKILLS.length;
export const WATCH_STORAGE_KEY = "pwa.os.watch";
/** How often an outcome waiting for the admin to finish looks again (activity changes also wake it). */
export const WATCH_RETRY_MS = 1_000;

/** Under the ask reply: what's being followed, then what was said. */
export const WATCH_LINE = `<div id="ask-watch" class="ask-watch" role="status" aria-live="polite" hidden></div>`;

export const WATCH_STYLES = `
        .ask-watch { color: #bbb; font-size: 0.8rem; line-height: 1.4; margin-top: 0.4rem; overflow-wrap: anywhere;
            border-left: 3px solid #444; padding-left: 0.6rem; }
        .ask-watch[hidden] { display: none; }
`;

/** The page script. Runs after the ask box's, the mic's and the voice's scripts. */
export function runWatchScript(token: string): string {
    const tokenJson = JSON.stringify(token).replace(/</g, "\\u003c");
    const labels = JSON.stringify(Object.fromEntries(SKILLS.map((k) => [k.id, k.label.toLowerCase()]))).replace(/</g, "\\u003c");
    return `
        (function () {
            var OS = window.OS;
            if (!OS) return;
            var token = ${tokenJson};
            var LABELS = ${labels};
            var BRIEF = 'morning-brief';
            var POLL = ${RUN_POLL_MS}, RUN_MS = ${RUN_WATCH_MS}, SAY_MS = ${SAY_WATCH_MS}, GRACE = ${WATCH_GRACE_MS};
            var SLACK = ${BRIEF_SLACK_MS}, MAX = ${MAX_WATCHES}, RETRY = ${WATCH_RETRY_MS}, KEY = ${JSON.stringify(WATCH_STORAGE_KEY)};
            var line = document.getElementById('ask-watch');

            // Each watch: { id, skill, phase: 'run'|'say', status, since, runUntil, sayUntil, date, nextAt }
            // (stored) plus timer and inFlight. since: when the run was claimed (else requested), server time, ms.
            var watches = [];
            // Outcomes waiting for the admin to finish, the timer that looks again, the last thing said,
            // and whether one of ours is being spoken (its done() hasn't run yet).
            var queue = [], retryTimer = null, note = '', talking = false;

            function now() { return Date.now(); }
            function withToken(path) { return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token); }
            function label(w) { return LABELS[w.skill]; }
            function num(v) { return typeof v === 'number' && isFinite(v); }
            function find(id) { for (var i = 0; i < watches.length; i++) if (watches[i].id === id) return watches[i]; return null; }

            // ── storage ──
            function session() { try { return window.sessionStorage || null; } catch (e) { return null; } }
            function save() {
                try {
                    var s = session();
                    if (!s) return;
                    if (watches.length) {
                        s.setItem(KEY, JSON.stringify(watches.map(function (w) {
                            return { id: w.id, skill: w.skill, phase: w.phase, status: w.status, since: w.since,
                                runUntil: w.runUntil, sayUntil: w.sayUntil, date: w.date, nextAt: w.nextAt };
                        })));
                    } else s.removeItem(KEY);
                } catch (e) { /* storage blocked: this page still follows the run, a reload won't */ }
            }
            // Watches a previous page in this tab left, if they're sound and still within their limits.
            function restore() {
                var list = null;
                try { var s = session(); list = s ? JSON.parse(s.getItem(KEY) || 'null') : null; } catch (e) { list = null; }
                if (!Array.isArray(list)) return;
                var t = now();
                list.forEach(function (w) {
                    if (!w || typeof w !== 'object' || !(w.id > 0) || Math.floor(w.id) !== w.id || !LABELS.hasOwnProperty(w.skill)) return;
                    if (w.phase !== 'run' && w.phase !== 'say') return;
                    if (!num(w.runUntil) || w.runUntil > t + RUN_MS) return;
                    if (w.phase === 'say' && (!num(w.sayUntil) || w.sayUntil > t + SAY_MS)) return;
                    if (t >= (w.phase === 'say' ? w.sayUntil : w.runUntil) + GRACE) return;
                    if (w.date !== null && w.date !== undefined && !/^\\d{4}-\\d{2}-\\d{2}$/.test(String(w.date))) return;
                    if (watches.length >= MAX || find(w.id)) return;
                    watches.push({ id: w.id, skill: w.skill, phase: w.phase, status: w.status === 'running' ? 'running' : w.status === 'queued' ? 'queued' : null,
                        since: num(w.since) ? w.since : null, runUntil: w.runUntil, sayUntil: w.phase === 'say' ? w.sayUntil : null,
                        date: w.date || null, nextAt: num(w.nextAt) ? Math.min(Math.max(w.nextAt, t), t + POLL) : t, timer: null, inFlight: false });
                });
                save();
                watches.forEach(schedule);
                render();
            }

            // ── the status line ──
            function describe(w) {
                if (w.phase === 'say') return 'The ' + label(w) + ' run finished. Waiting for the brief to reach the vault…';
                return 'Waiting for the ' + label(w) + ' run' + (w.status ? ' (' + w.status + ')' : '') + '…';
            }
            function render() {
                if (!line) return;
                var text = [note].concat(watches.map(describe)).filter(Boolean).join(' ');
                line.textContent = text;
                line.hidden = !text;
            }

            // ── following a run ──
            function schedule(w) {
                if (w.timer) clearTimeout(w.timer);
                w.timer = setTimeout(function () { w.timer = null; poll(w); }, Math.max(0, w.nextAt - now()));
            }
            function drop(w) {
                if (w.timer) { clearTimeout(w.timer); w.timer = null; }
                watches = watches.filter(function (x) { return x !== w; });
                save();
            }
            function finish(w, text) { drop(w); announce(text); }
            function again(w) {
                w.nextAt = now() + POLL;
                save(); render(); schedule(w);
            }

            // GET behind the admin gate: { status, body } (body null unless JSON), { status, gone: 'session'|'admin' },
            // or null when there was no answer.
            function getJson(path) {
                return fetch(withToken(path), { method: 'GET', redirect: 'manual', credentials: 'same-origin' }).then(function (res) {
                    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return { status: res.status, gone: 'session' };
                    if (res.status === 403) return { status: 403, gone: 'admin' };
                    if ((res.headers.get('content-type') || '').indexOf('application/json') < 0) return { status: res.status, body: null };
                    return res.json().then(function (body) { return { status: res.status, body: body }; }, function () { return { status: res.status, body: null }; });
                }).catch(function () { return null; });
            }

            // A run's summary as the end of a sentence.
            function sentence(s) {
                s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, 300).replace(/[\\s.,;:!?]+$/, '');
                return s ? s + '.' : '';
            }

            function poll(w) {
                if (find(w.id) !== w || w.inFlight) return;
                var t = now();
                if (w.phase === 'run' && t >= w.runUntil) {
                    return finish(w, 'The ' + label(w) + " run hasn't finished after 45 minutes, so I've stopped waiting for it.");
                }
                if (w.phase === 'say' && t >= w.sayUntil) {
                    return finish(w, "The " + label(w) + " run finished, but the brief isn't in the vault yet, so I've stopped waiting for it.");
                }
                w.inFlight = true;
                var path = w.phase === 'run' ? '/admin/os/api/runs/' + w.id
                    : '/admin/os/api/brief/say' + (w.date ? '?date=' + w.date : '');
                getJson(path).then(function (r) {
                    w.inFlight = false;
                    if (find(w.id) !== w) return;
                    if (r && r.gone) {
                        return finish(w, 'I stopped following the ' + label(w) + ' run: ' +
                            (r.gone === 'admin' ? 'this account is not an administrator.' : 'your session has expired.'));
                    }
                    if (w.phase === 'run') ranOn(w, r); else saidOn(w, r);
                });
            }

            // A server error (5xx, 408, 429) or no answer is worth another look; any other refusal isn't.
            function lookAgain(r) { return !r || r.status >= 500 || r.status === 408 || r.status === 429; }

            function ranOn(w, r) {
                var run = r && r.status === 200 && r.body && typeof r.body === 'object' ? r.body : null;
                if (!run) {
                    if (lookAgain(r)) return again(w);
                    if (r.status === 404) return finish(w, "I can't find the " + label(w) + ' run any more.');
                    return finish(w, "I couldn't check on the " + label(w) + " run, so I've stopped following it.");
                }
                var since = Date.parse(run.claimedAt || run.requestedAt || '');
                if (isFinite(since)) w.since = since;
                if (run.status === 'failed') {
                    var why = sentence(run.summary);
                    return finish(w, 'The ' + label(w) + ' run failed' + (why ? ': ' + why : '.'));
                }
                if (run.status !== 'succeeded') { w.status = run.status === 'running' ? 'running' : 'queued'; return again(w); }
                if (w.skill !== BRIEF) return finish(w, 'The ' + label(w) + ' run finished.');
                // The brief's day is the one in its output path; without one, the server's today.
                var m = /^outputs\\/briefs\\/(\\d{4}-\\d{2}-\\d{2})\\.md$/.exec(String(run.outputPath || ''));
                w.phase = 'say';
                w.date = m ? m[1] : null;
                w.sayUntil = now() + SAY_MS;
                w.nextAt = now();
                save(); render();
                poll(w);
            }

            function saidOn(w, r) {
                var brief = r && r.status === 200 && r.body && typeof r.body === 'object' ? r.body : null;
                if (brief) {
                    // An earlier brief for the day, still in the vault until this run's reaches it: look again.
                    var made = Date.parse(brief.generated || '');
                    if (isFinite(made) && num(w.since) && made < w.since - SLACK) return again(w);
                    var text = String(brief.text || '').trim();
                    return finish(w, text || 'The ' + label(w) + ' run finished, but the brief has nothing to read aloud.');
                }
                // 404: no brief yet (the vault hasn't caught up). 500, other server errors, no answer: look again.
                // But the server's own 503 (no vault configured) won't change.
                if ((lookAgain(r) && !(r && r.status === 503 && r.body)) || r.status === 404) return again(w);
                finish(w, 'The ' + label(w) + " run finished, but I can't read the brief here.");
            }

            // ── saying it, never over the admin ──
            function adminBusy() {
                var mic = OS.micState ? OS.micState() : 'idle';
                return OS.pending() || OS.speaking() || !!OS.proposal() || mic === 'listening' || mic === 'submitting';
            }
            function announce(text) {
                queue.push(text);
                note = text;
                render();
                drain();
            }
            function drain() {
                // While one of ours is being spoken, its done() decides what comes next.
                if (!queue.length || talking) return;
                if (adminBusy()) {
                    if (!retryTimer) retryTimer = setTimeout(function () { retryTimer = null; drain(); }, RETRY);
                    return;
                }
                var text = queue.shift();
                note = text;
                render();
                talking = true;
                OS.speak(text, function (cut) {
                    talking = false;
                    // Cut off by the admin (stop, a new ask, the mic): don't carry on talking.
                    if (cut) { queue = []; return; }
                    drain();
                });
            }
            OS.onActivity(drain);
            if (OS.onMicState) OS.onMicState(drain);

            OS.onConfirm(function (run) {
                var id = run && Number(run.id);
                if (!(id > 0) || Math.floor(id) !== id || !LABELS.hasOwnProperty(run.skill) || find(id)) return;
                // One per skill can be in flight: past that, the oldest gives way.
                while (watches.length >= MAX) drop(watches[0]);
                var t = now();
                var w = { id: id, skill: run.skill, phase: 'run', status: run.status === 'running' ? 'running' : 'queued', since: null,
                    runUntil: t + RUN_MS, sayUntil: null, date: null, nextAt: t + POLL, timer: null, inFlight: false };
                watches.push(w);
                note = '';
                save(); render(); schedule(w);
            });

            // A run being followed, or an outcome still to be said, holds the reload off (see the top of os/runWatch.ts).
            var busy = OS.busy;
            OS.busy = function () { return watches.length > 0 || queue.length > 0 || talking || busy(); };
            OS.watching = function () {
                return watches.map(function (w) { return { id: w.id, skill: w.skill, label: label(w), phase: w.phase }; });
            };
            OS.unwatch = function (id) {
                var all = id === undefined || id === null;
                watches.slice().forEach(function (w) { if (all || w.id === Number(id)) drop(w); });
                render();
            };

            restore();
        })();`;
}
