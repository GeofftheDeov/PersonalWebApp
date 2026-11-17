"use client";

import Link from 'next/link';
import { useId, useState } from 'react';
import NoticeSheet from '@/components/design-system/NoticeSheet';
import GildedDialog from '@/components/GildedDialog';
import { api, errorOf } from '@/lib/api';
import { nameIn, placeLine, plannerSteps, sheetSeal, type PlanningState } from '@/lib/noticeBoard';
import { nightLine } from '@/lib/sessionPage';
import FoodStep from './FoodStep';
import NightStep from './NightStep';
import { PlannerStep, PlannerSteps } from './PlannerSteps';
import VenueStep, { VenueLine } from './VenueStep';

/** A planning action on this session: POST /api/planning/sessions/:id/<path>. True when it went through. */
export type Act = (path: string, body?: unknown) => Promise<boolean>;

const SEAL_CLASS = { vote: 'hs-seal', tie: 'hs-seal is-tie', wait: 'hs-seal is-planning' } as const;

/**
 * One session being planned, pinned up as a NoticeSheet (#222): its title
 * and where it will be, a seal saying where it stands, then its numbered
 * PlannerSteps (the night; in person, the venue and the food), each with
 * its votes and the viewer's actions. The GM can cancel the planning, in a
 * gilded dialog. Every action goes through the planning API, then the board
 * is read again (`onChanged`); the live channel tells everyone else's.
 *
 * `kicker`: the line above the title. The Hearth names the campaign; a
 * campaign's page (#225) needn't.
 */
export default function NoticeBoardSheet({ state, kicker, onChanged }: {
  state: PlanningState;
  kicker: string;
  onChanged: () => void | Promise<void>;
}) {
  const { session: s, viewer, campaign } = state;
  const gm = viewer.isGameMaster;
  const name = nameIn(state);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  const act: Act = async (path, body) => {
    setBusy(true);
    setError(null);
    let ok = true;
    try {
      await api.post(`/api/planning/sessions/${encodeURIComponent(s.id)}/${path}`, body ?? {});
    } catch (err) {
      ok = false;
      setError(errorOf(err, 'That didn’t go through. Try again in a moment.'));
    }
    await onChanged();
    setBusy(false);
    return ok;
  };

  const seal = sheetSeal(state);

  return (
    <NoticeSheet seed={s.id} className="hs-board-sheet" aria-labelledby={titleId}>
      <div className="hs-sheet-head">
        <div className="hs-board-head-text">
          <div className="hs-kicker">{kicker}</div>
          <h3 className="hs-sheet-title" id={titleId}>{s.title}</h3>
          <p className="hs-byline">{placeLine(state, name)}</p>
        </div>
        <span className={SEAL_CLASS[seal.tone]}>{seal.label}</span>
      </div>

      <PlannerSteps label={`Planning ${s.title}`}>
        {plannerSteps(state).map((step) => (
          <PlannerStep
            key={step.key}
            n={step.n}
            title={step.title}
            state={step.state}
            status={
              step.key === 'night' && step.state === 'live' && state.night ? `round ${state.night.round}`
                : step.key === 'venue' && step.state === 'live' && state.venue ? `round ${state.venue.round}`
                  : undefined
            }
          >
            {step.key === 'night' && (step.state === 'live'
              ? <NightStep state={state} busy={busy} act={act} />
              : s.date && <p className="hs-board-line">{nightLine(s.date, s.endDate)}</p>)}
            {step.key === 'venue' && (step.state === 'live'
              ? <VenueStep state={state} busy={busy} act={act} />
              : s.venue
                ? <p className="hs-board-line"><VenueLine venue={s.venue} name={name} note={s.hostId ? `host: ${s.hostId === viewer.id ? 'you' : name(s.hostId)}` : undefined} /></p>
                : <p className="hs-board-fine">Once the night is set, the party picks where.</p>)}
            {step.key === 'food' && (step.state === 'live'
              ? <FoodStep state={state} busy={busy} act={act} />
              : <p className="hs-board-fine">{s.foodMode === 'potluck' ? 'Potluck: everyone brings something.' : `Food provided by ${s.foodOwnerId === viewer.id ? 'you' : name(s.foodOwnerId)}.`}</p>)}
          </PlannerStep>
        ))}
      </PlannerSteps>

      {error && !cancelling && <p className="hs-board-alert" role="alert">{error}</p>}

      <div className="hs-board-foot">
        <Link className="hs-sess-link" href={`/sessions/${s.id}`}>The session’s page →</Link>
        <Link className="hs-sess-link" href={`/campaigns/${campaign.id}#notice-board`}>{campaign.title}’s Notice Board →</Link>
        {gm && <button type="button" className="hs-btn hs-board-cancel" disabled={busy} onClick={() => setCancelling(true)}>Cancel planning</button>}
      </div>

      {cancelling && (
        <GildedDialog title="Cancel planning?" onClose={() => setCancelling(false)}>
          <div className="hs-form">
            <p className="hs-dialog-text">
              Stop planning “{s.title}”? The party will be told.
            </p>
            <div className="hs-actions">
              <button type="button" className="hs-btn-amber" disabled={busy}
                onClick={async () => { if (await act('cancel')) setCancelling(false); }}>Cancel planning</button>
              <button type="button" className="hs-ghost" onClick={() => setCancelling(false)}>Keep planning</button>
            </div>
            {error && <p className="hs-alert" role="alert">{error}</p>}
          </div>
        </GildedDialog>
      )}
    </NoticeSheet>
  );
}
