"use client";

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { nightLine } from '@/lib/sessionPage';
import { earlierRounds, nameIn, optionWhen, voteTally, waitingOn, type PlanningState } from '@/lib/noticeBoard';
import type { PickedTime } from '@/lib/overlap';
import EarlierRounds from './EarlierRounds';
import OverlapPicker from './OverlapPicker';
import VoteTally from './VoteTally';
import type { Act } from './NoticeBoardSheet';

/**
 * The night step (#57): the party ticks every night they can make, and the
 * vote closes when everyone has voted or the GM moves it forward. A tie goes
 * to the GM. With no vote open (just kicked off, or no night had enough of
 * the party) the GM shortlists nights from the party's availability, on the
 * campaign's Notice Board (#225), with the overlap picker; there the GM can
 * also re-shortlist an open or tied vote, and the earlier rounds stay on
 * record. The Hearth links to the campaign's board for those instead.
 */
export default function NightStep({ state, busy, act, onCampaignPage = false }: {
  state: PlanningState;
  busy: boolean;
  act: Act;
  /** On the campaign's own Notice Board: the overlap picker, re-shortlisting and the earlier rounds. */
  onCampaignPage?: boolean;
}) {
  const { session: s, night, viewer, campaign } = state;
  const gm = viewer.isGameMaster;
  const name = nameIn(state);
  const open = night?.status === 'open';
  const tie = night?.status === 'closed' && night.result === 'tie';
  const failed = night?.status === 'closed' && night.result === 'no_quorum';
  const eligible = !!night?.eligibleIds.includes(viewer.id);
  const voted = !!night?.voted.includes(viewer.id);

  // The nights the viewer has saved, keyed on the round and their own votes rather than the poll: the
  // board is read again whenever anyone acts, and someone else's vote mustn't undo boxes ticked but not saved.
  const savedKey = `${night?.id ?? ''}|${(night?.options ?? []).filter((o) => o.approvals.includes(viewer.id)).map((o) => o.id).join(',')}`;
  const saved = useMemo(() => new Set(savedKey.split('|')[1].split(',').filter(Boolean)), [savedKey]);
  const [choice, setChoice] = useState<Set<string>>(saved);
  useEffect(() => setChoice(saved), [saved]);
  const [reshortlisting, setReshortlisting] = useState(false);
  const shortlist = async (times: PickedTime[]) => {
    if (await act(open ? 'reshortlist' : 'shortlist', { options: times })) setReshortlisting(false);
  };
  const picking = onCampaignPage && gm && (!open || reshortlisting);

  const toggle = (id: string, on: boolean) => setChoice((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  const waiting = waitingOn(night).map(name);
  const shortlistLink = (
    <Link className="hs-sess-link" href={`/campaigns/${campaign.id}#notice-board`}>Shortlist nights on the campaign’s Notice Board →</Link>
  );

  return (
    <>
      {s.date && (
        <p className="hs-board-line">It’s set for {nightLine(s.date, s.endDate)} until a new night is confirmed.</p>
      )}
      {failed && (
        <p className="hs-board-line">
          Round {night!.round}: none of those nights had enough of the party (it needed {night!.quorum}).{gm && onCampaignPage ? ' Shortlist some new ones.' : ''}
        </p>
      )}

      {open && (
        <form onSubmit={(e) => { e.preventDefault(); act('vote', { optionIds: [...choice] }); }}>
          <p className="hs-board-line">{eligible ? 'Tick every night you can make.' : 'The party is voting on these nights.'}</p>
          <VoteTally
            label="The nights"
            items={voteTally(night!, name, viewer.id).map((row) => {
              const o = night!.options.find((x) => x.id === row.id)!;
              const when = optionWhen(o.start!, o.end);
              return {
                row,
                label: eligible ? (
                  <label className="hs-board-pick">
                    <input type="checkbox" checked={choice.has(o.id)} onChange={(e) => toggle(o.id, e.target.checked)} aria-label={`I can make ${when}`} />
                    <span>{when}</span>
                  </label>
                ) : when,
                count: `${row.count} of ${row.of}`,
                note: [row.meetsQuorum ? 'Meets quorum' : '', row.voters.join(', ')].filter(Boolean).join(' · ') || undefined,
              };
            })}
          />
          <p className="hs-board-fine">
            Quorum {night!.quorum} · closes when everyone has voted{waiting.length ? ` · waiting on ${waiting.join(', ')}` : ''}
          </p>
          <div className="hs-btn-row">
            {eligible && (
              <button type="submit" className="hs-btn is-primary" disabled={busy}>
                {choice.size === 0 ? 'I can’t make any of these' : `${voted ? 'Update my vote' : 'Vote'}: I can make ${choice.size}`}
              </button>
            )}
            {gm && <button type="button" className="hs-btn" disabled={busy} onClick={() => act('advance')}>Move forward now</button>}
            {gm && onCampaignPage && (
              <button type="button" className="hs-btn" aria-expanded={reshortlisting} disabled={busy}
                onClick={() => setReshortlisting((r) => !r)}>{reshortlisting ? 'Keep these nights' : 'Re-shortlist'}</button>
            )}
          </div>
          {voted && <p className="hs-board-done" role="status">You’ve voted. You can change it until the vote closes.</p>}
        </form>
      )}

      {tie && (
        <>
          <p className="hs-board-line">The vote tied. {gm ? 'Pick the night:' : `The ${campaign.gmTitle} will pick between:`}</p>
          <VoteTally
            label="The tied nights"
            items={voteTally(night!, name, viewer.id).filter((row) => night!.tiedOptionIds.includes(row.id)).map((row) => {
              const o = night!.options.find((x) => x.id === row.id)!;
              return {
                row,
                label: optionWhen(o.start!, o.end),
                count: `${row.count} of ${row.of}`,
                note: row.voters.join(', ') || undefined,
                action: gm && (
                  <button type="button" className="hs-btn" disabled={busy} onClick={() => act('tiebreak', { optionId: o.id })}>Pick this night</button>
                ),
              };
            })}
          />
          {gm && !onCampaignPage && <p className="hs-board-fine">Or shortlist new nights: {shortlistLink}</p>}
        </>
      )}

      {!open && !tie && !failed && !gm && <p className="hs-board-line">The {campaign.gmTitle} is choosing some nights to vote on.</p>}
      {!open && !tie && gm && !onCampaignPage && <p className="hs-board-line">{shortlistLink}</p>}

      {picking && (
        <div className={open || tie ? 'hs-board-more' : undefined}>
          {(open || tie) && <p className="hs-board-line">Or shortlist new nights{open ? ' (this round’s votes are discarded)' : ''}:</p>}
          <OverlapPicker
            campaignId={campaign.id}
            submitting={busy}
            submitLabel={open || tie ? 'Re-shortlist' : 'Send to the party'}
            onSubmit={shortlist}
            onCancel={reshortlisting ? () => setReshortlisting(false) : undefined}
          />
        </div>
      )}

      {onCampaignPage && <EarlierRounds rounds={earlierRounds(state)} name={name} />}
    </>
  );
}
