"use client";

import Link from 'next/link';
import { useEffect, useState } from 'react';
import NoticeBoardSheet from '@/components/noticeboard/NoticeBoardSheet';
import { api, errorOf } from '@/lib/api';
import type { CampaignSummary } from '@/lib/campaigns';
import { boardSheets, greeting, hearthLine } from '@/lib/noticeBoard';
import { useRequiredSession } from '@/lib/session';
import { useNoticeBoards } from '@/lib/useNoticeBoards';

/**
 * The Hearth, Hearthside's home (#222, spec #69): a greeting, then the
 * Notice Board, one NoticeSheet on parchment for each session being planned
 * in the player's campaigns, the ones waiting on their vote first. Each has
 * its numbered steps, votes and actions, through the planning API, and stays
 * current over the live channel. With nothing being planned, a short note on
 * the floor says so. Your Quests and Letters are the shell's.
 */
export default function HearthPage() {
  const { status, user } = useRequiredSession();
  const [campaignIds, setCampaignIds] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  // The time of day is the browser's, so the greeting waits for it rather than the server's clock.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => setNow(new Date()), []);

  useEffect(() => {
    if (status !== 'signedIn') return;
    api.get<CampaignSummary[]>('/api/campaigns')
      .then((list) => { setCampaignIds(list.map((c) => c._id)); setListError(null); })
      .catch((err) => setListError(errorOf(err, 'Your campaigns couldn’t be read. Try again in a moment.')));
  }, [status]);

  const { boards, ready, errors, reload } = useNoticeBoards(campaignIds);
  const sheets = boardSheets(boards);
  const allFailed = ready && !!campaignIds?.length && campaignIds.every((id) => id in errors);
  const error = listError ?? (allFailed ? Object.values(errors)[0] : null);
  const loaded = ready && !error;

  return (
    <>
      <header className="hs-page-head">
        <h1>{now && user ? greeting(now, user) : 'The Hearth'}</h1>
        <p>{loaded ? hearthLine(sheets) : 'The fire’s lit.'}</p>
      </header>

      <section className="hs-board" aria-labelledby="hs-board-heading">
        <h2 className="hs-sec" id="hs-board-heading">
          <span>The Notice Board</span>
          {loaded && sheets.length > 0 && <span className="hs-aside">{sheets.length} being planned</span>}
        </h2>
        {error ? (
          <p className="hs-note" role="alert">{error}</p>
        ) : !loaded ? (
          <p className="hs-note">Reading the Notice Board…</p>
        ) : sheets.length ? (
          <div className="hs-board-sheets">
            {sheets.map((state) => (
              <NoticeBoardSheet
                key={state.session.id}
                state={state}
                kicker={state.campaign.title}
                onChanged={() => reload(state.session.campaignId)}
              />
            ))}
          </div>
        ) : campaignIds?.length ? (
          <p className="hs-note hs-board-empty">
            Nothing’s being planned in your campaigns. When a session is, its notice goes up here for your vote.
          </p>
        ) : (
          <p className="hs-note hs-board-empty">
            You’re not in a campaign yet. Start or join one on <Link href="/campaigns">Campaigns</Link>, and its sessions go up here as they’re planned.
          </p>
        )}
      </section>
    </>
  );
}
