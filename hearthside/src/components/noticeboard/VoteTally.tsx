import type { ReactNode } from 'react';
import type { TallyRow } from '@/lib/noticeBoard';

export interface VoteTallyItem {
  row: TallyRow;
  /** What's being voted on, with the viewer's box or radio when they may vote: a night, or a venue. */
  label: ReactNode;
  /** The count, at the row's end: "2 of 3", "1 vote". */
  count: string;
  /** Under the bar: who chose it, and any notes ("meets quorum", "suggested by Isolde"). */
  note?: ReactNode;
  /** On the right of the note: the GM's pick on a tie. */
  action?: ReactNode;
}

/**
 * VoteTally (the design system's): each option with a bar for its share of
 * the votes, the leader's bar in the seal's red. The options are a list;
 * the ballot's boxes sit in each row's label.
 */
export default function VoteTally({ label, items }: { label: string; items: VoteTallyItem[] }) {
  return (
    <ul className="hs-votes" aria-label={label}>
      {items.map(({ row, label: what, count, note, action }) => (
        <li key={row.id} className={row.lead ? 'hs-vote is-lead' : 'hs-vote'}>
          <span className="hs-vote-what">{what}</span>
          <span className="hs-vote-who">{count}</span>
          <span className="hs-vote-bar" aria-hidden="true"><i style={{ width: `${Math.round(row.share * 100)}%` }} /></span>
          {(note || action) && (
            <span className="hs-vote-foot">
              {note && <span className="hs-vote-note">{note}</span>}
              {action}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
