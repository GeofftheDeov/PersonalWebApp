"use client";

import Link from 'next/link';
import { useId } from 'react';
import NoticeSheet from '@/components/design-system/NoticeSheet';
import QuestSlips from '@/components/quests/QuestSlips';
import { phaseOf, placeLine, questsLine, sealOf, whenLine, type AlmanacSession } from '@/lib/almanac';
import type { Quest } from '@/lib/quests';

/** What the Almanac's slips need to tick a quest off. */
export interface SlipActions {
  now: Date;
  canTick: (q: Quest) => boolean;
  ticking: ReadonlySet<string>;
  onTick: (q: Quest) => void;
}

/** A session's name, or "Session" if it has none. */
export const titleOf = (s: Pick<AlmanacSession, 'title'>): string => s.title?.trim() || 'Session';

/**
 * One session on parchment (the design system's NoticeSheet), as the list and
 * the calendar's chosen day show it: its campaign, name, night and place, its
 * seal, the viewer's quests on it as paper slips (#227's) ticked in place,
 * and a link to its page.
 */
export default function AlmanacSheet({ session: s, slips }: { session: AlmanacSession; slips: SlipActions }) {
  const titleId = useId();
  const seal = sealOf(s, slips.now);
  const off = phaseOf(s, slips.now) === 'cancelled';
  return (
    <NoticeSheet seed={s.id} className="hs-alm-sheet" aria-labelledby={titleId}>
      <div className="hs-sheet-head">
        <div className="hs-alm-sheet-text">
          <div className="hs-kicker">{s.campaign.title}</div>
          <h3 className="hs-sheet-title" id={titleId}>{titleOf(s)}</h3>
          <p className="hs-byline">{whenLine(s)} · {placeLine(s)}</p>
        </div>
        <span className={seal.cls}>{seal.label}</span>
      </div>
      {s.quests.length ? (
        <>
          <p className="hs-alm-qh">Your quests · {questsLine(s.quests)}</p>
          <QuestSlips label="Your quests" quests={s.quests} now={slips.now} canTick={slips.canTick} ticking={slips.ticking} onTick={slips.onTick} className="hs-alm-sheet-slips" />
        </>
      ) : (
        <p className="hs-alm-qnone">{off ? 'No quests: the session is off.' : 'No quests for you this session.'}</p>
      )}
      <div className="hs-btn-row">
        <Link className={off ? 'hs-btn' : 'hs-btn is-primary'} href={`/sessions/${encodeURIComponent(s.id)}`}>Open the session</Link>
      </div>
    </NoticeSheet>
  );
}
