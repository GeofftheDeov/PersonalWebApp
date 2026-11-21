"use client";

import { useEffect, useRef, useState } from 'react';
import NoticeBoardSheet from '@/components/noticeboard/NoticeBoardSheet';
import type { Board } from '@/lib/noticeBoard';
import KickoffSheet from './KickoffSheet';

/** Where bells and the Hearth link to a campaign's Notice Board (#214): `/campaigns/:id#notice-board`. */
export const NOTICE_BOARD_ANCHOR = 'notice-board';

/**
 * A campaign's Notice Board (#225), at `#notice-board`: one parchment sheet
 * per session being planned, carrying every control the portfolio's
 * planning cards have, and the GM's "Plan a session", which pins up a new
 * notice to fill in. With nothing pinned up, a note on the floor says so.
 * Its data is the page's `useNoticeBoard`, shared with Coming up.
 *
 * A link to `#notice-board` lands here: the browser can't scroll to it
 * before the board has loaded, so the board scrolls itself into view once.
 */
export default function CampaignNoticeBoard({ campaignId, campaignTitle, board, error, reload }: {
  campaignId: string;
  campaignTitle: string;
  board: Board | null;
  error: string | null;
  reload: () => Promise<void>;
}) {
  const ref = useRef<HTMLElement>(null);
  const [kickoff, setKickoff] = useState(false);
  const landed = useRef(false);
  const loaded = !!board || !!error;

  useEffect(() => {
    if (!loaded || landed.current) return;
    landed.current = true;
    if (window.location.hash === `#${NOTICE_BOARD_ANCHOR}`) ref.current?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  const n = board?.planning.length ?? 0;

  return (
    <section id={NOTICE_BOARD_ANCHOR} ref={ref} className="hs-board hs-cp-board" aria-labelledby="hs-cp-board-h">
      <div className="hs-cp-sec-row">
        <h2 className="hs-sec" id="hs-cp-board-h">
          <span>The Notice Board</span>
          {board && <span className="hs-aside">{n ? `${n} pinned up` : 'nothing pinned'}</span>}
        </h2>
        {board?.canPlan && !kickoff && (
          <button type="button" className="hs-btn-amber" onClick={() => setKickoff(true)}>Plan a session</button>
        )}
      </div>
      {!board ? (
        <p className="hs-note" role={error ? 'alert' : undefined}>{error ?? 'Reading the Notice Board…'}</p>
      ) : (
        <div className="hs-board-sheets">
          {kickoff && (
            <KickoffSheet campaignId={campaignId} campaignTitle={campaignTitle} party={board.party}
              onStarted={async () => { await reload(); setKickoff(false); }} onClose={() => setKickoff(false)} />
          )}
          {board.planning.map((state) => (
            <NoticeBoardSheet key={state.session.id} state={state} kicker="A summons for the party" onChanged={reload} onCampaignPage />
          ))}
          {n === 0 && !kickoff && (
            <p className="hs-note hs-board-empty">
              Nothing pinned up. When the {board.gmTitle} starts planning a session, the vote goes here.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
