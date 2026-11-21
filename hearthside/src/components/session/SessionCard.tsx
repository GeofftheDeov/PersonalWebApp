"use client";

import Link from 'next/link';
import NoticeSheet from '@/components/design-system/NoticeSheet';
import { nightLine, whenFromNow, type SessionPhase } from '@/lib/sessionPage';
import type { PlanningRead, SessionDetail } from '@/lib/useSessionPage';
import SessionTorch from './SessionTorch';

const SEAL: Record<SessionPhase | 'planning', { label: string; cls: string }> = {
  planning: { label: 'Being planned', cls: 'hs-seal is-planning' },
  before: { label: 'Coming up', cls: 'hs-seal' },
  after: { label: 'Played', cls: 'hs-seal is-ok' },
  cancelled: { label: 'Cancelled', cls: 'hs-seal is-cancelled' },
};

/**
 * The session's parchment card, above the table (layout C, revised): its
 * name, night, place and status, with Edit for the GM; the torch; the
 * Notice Board line while it's being planned; and Join the table and Add to
 * Google Calendar before it.
 */
export default function SessionCard({ session, planning, phase, name, kicker, place, gmTitle, writer, now, onEdit, onTorchChanged }: {
  session: SessionDetail;
  planning: PlanningRead | null;
  phase: SessionPhase;
  name: string;
  kicker: string;
  place: string;
  gmTitle: string;
  writer: boolean;
  now: Date;
  onEdit: () => void;
  onTorchChanged: () => void | Promise<void>;
}) {
  const isPlanning = session.status === 'planning';
  const seal = SEAL[isPlanning ? 'planning' : phase];
  const campaignId = session.campaign?._id;
  const tableLink = session.campaign?.tableLink;
  const soon = phase === 'before' && session.date ? whenFromNow(session.date, now) : '';
  const byline = [nightLine(session.date, session.endDate), place, soon].filter(Boolean).join(' · ');
  const joinable = phase === 'before' && !isPlanning && !!session.isOnline && !!tableLink;
  const calendar = phase === 'before' && !isPlanning && !!session.googleCalendarLink;

  return (
    <NoticeSheet seed={session._id} className="hs-sess-card" aria-labelledby="hs-sess-title">
      <div className="hs-sheet-head">
        <div className="hs-sess-card-text">
          <div className="hs-kicker">{kicker}</div>
          <h1 className="hs-sheet-title" id="hs-sess-title">{name}</h1>
          <p className="hs-byline">{byline}</p>
        </div>
        <div className="hs-sess-card-tools">
          <span className={seal.cls}>{seal.label}</span>
          {writer && <button type="button" className="hs-btn" onClick={onEdit}>Edit</button>}
        </div>
      </div>

      {isPlanning && (
        <div className="hs-sess-banner">
          <span>Still being planned: no night yet.</span>
          {campaignId && <Link className="hs-sess-link" href={`/campaigns/${campaignId}#notice-board`}>Vote on the Notice Board →</Link>}
        </div>
      )}
      {phase === 'cancelled' && <div className="hs-sess-banner"><span>This session was cancelled.</span></div>}

      {phase === 'before' && planning && (
        <SessionTorch
          sessionId={session._id}
          gmTitle={gmTitle}
          party={planning.party}
          gameMasterIds={planning.campaign.gameMasterIds}
          standIn={planning.session.gmOverride}
          viewerId={planning.viewer.id}
          canPass={planning.viewer.canPassTorch}
          onChanged={onTorchChanged}
        />
      )}

      {(joinable || calendar) && (
        <div className="hs-btn-row">
          {joinable && <a className="hs-btn is-primary" href={tableLink!} target="_blank" rel="noopener noreferrer">Join the table</a>}
          {calendar && <a className="hs-btn" href={session.googleCalendarLink!} target="_blank" rel="noopener noreferrer">Add to Google Calendar</a>}
        </div>
      )}
    </NoticeSheet>
  );
}
