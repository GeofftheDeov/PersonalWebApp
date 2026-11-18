"use client";

import type { ReactNode } from 'react';
import { KIND_TAG, questWhen, type Quest } from '@/lib/quests';

/**
 * Quests as paper slips (#227, from the session prototype): a session's
 * table puts them by each player's seat, and the Almanac (#228) on each
 * session's sheet. A slip's box ticks the quest off when `canTick` allows;
 * there's no undoing it (the API has none). Tick through `completeQuest`
 * (or `useSessionTable().tick`) so Your Quests in the rail follows.
 *
 * Sized in `em`, so a place can scale the slips with its font size (the
 * table does, with the table's width).
 *
 *   <QuestSlips label="Your quests" quests={qs} now={now} canTick={(q) => …} ticking={ids} onTick={tick} />
 */
export default function QuestSlips({ label, quests, now, canTick, ticking, onTick, children, className }: {
  /** The list's accessible name: "Your quests", "Tobin's quests". */
  label: string;
  quests: readonly Quest[];
  now: Date;
  canTick: (q: Quest) => boolean;
  /** Quests whose tick the server hasn't answered yet. */
  ticking?: ReadonlySet<string>;
  onTick: (q: Quest) => void;
  /** More slips after the quests: the table's "+ quest". */
  children?: ReactNode;
  className?: string;
}) {
  if (!quests.length && !children) return null;
  return (
    <ul className={className ? `hs-slips ${className}` : 'hs-slips'} aria-label={label}>
      {quests.map((q) => (
        <QuestSlip key={q.id} quest={q} now={now} tickable={canTick(q)} busy={!!ticking?.has(q.id)} onTick={() => onTick(q)} />
      ))}
      {children}
    </ul>
  );
}

/** One slip: the box, the quest's title, and when it's due (or that it's done). */
export function QuestSlip({ quest: q, now, tickable, busy, onTick }: {
  quest: Quest;
  now: Date;
  tickable: boolean;
  busy?: boolean;
  onTick: () => void;
}) {
  const done = q.status === 'done';
  const tag = KIND_TAG[q.kind];
  return (
    <li className={done ? 'hs-slip is-done' : 'hs-slip'}>
      <button
        type="button"
        className="hs-box"
        role="checkbox"
        aria-checked={done}
        aria-label={`${q.title}: ${done ? 'done' : tickable ? 'mark done' : 'not done yet'}`}
        disabled={done || !tickable || busy}
        onClick={onTick}
      />
      <span className="hs-slip-text">
        <span className="hs-slip-title">{q.title}</span>
        {tag && <span className="hs-tag">{tag}</span>}
        <small>{done ? 'Done' : q.dueAt ?? q.session.date ? `Due ${questWhen(q, now)}` : questWhen(q, now)}</small>
      </span>
    </li>
  );
}
