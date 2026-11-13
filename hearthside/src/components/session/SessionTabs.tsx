"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import { errorOf } from '@/lib/api';
import { TAB_LABEL, longDay, taleParagraphs, timeSpan, type SessionPhase, type SessionTab } from '@/lib/sessionPage';
import type { SessionDetail, SessionPatch } from '@/lib/useSessionPage';

export interface SessionTabsProps {
  session: SessionDetail;
  phase: SessionPhase;
  tabs: SessionTab[];
  tab: SessionTab;
  onTab: (tab: SessionTab) => void;
  /** The GM, the stand-in or an admin: writes the tale and Prep notes. */
  writer: boolean;
  /** Who runs the session, as the page names them: "Avery", or the stand-in. */
  gmName: string | null;
  gmTitle: string;
  standInName: string | null;
  place: string;
  onSave: (patch: SessionPatch) => Promise<unknown>;
}

const tabId = (t: SessionTab) => `hs-sess-tab-${t}`;
const PANEL_ID = 'hs-sess-panel';

/**
 * The tabs under the table (layout C, revised): The tale, Details and, for
 * the GM, Prep notes, on gilded leather. Which one opens first is the page's
 * call (defaultTab). The arrow keys, Home and End move between them.
 */
export default function SessionTabs(props: SessionTabsProps) {
  const { tabs, tab, onTab } = props;
  const refs = useRef<Partial<Record<SessionTab, HTMLButtonElement | null>>>({});

  const onKey = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    onTab(tabs[to]);
    refs.current[tabs[to]]?.focus();
  };

  return (
    <GildedPanel className="hs-sess-tabs">
      <div className="hs-tabs" role="tablist" aria-label="About the session">
        {tabs.map((t, i) => (
          <button
            key={t}
            ref={(el) => { refs.current[t] = el; }}
            type="button"
            role="tab"
            id={tabId(t)}
            aria-selected={t === tab}
            aria-controls={PANEL_ID}
            tabIndex={t === tab ? 0 : -1}
            onClick={() => onTab(t)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="hs-sess-panel" role="tabpanel" id={PANEL_ID} aria-labelledby={tabId(tab)}>
        {tab === 'tale' && <TalePanel {...props} />}
        {tab === 'details' && <DetailsPanel {...props} />}
        {tab === 'prep' && <PrepPanel {...props} />}
      </div>
    </GildedPanel>
  );
}

/**
 * Writing in place: a textarea with Save and Cancel. `field` is what's saved
 * (PUT {summary} or {agenda} alone).
 */
function InPlace({ label, initial, placeholder, story, saveLabel, onSave, onDone, hint }: {
  label: string;
  initial: string;
  placeholder: string;
  story?: boolean;
  saveLabel: string;
  onSave: (text: string) => Promise<unknown>;
  onDone: () => void;
  hint?: ReactNode;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSave(text.trim() ? text.replace(/\s+$/, '') : '');
      onDone();
    } catch (err) {
      setError(errorOf(err, 'It couldn’t be saved. Try again in a moment.'));
      setBusy(false);
    }
  };
  return (
    <div className="hs-form">
      <textarea
        className={story ? 'hs-input hs-sess-write is-story' : 'hs-input hs-sess-write'}
        aria-label={label}
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      {error && <p className="hs-alert" role="alert">{error}</p>}
      <div className="hs-actions">
        <button type="button" className="hs-btn-amber" disabled={busy} onClick={save}>{busy ? 'Saving…' : saveLabel}</button>
        <button type="button" className="hs-ghost" disabled={busy} onClick={onDone}>Cancel</button>
        {hint && <span className="hs-fine">{hint}</span>}
      </div>
    </div>
  );
}

/** The tale: the session's summary, in the story face with a drop cap, written in place by the GM. */
function TalePanel({ session, phase, writer, gmName, onSave }: SessionTabsProps) {
  const [writing, setWriting] = useState(false);
  const paragraphs = taleParagraphs(session.summary);
  const teller = gmName ?? 'the GM';

  if (writing) {
    return (
      <InPlace
        label="The tale"
        initial={session.summary ?? ''}
        placeholder="What happened? Write it like you’d tell it at the next session."
        story
        saveLabel="Save the tale"
        hint="The party reads it. Blank lines start a new paragraph."
        onSave={(summary) => onSave({ summary })}
        onDone={() => setWriting(false)}
      />
    );
  }
  if (paragraphs.length) {
    return (
      <>
        <div className="hs-tale">{paragraphs.map((p, i) => <p key={i}>{p}</p>)}</div>
        {writer && (
          <div className="hs-actions hs-sess-after">
            <button type="button" className="hs-ghost" onClick={() => setWriting(true)}>Edit the tale</button>
          </div>
        )}
      </>
    );
  }
  return (
    <div className="hs-sess-slot">
      <p className="hs-sess-empty">
        {phase === 'before'
          ? `After the session, ${teller} writes up what happened here.`
          : writer ? 'Nobody’s told this one yet. Write up what happened, for the party to read.' : `${teller} hasn’t written this one up yet.`}
      </p>
      {writer && (
        <div className="hs-actions hs-sess-after">
          <button type="button" className="hs-btn-amber" onClick={() => setWriting(true)}>Write the tale</button>
        </div>
      )}
    </div>
  );
}

const ext = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** Details: when, where, who runs it, the recording, the calendar events and when it was logged. */
function DetailsPanel({ session, phase, gmTitle, gmName, standInName, place }: SessionTabsProps) {
  const before = phase === 'before';
  const tableLink = session.campaign?.tableLink;
  const rows: [string, ReactNode][] = [
    ['When', session.date
      ? <>{longDay(session.date)}<small>{timeSpan(session.date, session.endDate)}</small></>
      : <span className="hs-sess-muted">{session.status === 'planning' ? 'No night yet: it’s being voted on' : 'No night yet'}</span>],
    ['Where', <>{place}{session.isOnline && before && tableLink && <small><a className="hs-sess-link" href={tableLink} {...ext}>Join the table ↗</a></small>}</>],
    [gmTitle, standInName
      ? <>{standInName} <span className="hs-sess-pill">standing in</span></>
      : gmName ?? <span className="hs-sess-muted">Not known</span>],
  ];
  if (session.vodUrl) rows.push(['Recording', <a className="hs-sess-link" href={session.vodUrl} {...ext}>Watch the recording ↗</a>]);
  if (before && (session.googleCalendarLink || session.discordEventId || session.googleEventId)) {
    const made = [session.discordEventId && 'Discord event made', session.googleEventId && 'On the GM’s Google Calendar'].filter(Boolean).join(' · ');
    rows.push(['Calendar', <>
      {session.googleCalendarLink && <a className="hs-sess-link" href={session.googleCalendarLink} {...ext}>Add to Google Calendar ↗</a>}
      {made && <small>{made}</small>}
    </>]);
  }
  if (session.createdAt) rows.push(['Logged', longDay(session.createdAt).replace(/^\w+, /, '')]);
  return (
    <dl className="hs-sess-dl">
      {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
    </dl>
  );
}

/** Prep notes: the GM's own (the session's `agenda`), edited in place. Players never get this tab. */
function PrepPanel({ session, phase, gmTitle, onSave }: SessionTabsProps) {
  const [writing, setWriting] = useState(false);
  const agenda = session.agenda ?? '';
  if (writing) {
    return (
      <InPlace
        label="Prep notes"
        initial={agenda}
        placeholder="Scenes, handouts, what to roll on."
        saveLabel="Save"
        onSave={(text) => onSave({ agenda: text })}
        onDone={() => setWriting(false)}
      />
    );
  }
  return (
    <>
      <p className="hs-fine hs-sess-before">Only the {gmTitle}, anyone standing in for them, and admins see these.</p>
      {agenda.trim() ? <p className="hs-sess-prep">{agenda}</p> : <p className="hs-sess-empty">No prep notes yet.</p>}
      {phase !== 'cancelled' && (
        <div className="hs-actions hs-sess-after">
          <button type="button" className="hs-ghost" onClick={() => setWriting(true)}>{agenda.trim() ? 'Edit the prep notes' : 'Write prep notes'}</button>
        </div>
      )}
    </>
  );
}
