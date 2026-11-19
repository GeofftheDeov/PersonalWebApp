"use client";

import Link from 'next/link';
import { Flame } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import NoticeSheet from '@/components/design-system/NoticeSheet';
import OverlapPicker from '@/components/noticeboard/OverlapPicker';
import { api, errorOf } from '@/lib/api';
import { gmTitleOf, type CampaignDetail } from '@/lib/campaignPage';
import {
  attendanceLabel, previousSessions, sessionWhenLabel, type CampaignSession, type PartyCharacter,
} from '@/lib/campaignRecords';
import { optionWhen, type Board, type Upcoming } from '@/lib/noticeBoard';
import type { PickedTime } from '@/lib/overlap';
import AddSessionDialog from './AddSessionDialog';
import CampaignCharacters from './CampaignCharacters';

type Tab = 'sessions' | 'characters';
const TABS: { id: Tab; label: string }[] = [{ id: 'sessions', label: 'Sessions' }, { id: 'characters', label: 'Characters' }];
const tabId = (t: Tab) => `hs-cp-tab-${t}`;
const panelId = (t: Tab) => `hs-cp-panel-${t}`;

/**
 * Sessions | Characters (#36, #225), on gilded leather under the party.
 * Sessions: Coming up (the board's scheduled sessions still to come, where
 * the GM can change a night, which puts it back to a vote) beside Previous
 * sessions from 1100px, stacked below that; the GM adds a session in a gilded
 * dialog. Every session links to its page (`/sessions/:id`). Characters: the
 * party's adventurers, each linking to its page (`/characters/:id`).
 *
 * The campaign's sessions are read again whenever the board is (a session
 * planned, scheduled or moved changes both).
 */
export default function CampaignRecords({ campaign, isGM, board, boardError, reloadBoard, nameOf }: {
  campaign: CampaignDetail;
  /** The campaign's GM, or an admin: Add a session. */
  isGM: boolean;
  board: Board | null;
  boardError: string | null;
  reloadBoard: () => Promise<void>;
  /** A party member's name, by account id (the stand-in who ran a session). */
  nameOf: (personId: string) => string;
}) {
  const id = campaign._id;
  const path = encodeURIComponent(id);
  const [tab, setTab] = useState<Tab>('sessions');
  const tabs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [sessions, setSessions] = useState<CampaignSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [characters, setCharacters] = useState<PartyCharacter[] | null>(null);
  const [charactersError, setCharactersError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  // Read again whenever the board is: planning, scheduling and moving a night change the list too.
  useEffect(() => {
    let live = true;
    api.get<CampaignSession[]>(`/api/campaigns/${path}/sessions`)
      .then((list) => { if (live) { setSessions(list); setSessionsError(null); } })
      .catch((err) => { if (live) setSessionsError(errorOf(err, 'The campaign’s sessions couldn’t be read.')); });
    return () => { live = false; };
  }, [path, board]);

  useEffect(() => {
    let live = true;
    api.get<PartyCharacter[]>(`/api/tabletop/characters?campaign=${path}`)
      .then((cs) => { if (live) setCharacters(cs); })
      .catch((err) => { if (live) setCharactersError(errorOf(err, 'The party’s characters couldn’t be read.')); });
    return () => { live = false; };
  }, [path]);

  const upcoming = board?.upcoming ?? [];
  const past = sessions ? previousSessions(sessions, upcoming, new Date()) : [];
  const counts: Record<Tab, number | null> = {
    sessions: board && sessions ? upcoming.length + past.length : null,
    characters: characters?.length ?? null,
  };

  const onKey = (e: KeyboardEvent, i: number) => {
    const to = { ArrowRight: (i + 1) % TABS.length, ArrowLeft: (i - 1 + TABS.length) % TABS.length, Home: 0, End: TABS.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setTab(TABS[to].id);
    tabs.current[TABS[to].id]?.focus();
  };

  return (
    <section className="hs-cp-records" aria-label="Campaign records">
      <GildedPanel className="hs-cp-tabstrip">
        <div className="hs-tabs" role="tablist" aria-label="Campaign records">
          {TABS.map((t, i) => (
            <button key={t.id} ref={(el) => { tabs.current[t.id] = el; }} type="button" role="tab" id={tabId(t.id)}
              aria-selected={tab === t.id} aria-controls={panelId(t.id)} tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)} onKeyDown={(e) => onKey(e, i)}>
              {t.label}{counts[t.id] != null && <small>{counts[t.id]}</small>}
            </button>
          ))}
        </div>
      </GildedPanel>

      <div role="tabpanel" id={panelId('sessions')} aria-labelledby={tabId('sessions')} hidden={tab !== 'sessions'} className="hs-cp-records-in">
        <section aria-labelledby="hs-cp-coming-h">
          <h3 className="hs-sec" id="hs-cp-coming-h"><span>Coming up</span>{board && <span className="hs-aside">{upcoming.length}</span>}</h3>
          {!board ? (
            <p className="hs-note" role={boardError ? 'alert' : undefined}>{boardError ?? 'Checking the calendar…'}</p>
          ) : upcoming.length ? (
            <GildedPanel>
              <ul className="hs-cp-rows" aria-label="Coming up">
                {upcoming.map((u) => <UpcomingRow key={u.id} campaignId={id} session={u} onChanged={reloadBoard} />)}
              </ul>
            </GildedPanel>
          ) : (
            <p className="hs-note">Nothing scheduled yet.</p>
          )}
        </section>

        <section aria-labelledby="hs-cp-past-h">
          <div className="hs-cp-sec-row">
            <h3 className="hs-sec" id="hs-cp-past-h"><span>Previous sessions</span>{sessions && <span className="hs-aside">{past.length}</span>}</h3>
            {isGM && <button type="button" className="hs-btn-amber" onClick={() => setAdding(true)}>Add a session</button>}
          </div>
          {warnings.length > 0 && (
            <GildedPanel className="hs-cp-warn" role="status">
              <div>{warnings.map((w) => <p key={w}>{w}</p>)}</div>
              <button type="button" className="hs-dialog-x" aria-label="Dismiss" onClick={() => setWarnings([])}>✕</button>
            </GildedPanel>
          )}
          {sessionsError && !sessions ? (
            <p className="hs-note" role="alert">{sessionsError}</p>
          ) : !sessions ? (
            <p className="hs-note">Turning back the pages…</p>
          ) : past.length ? (
            <GildedPanel>
              <ul className="hs-cp-rows" aria-label="Previous sessions">
                {past.map((s) => <PastRow key={s._id} session={s} gmTitle={gmTitleOf(campaign)} nameOf={nameOf} />)}
              </ul>
            </GildedPanel>
          ) : (
            <p className="hs-note">No sessions logged yet.</p>
          )}
        </section>
      </div>

      <div role="tabpanel" id={panelId('characters')} aria-labelledby={tabId('characters')} hidden={tab !== 'characters'} className="hs-cp-chars-panel">
        <CampaignCharacters characters={characters} error={charactersError} />
      </div>

      {adding && (
        <AddSessionDialog
          campaign={campaign}
          onClose={() => setAdding(false)}
          onAdded={async (_made, w) => {
            setWarnings(w);
            setAdding(false);
            // A session still to come belongs under Coming up; reading the board reads the sessions too.
            await reloadBoard();
          }}
        />
      )}
    </section>
  );
}

/** A scheduled session still to come. Whoever runs it can change its night, which puts it back to a vote. */
function UpcomingRow({ campaignId, session: u, onChanged }: { campaignId: string; session: Upcoming; onChanged: () => Promise<void> }) {
  const [changing, setChanging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reopen = async (options: PickedTime[]) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/planning/sessions/${encodeURIComponent(u.id)}/reopen`, { options });
    } catch (err) {
      setError(errorOf(err, 'The night couldn’t be put to a vote. Try again in a moment.'));
      setBusy(false);
      return;
    }
    setBusy(false);
    setChanging(false);
    await onChanged();
  };

  return (
    <li>
      <Link className="hs-cp-row" href={`/sessions/${encodeURIComponent(u.id)}`}>
        <span className="hs-cp-row-text">
          <span className="hs-cp-row-title">{u.title}</span>
          <span className="hs-cp-meta">
            <span className="hs-cp-when">{optionWhen(u.date, u.endDate)}</span>
            <span>{u.isOnline ? 'Online' : u.venue ? u.venue.name : 'In person'}</span>
            {!u.isOnline && u.venue?.address && <span>{u.venue.address}</span>}
          </span>
        </span>
        <span className="hs-cp-chev" aria-hidden="true">›</span>
      </Link>
      {u.canChangeNight && !changing && (
        <div className="hs-cp-row-tools">
          <button type="button" className="hs-ghost" onClick={() => setChanging(true)} aria-label={`Change the night of ${u.title}`}>Change the night</button>
        </div>
      )}
      {error && !changing && <p className="hs-alert hs-cp-row-tools" role="alert">{error}</p>}
      {changing && (
        <div className="hs-cp-row-sheet">
          <NoticeSheet seed={`${u.id}/change`} className="hs-board-sheet" aria-label={`Change the night of ${u.title}`}>
            <div className="hs-kicker">{u.title}</div>
            <h4 className="hs-sheet-title hs-cp-change-title">Change the night</h4>
            <p className="hs-board-fine">
              Shortlist new times and the party votes again. Until a new night is confirmed the session keeps its date and
              events, but it’s back to being planned (no ready check). Then the Discord and calendar events move with it.
            </p>
            {error && <p className="hs-board-alert" role="alert">{error}</p>}
            <OverlapPicker campaignId={campaignId} submitting={busy} submitLabel="Put it to a vote"
              onSubmit={reopen} onCancel={() => setChanging(false)} />
          </NoticeSheet>
        </div>
      )}
    </li>
  );
}

/** A session in the campaign's past (or cancelled): its night, where, who came, who ran it, and the tale's start. */
function PastRow({ session: s, gmTitle, nameOf }: { session: CampaignSession; gmTitle: string; nameOf: (id: string) => string }) {
  const attended = attendanceLabel(s);
  const whenCls = s.status === 'planning' ? 'hs-cp-when is-planning' : s.status === 'cancelled' ? 'hs-cp-when is-cancelled' : 'hs-cp-when';
  return (
    <li>
      <Link className="hs-cp-row" href={`/sessions/${encodeURIComponent(s._id)}`}>
        <span className="hs-cp-row-text">
          <span className={s.status === 'cancelled' ? 'hs-cp-row-title is-struck' : 'hs-cp-row-title'}>{s.title || 'Session'}</span>
          <span className="hs-cp-meta">
            <span className={whenCls}>{sessionWhenLabel(s)}</span>
            {s.location && <span>{s.location}</span>}
            {s.isOnline && <span className="hs-tag">Online</span>}
            {attended && <span title={`Players the ${gmTitle} marked as there`}>{attended}</span>}
            {s.gmOverride && (
              <span className="hs-cp-flamed"><Flame className="hs-cp-flame" strokeWidth={1.6} aria-hidden="true" /> {nameOf(s.gmOverride)} ran it as {gmTitle}</span>
            )}
          </span>
          {s.summary && <span className="hs-cp-sum">{s.summary}</span>}
        </span>
        <span className="hs-cp-chev" aria-hidden="true">›</span>
      </Link>
    </li>
  );
}
