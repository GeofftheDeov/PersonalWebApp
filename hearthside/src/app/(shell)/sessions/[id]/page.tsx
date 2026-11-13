"use client";

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import BackLink from '@/components/shell/BackLink';
import EditSessionDialog from '@/components/session/EditSessionDialog';
import SessionCard from '@/components/session/SessionCard';
import SessionTabs from '@/components/session/SessionTabs';
import {
  canWritePrepNotes, defaultTab, sessionName, sessionNeighbours, sessionPhase, sessionTabs, type SessionTab,
} from '@/lib/sessionPage';
import { useSessionPage, type PlanningRead, type SessionDetail } from '@/lib/useSessionPage';

/** What a campaign calls its Game Master until the owner names the role (the backend's default). */
const DEFAULT_GM_TITLE = 'Dungeon Master';

/** The back link's label, short enough for the phone bar. */
const short = (s: string, n = 22) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * A session's page (spec #69, #226): layout C, "Around the table", as
 * prototype/hearthside-session-details revised it, with today's data.
 * Previous and next above the parchment card; the table under it (#227 lays
 * it, at `#quests`); then the tabs: The tale, Details and, for the GM, the
 * stand-in and admins, Prep notes.
 */
export default function SessionPage() {
  const params = useParams();
  const id = String(params?.id ?? '');
  // A fresh page per session, so walking to the next one starts on its own default tab.
  return <SessionView key={id} id={id} />;
}

function SessionView({ id }: { id: string }) {
  const { state, reload, save } = useSessionPage(id);
  const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<SessionTab | null>(null);
  // "Now", for before or after: read once the session is in, so the page doesn't change tab under the reader.
  const [now, setNow] = useState<Date | null>(null);
  const ready = state.status === 'ready';

  useEffect(() => { if (ready) setNow((n) => n ?? new Date()); }, [ready]);

  // Quest links (`/sessions/:id#quests`) land at the table, once there's a page to scroll.
  useEffect(() => {
    if (!ready || !now || window.location.hash !== '#quests') return;
    document.getElementById('quests')?.scrollIntoView({ block: 'start' });
  }, [ready, now]);

  if (state.status === 'loading' || (ready && !now)) {
    return <p className="hs-note hs-sess-wait" role="status">Fetching the session…</p>;
  }
  if (state.status !== 'ready') {
    return (
      <>
        <header className="hs-page-head">
          <BackLink href="/campaigns">Campaigns</BackLink>
          <h1>{state.status === 'missing' ? 'No such session' : 'The session didn’t come'}</h1>
          <p>{state.status === 'missing' ? 'It isn’t here, or it isn’t one of your campaigns’.' : state.error}</p>
        </header>
      </>
    );
  }

  const { session, planning, siblings } = state;
  const at = now!;
  const writer = canWritePrepNotes(session);
  const phase = sessionPhase(session, at);
  const tabs = sessionTabs(phase, writer);
  const shown = tab && tabs.includes(tab) ? tab : defaultTab(phase, writer);
  const { number, prev, next } = siblings ? sessionNeighbours(siblings, session._id) : { number: null, prev: null, next: null };
  const name = sessionName(session.title, number);
  const campaign = session.campaign;
  const gmTitle = planning?.campaign.gmTitle || campaign?.gmTitle || DEFAULT_GM_TITLE;
  const standInName = planning?.session.gmOverride?.name ?? null;
  const gmName = standInName ?? gameMastersOf(planning);
  const place = placeOf(session, planning);

  return (
    <>
      <header className="hs-page-head hs-sess-head">
        {campaign ? <BackLink href={`/campaigns/${campaign._id}`}>{short(campaign.title)}</BackLink> : <BackLink href="/campaigns">Campaigns</BackLink>}
        {(prev || next) && (
          <nav className="hs-sess-steps" aria-label="The campaign’s sessions">
            {prev && (
              <Link className="hs-ghost" href={`/sessions/${prev.id}`} aria-label={`Previous session: ${prev.title}`} rel="prev">
                <span aria-hidden="true">←</span><span className="hs-sess-step-name">{prev.title}</span>
              </Link>
            )}
            {next && (
              <Link className="hs-ghost" href={`/sessions/${next.id}`} aria-label={`Next session: ${next.title}`} rel="next">
                <span className="hs-sess-step-name">{next.title}</span><span aria-hidden="true">→</span>
              </Link>
            )}
          </nav>
        )}
      </header>

      <SessionCard
        session={session}
        planning={planning}
        phase={phase}
        name={name}
        kicker={[campaign?.title, number && `Session ${number}`].filter(Boolean).join(' · ')}
        place={place}
        gmTitle={gmTitle}
        writer={writer}
        now={at}
        onEdit={() => setEditing(true)}
        onTorchChanged={reload}
      />

      {/* The round table: the GM at its head, the party in their seats, attendance, the ready check and the
          quest slips. #227 lays it here (and names it "Around the table"); quest links (#quests) already land
          on it. Until then it's an empty slot with no height. */}
      <section id="quests" className="hs-sess-table" data-slot="table" />

      <SessionTabs
        session={session}
        phase={phase}
        tabs={tabs}
        tab={shown}
        onTab={setTab}
        writer={writer}
        gmName={gmName}
        gmTitle={gmTitle}
        standInName={standInName}
        place={place}
        onSave={save}
      />

      {editing && (
        <EditSessionDialog
          session={session}
          name={name}
          onClose={() => setEditing(false)}
          // A new night may move it among the campaign's sessions.
          onSave={async (patch) => { await save(patch); if ('date' in patch) await reload(); }}
        />
      )}
    </>
  );
}

/** The campaign's Game Master(s) by name, from the planning read. */
function gameMastersOf(planning: PlanningRead | null): string | null {
  if (!planning) return null;
  const names = planning.party.filter((p) => planning.campaign.gameMasterIds.includes(p.id)).map((p) => p.name);
  return names.length ? names.join(' and ') : null;
}

/** Where it happens: online, the confirmed venue, or the place the GM typed. */
function placeOf(session: SessionDetail, planning: PlanningRead | null): string {
  if (session.isOnline) return session.location?.trim() || 'Online';
  const venue = planning?.session.venue;
  if (venue) return venue.address ? `${venue.name}, ${venue.address}` : venue.name;
  return session.location?.trim() || 'Place to be decided';
}
