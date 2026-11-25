"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '@gtd/shared/api';
import { api, errorOf } from '@/lib/api';
import {
  DAYS, DAY_NAMES, SOURCE_HINT, SOURCE_LABEL, blankException, browserTimeZone, describeException, exceptionSpan,
  nextWindow, overnightNote, previewDays, previewQuery, previewStart, sourceActions, sourceLine, timeZones,
  weekChanged, weekOf, windowsBody, withException, zoneLabel,
  type AvailabilityException, type BusySource, type ExceptionDraft, type MyAvailability, type Presence, type Run,
  type Week, type WeekWindow,
} from '@/lib/availability';

const PRESENCE_LABEL: Record<Presence, string> = { free: 'Free', busy: 'Busy', unknown: 'Unknown' };

/**
 * Your Room's Availability tab (#275): the portfolio profile's availability
 * editor (#57) in layout A. Four sections on the leather: the weekly windows
 * and their time zone, one-off exceptions, busy time from Google Calendar and
 * Discord events (#84, #85), and the next two weeks as the party's overlap
 * will count you. The rules are in lib/availability.
 *
 * Connect Google leaves for Google with `?return=availability`, so the
 * callback brings the person back to `/room?tab=availability&gcal=…`; the page
 * passes that outcome in as `googleNotice`.
 */
export default function AvailabilityPanel({ googleNotice }: { googleNotice?: string | null }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [week, setWeek] = useState<Week>(() => ({ windows: [], timeZone: browserTimeZone() }));
  const [savedWeek, setSavedWeek] = useState<Week | null>(null);
  const [saving, setSaving] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [exceptions, setExceptions] = useState<AvailabilityException[]>([]);
  const [draft, setDraft] = useState<ExceptionDraft>(blankException);
  const [xError, setXError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [sources, setSources] = useState<BusySource[]>([]);
  const [sourceBusy, setSourceBusy] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const [runs, setRuns] = useState<Run[]>([]);
  const [from] = useState(() => previewStart(new Date()));
  const zones = useMemo(() => timeZones(week.timeZone), [week.timeZone]);
  const here = useMemo(browserTimeZone, []);
  const dirty = !!savedWeek && weekChanged(week, savedWeek);

  const loadSources = useCallback(async () => {
    const data = await api.get<{ sources: BusySource[] }>('/api/availability/me/busy-sources').catch(() => null);
    if (data) setSources(data.sources);
  }, []);

  const loadPreview = useCallback(async () => {
    const data = await api.get<{ runs: Run[] }>(`/api/availability/me/preview?${previewQuery(from)}`).catch(() => null);
    if (data) setRuns(data.runs);
  }, [from]);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const data = await api.get<MyAvailability>('/api/availability/me');
        if (!live) return;
        const w = weekOf(data, browserTimeZone());
        setWeek(w);
        setSavedWeek(w);
        setExceptions(data.exceptions);
        await Promise.all([loadSources(), loadPreview()]);
      } catch {
        if (live) setLoadError('Your availability couldn’t be loaded. Try again in a moment.');
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [loadSources, loadPreview]);

  const setRow = (i: number, patch: Partial<WeekWindow>) => {
    setSaved(false);
    setWeek((w) => ({ ...w, windows: w.windows.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  };
  const addRow = () => { setSaved(false); setWeek((w) => ({ ...w, windows: [...w.windows, nextWindow(w.windows)] })); };
  const removeRow = (i: number) => { setSaved(false); setWeek((w) => ({ ...w, windows: w.windows.filter((_, j) => j !== i) })); };

  const saveWeek = async () => {
    setSaving(true);
    setWeekError(null);
    try {
      const data = await api.put<MyAvailability>('/api/availability/me/windows', windowsBody(week));
      const w = weekOf(data, week.timeZone);
      setWeek(w);
      setSavedWeek(w);
      setSaved(true);
      await loadPreview();
    } catch (err) {
      setWeekError(errorOf(err, 'Your week couldn’t be saved. Try again in a moment.'));
    } finally {
      setSaving(false);
    }
  };

  const addException = async (e: FormEvent) => {
    e.preventDefault();
    setXError(null);
    const span = exceptionSpan(draft);
    if ('error' in span) { setXError(span.error); return; }
    setAdding(true);
    try {
      const data = await api.post<{ exception: AvailabilityException }>('/api/availability/me/exceptions',
        { start: span.start.toISOString(), end: span.end.toISOString(), kind: draft.kind, note: draft.note });
      setExceptions((list) => withException(list, data.exception));
      setDraft((d) => ({ ...d, date: '', note: '' }));
      await loadPreview();
    } catch (err) {
      setXError(errorOf(err, 'That exception couldn’t be added.'));
    } finally {
      setAdding(false);
    }
  };

  const removeException = async (id: string) => {
    setXError(null);
    const gone = await api.delete(`/api/availability/me/exceptions/${id}`)
      .then(() => true, (err) => err instanceof ApiError && err.status === 404);
    if (!gone) { setXError('That exception couldn’t be removed. Try again in a moment.'); return; }
    setExceptions((list) => list.filter((x) => x.id !== id));
    await loadPreview();
  };

  /** Google's consent screen, coming back to this tab: to connect, or to agree once more for free/busy. */
  const connectGoogle = async () => {
    setSourceError(null);
    setSourceBusy('google:connect');
    try {
      const { url } = await api.get<{ url: string }>('/api/google-calendar/auth-url?return=availability');
      window.location.assign(url);
    } catch (err) {
      setSourceError(errorOf(err, 'Google Calendar isn’t set up on the server.'));
      setSourceBusy(null);
    }
  };

  const changeSource = async (source: BusySource['source'], action: 'on' | 'off' | 'sync') => {
    setSourceBusy(`${source}:${action}`);
    setSourceError(null);
    try {
      const path = `/api/availability/me/busy-sources/${source}${action === 'sync' ? '/sync' : ''}`;
      if (action === 'on') await api.put(path);
      else if (action === 'off') await api.delete(path);
      else await api.post(path);
      await Promise.all([loadSources(), loadPreview()]);
    } catch (err) {
      setSourceError(errorOf(err, 'That didn’t work. Try again in a moment.'));
    } finally {
      setSourceBusy(null);
    }
  };

  const days = useMemo(() => previewDays(from, runs), [from, runs]);
  const now = new Date();

  if (loading) return <p className="hs-room-sec hs-room-empty" role="status">Reading your week…</p>;
  if (loadError) return <div className="hs-room-sec"><p className="hs-alert" role="alert">{loadError}</p></div>;

  return (
    <>
      {/* ── The week ── */}
      <section className="hs-room-sec" aria-labelledby="hs-av-week">
        <h2 className="hs-room-h" id="hs-av-week">When you can play</h2>
        <p className="hs-fine">
          Your regular week. When your Game Master plans a session, these become the overlap they pick a night from.
          The party only ever sees free or busy, never why.
        </p>
        <div className="hs-av-zone">
          <label className="hs-field">
            <span>Time zone</span>
            <select className="hs-input" value={week.timeZone} onChange={(e) => { setSaved(false); setWeek((w) => ({ ...w, timeZone: e.target.value })); }}>
              {zones.map((z) => <option key={z} value={z}>{zoneLabel(z)}</option>)}
            </select>
          </label>
          {week.timeZone !== here && <p className="hs-fine hs-av-warn">This device is set to {zoneLabel(here)}.</p>}
        </div>

        {week.windows.length === 0 ? (
          <p className="hs-room-empty">No weekly windows yet. Until you add some, your party sees you as “unknown”, not “busy”.</p>
        ) : (
          <ul className="hs-av-rows" aria-label="Your week">
            {week.windows.map((r, i) => {
              const overnight = overnightNote(r);
              return (
                <li key={i} className="hs-av-row">
                  <select className="hs-input hs-av-day" aria-label="Day" value={r.weekday} onChange={(e) => setRow(i, { weekday: Number(e.target.value) })}>
                    {DAYS.map((d, n) => <option key={d} value={n}>{DAY_NAMES[n]}</option>)}
                  </select>
                  <input className="hs-input hs-av-time" aria-label="From" type="time" step={900} required value={r.start} onChange={(e) => setRow(i, { start: e.target.value })} />
                  <span className="hs-av-to" aria-hidden="true">to</span>
                  <input className="hs-input hs-av-time" aria-label="Until" type="time" step={900} required value={r.end} onChange={(e) => setRow(i, { end: e.target.value })} />
                  {overnight && <span className="hs-room-pill hs-av-over">{overnight}</span>}
                  <button type="button" className="hs-av-x" aria-label={`Remove the ${DAY_NAMES[r.weekday]} window`} onClick={() => removeRow(i)}>×</button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="hs-av-acts">
          <button type="button" className="hs-ghost" onClick={addRow}>Add a window</button>
          <button type="button" className="hs-btn-amber hs-av-btn" onClick={saveWeek} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save my week'}
          </button>
          {dirty && !saving && <span className="hs-fine hs-av-warn">Unsaved changes</span>}
          {saved && !dirty && <span className="hs-av-ok" role="status">Saved.</span>}
        </div>
        {weekError && <p className="hs-alert" role="alert">{weekError}</p>}
      </section>

      {/* ── Exceptions ── */}
      <section className="hs-room-sec" aria-labelledby="hs-av-x">
        <h2 className="hs-room-h" id="hs-av-x">Exceptions</h2>
        <p className="hs-fine">One-off changes that leave your regular week alone: out of town on the 17th, free this Tuesday only.</p>
        <form className="hs-av-xform" onSubmit={addException} aria-label="Add an exception">
          <div className="hs-room-filt hs-av-kind" role="group" aria-label="Kind">
            {([['unavailable', 'Out'], ['available', 'Free']] as const).map(([kind, label]) => (
              <button key={kind} type="button" aria-pressed={draft.kind === kind}
                onClick={() => setDraft((d) => ({ ...d, kind, allDay: kind === 'unavailable' ? d.allDay : false }))}>
                {label}
              </button>
            ))}
          </div>
          <input className="hs-input hs-av-date" aria-label="Date" type="date" value={draft.date} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
          <label className="hs-av-check">
            <input type="checkbox" checked={draft.allDay} onChange={(e) => setDraft((d) => ({ ...d, allDay: e.target.checked }))} />
            All day
          </label>
          {!draft.allDay && (
            <span className="hs-av-span">
              <input className="hs-input hs-av-time" aria-label="From" type="time" step={900} value={draft.start} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} />
              <span className="hs-av-to" aria-hidden="true">to</span>
              <input className="hs-input hs-av-time" aria-label="Until" type="time" step={900} value={draft.end} onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} />
            </span>
          )}
          <input className="hs-input hs-av-note" aria-label="Note (optional)" placeholder="Note (optional)" maxLength={200}
            value={draft.note} onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))} />
          <button type="submit" className="hs-btn-amber hs-av-btn" disabled={adding}>{adding ? 'Adding…' : 'Add'}</button>
        </form>
        {xError && <p className="hs-alert" role="alert">{xError}</p>}
        {exceptions.length > 0 && (
          <ul className="hs-av-rows" aria-label="Your exceptions">
            {exceptions.map((x) => (
              <li key={x.id} className="hs-av-row">
                <span className={`hs-room-pill ${x.kind === 'available' ? 'is-ok' : ''}`}>{x.kind === 'unavailable' ? 'Out' : 'Free'}</span>
                <span className="hs-av-what">
                  {describeException(x)}
                  {x.note && <small>{x.note}</small>}
                </span>
                <button type="button" className="hs-av-x" aria-label={`Remove ${describeException(x)}`} onClick={() => removeException(x.id)}>×</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Busy time from outside calendars ── */}
      {sources.length > 0 && (
        <section className="hs-room-sec" aria-labelledby="hs-av-busy">
          <h2 className="hs-room-h" id="hs-av-busy">Busy from your calendars</h2>
          <p className="hs-fine">
            Let your real commitments count without typing them in. Hearthside reads only when you’re busy, never what the
            event is, and your party sees busy without knowing where it came from.
          </p>
          {googleNotice && <p className="hs-av-ok" role="status">{googleNotice}</p>}
          <ul className="hs-av-rows" aria-label="Your calendars">
            {sources.map((s) => {
              const acts = sourceActions(s);
              const working = !!sourceBusy?.startsWith(`${s.source}:`);
              return (
                <li key={s.source} className="hs-av-src">
                  <div className="hs-av-src-text">
                    <div className="hs-room-ig-name">
                      <h3>{SOURCE_LABEL[s.source]}</h3>
                      <span className={`hs-room-pill ${s.enabled ? 'is-ok' : ''}`}>{s.enabled ? 'On' : 'Off'}</span>
                    </div>
                    <p className="hs-room-ig-sub">{SOURCE_HINT[s.source]}</p>
                    <p className="hs-room-ig-sub">{sourceLine(s, now)}</p>
                    {s.enabled && s.lastError && (
                      <p className="hs-room-ig-warn" role="alert">Last sync failed: {s.lastError} Until it works, your party sees your regular week.</p>
                    )}
                  </div>
                  <div className="hs-av-src-acts">
                    {acts.connect && (
                      <button type="button" className="hs-btn-amber hs-av-btn" disabled={working} onClick={connectGoogle}>
                        {sourceBusy === 'google:connect' ? 'Opening Google…' : acts.connect}
                      </button>
                    )}
                    {acts.sync && (
                      <button type="button" className="hs-ghost" disabled={working} onClick={() => changeSource(s.source, 'sync')}>
                        {sourceBusy === `${s.source}:sync` ? 'Syncing…' : 'Sync now'}
                      </button>
                    )}
                    {acts.toggle && (
                      <button type="button" className={acts.toggle === 'Turn off' ? 'hs-ghost is-warn' : 'hs-btn-amber hs-av-btn'} disabled={working}
                        onClick={() => changeSource(s.source, s.enabled ? 'off' : 'on')} aria-label={`${acts.toggle} ${SOURCE_LABEL[s.source]}`}>
                        {acts.toggle}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {sourceError && <p className="hs-alert" role="alert">{sourceError}</p>}
        </section>
      )}

      {/* ── What the party sees ── */}
      <section className="hs-room-sec" aria-labelledby="hs-av-see">
        <h2 className="hs-room-h" id="hs-av-see">What your party sees</h2>
        <p className="hs-fine">
          The next two weeks, exactly as the Game Master’s overlap will count you, calendar busy time included. Saved changes only.
        </p>
        <div className="hs-av-key" aria-hidden="true">
          {(['free', 'busy', 'unknown'] as const).map((p) => (
            <span key={p}><i className={`hs-av-cell is-${p}`} /> {PRESENCE_LABEL[p]}</span>
          ))}
        </div>
        <div className="hs-av-grid">
          <div className="hs-av-day-row hs-av-hours" aria-hidden="true">
            <span />
            <div><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span></div>
          </div>
          {days.map((d) => (
            <div key={d.start.toISOString()} className="hs-av-day-row">
              <span className="hs-av-day-name">{d.label}</span>
              <div className="hs-av-bar" role="img" aria-label={`${d.label}: ${d.freeHours} hours free`}>
                {d.cells.map((p, i) => <i key={i} className={`hs-av-cell is-${p}${i && i % 12 === 0 ? ' is-quarter' : ''}`} />)}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
