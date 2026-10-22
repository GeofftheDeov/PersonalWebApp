/**
 * Saying "run my morning brief" ends with hearing it (#153 of spec #135, W3).
 *
 * After a confirmed run (OS.onConfirm, so a tap, a typed "yes" and a spoken
 * "yes" alike) the overview page follows the run and says how it went:
 *
 *   1. GET /admin/os/api/runs/:id every RUN_POLL_MS (15 s), for up to
 *      RUN_WATCH_MS (45 minutes, the server's STALE_AFTER) from the confirm.
 *   2. A morning brief that succeeded: GET /admin/os/api/brief/say for the day
 *      in its output path every 15 s, for up to SAY_WATCH_MS (15 minutes; the
 *      vault reaches the server through Obsidian Git, which lags the run), and
 *      a 404 (no brief yet) or a 500 just means "look again". The Say text is
 *      spoken as is: V#11 writes it for speech.
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
 * Reloads. The overview reloads itself every 15 s while a run is active, and
 * every 2 minutes otherwise, holding off only while OS.busy(). Rather than hold
 * the page (and its tiles) for up to an hour, a watch is kept in
 * sessionStorage under WATCH_STORAGE_KEY with wall-clock deadlines and the time
 * of its next poll, and picked up again by the reloaded page: the reload never
 * extends a limit or speeds up polling. sessionStorage belongs to the tab, so
 * nothing is ever said in another tab, and closing the tab ends the watch (no
 * push, no background speech). Coming back to /admin/os in the same tab within
 * the limits picks the watch up again. A stored watch whose deadline is more
 * than WATCH_GRACE_MS gone is dropped unspoken, and one claiming a deadline
 * further off than its limit is dropped as bad data, so storage can never pin
 * the page or keep a watch alive. When storage can't be written (blocked, a
 * private window) the watch counts as busy instead, so the reload waits for it;
 * its deadlines bound that too.
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
            var MAX = ${MAX_WATCHES}, RETRY = ${WATCH_RETRY_MS}, KEY = ${JSON.stringify(WATCH_STORAGE_KEY)};
            var line = document.getElementById('ask-watch');

            // Each watch: { id, skill, phase: 'run'|'say', runUntil, sayUntil, date, nextAt } (all stored),
            // plus timer and inFlight (not).
            var watches = [];
            // The last write to sessionStorage worked: a reload will pick the watches up.
            var stored = true;
            // Outcomes waiting for the admin to finish, the timer that looks again, and the last thing said.
            var queue = [], retryTimer = null, note = '';

            function now() { return Date.now(); }
            function withToken(path) { return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token); }
            function label(w) { return LABELS[w.skill]; }

            // ── storage ──
            function session() { try { return window.sessionStorage || null; } catch (e) { return null; } }
            function save() {
                var s = session();
                try {
                    if (!s) throw new Error('no sessionStorage');
                    if (watches.length) {
                        s.setItem(KEY, JSON.stringify(watches.map(function (w) {
                            return { id: w.id, skill: w.skill, phase: w.phase, runUntil: w.runUntil, sayUntil: w.sayUntil, date: w.date, nextAt: w.nextAt };
                        })));
                    } else s.removeItem(KEY);
                    stored = true;
                } catch (e) { stored = false; }
            }
            function num(v) { return typeof v === 'number' && isFinite(v); }
            // Watches a previous load of this tab left, if they're sound and still within their limits.
            function restore() {
                var s = session(), list = null;
                try { list = s ? JSON.parse(s.getItem(KEY) || 'null') : null; } catch (e) { list = null; }
                if (!Array.isArray(list)) return;
                var t = now();
                list.forEach(function (w) {
                    if (!w || typeof w !== 'object' || !(w.id > 0) || Math.floor(w.id) !== w.id || !LABELS.hasOwnProperty(w.skill)) return;
                    if (w.phase !== 'run' && w.phase !== 'say') return;
                    if (!num(w.runUntil) || w.runUntil > t + RUN_MS) return;
                    if (w.phase === 'say' && (!num(w.sayUntil) || w.sayUntil > t + SAY_MS)) return;
                    if (t >= (w.phase === 'say' ? w.sayUntil : w.runUntil) + GRACE) return;
                    if (w.date !== null && !/^\\d{4}-\\d{2}-\\d{2}$/.test(String(w.date))) return;
                    if (watches.length >= MAX || find(w.id)) return;
                    var nextAt = num(w.nextAt) ? Math.min(Math.max(w.nextAt, t), t + POLL) : t;
                    watches.push({ id: w.id, skill: w.skill, phase: w.phase, runUntil: w.runUntil,
                        sayUntil: w.phase === 'say' ? w.sayUntil : null, date: w.date || null, nextAt: nextAt, timer: null, inFlight: false });
                });
                save();
                watches.forEach(schedule);
                render();
            }

            function find(id) { for (var i = 0; i < watches.length; i++) if (watches[i].id === id) return watches[i]; return null; }

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

            // GET behind the admin gate: { status, body } or { status, gone: 'session'|'admin' } or null (no answer).
            function getJson(path) {
                return fetch(withToken(path), { method: 'GET', redirect: 'manual', credentials: 'same-origin' }).then(function (res) {
                    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) return { status: res.status, gone: 'session' };
                    if (res.status === 403) return { status: 403, gone: 'admin' };
                    if ((res.headers.get('content-type') || '').indexOf('application/json') < 0) return { status: res.status, body: null };
                    return res.json().then(function (body) { return { status: res.status, body: body }; }, function () { return { status: res.status, body: null }; });
                }).catch(function () { return null; });
            }

            function sentence(s) {
                s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim().slice(0, 300).replace(/[\\s.,;:!?]+$/, '');
                return s ? s + '.' : '';
            }

            function gone(w, why) {
                finish(w, 'I stopped following the ' + label(w) + ' run: ' +
                    (why === 'admin' ? 'this account is not an administrator.' : 'your session has expired.'));
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
                    if (r && r.gone) return gone(w, r.gone);
                    if (w.phase === 'run') ranOn(w, r); else saidOn(w, r);
                });
            }

            function ranOn(w, r) {
                var run = r && r.status === 200 && r.body && typeof r.body === 'object' ? r.body : null;
                if (r && r.status === 404) return finish(w, "I can't find the " + label(w) + ' run any more.');
                if (!run) return again(w);   // a server error or no answer: look again
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
                if (r && r.status === 200 && r.body && typeof r.body === 'object') {
                    var text = String(r.body.text || '').trim();
                    return finish(w, text || 'The ' + label(w) + ' run finished, but the brief has nothing to read aloud.');
                }
                // 404: no brief yet (the vault hasn't caught up). 500, other errors, no answer: look again.
                if (r && (r.status === 400 || r.status === 503)) {
                    return finish(w, 'The ' + label(w) + " run finished, but I can't read the brief here.");
                }
                again(w);
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
                if (!queue.length) return;
                if (adminBusy()) {
                    if (!retryTimer) retryTimer = setTimeout(function () { retryTimer = null; drain(); }, RETRY);
                    return;
                }
                var text = queue.shift();
                note = text;
                render();
                OS.speak(text, function (cut) {
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
                var w = { id: id, skill: run.skill, phase: 'run', runUntil: t + RUN_MS, sayUntil: null, date: null,
                    nextAt: t + POLL, timer: null, inFlight: false, status: run.status === 'running' ? 'running' : 'queued' };
                watches.push(w);
                note = '';
                save(); render(); schedule(w);
            });

            // An outcome waiting to be said, or a watch a reload would lose, holds the reload off.
            var busy = OS.busy;
            OS.busy = function () { return queue.length > 0 || (watches.length > 0 && !stored) || busy(); };
            OS.watching = function () {
                return watches.map(function (w) { return { id: w.id, skill: w.skill, label: label(w), phase: w.phase }; });
            };
            OS.unwatch = function (id) {
                watches.slice().forEach(function (w) { if (id === undefined || id === null || w.id === id) drop(w); });
                render();
            };

            restore();
        })();`;
}
