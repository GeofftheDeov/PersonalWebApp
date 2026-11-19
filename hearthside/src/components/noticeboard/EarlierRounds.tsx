import { optionWhen, roundOutcome, type Poll } from '@/lib/noticeBoard';

/**
 * The night's earlier rounds (#57), folded away at the foot of the step: how
 * each ended, and who could make which night, so a re-shortlisted or failed
 * round stays on record.
 */
export default function EarlierRounds({ rounds, name }: { rounds: Poll[]; name: (id: string) => string }) {
  if (!rounds.length) return null;
  return (
    <details className="hs-board-rounds">
      <summary>Earlier rounds ({rounds.length})</summary>
      <ol>
        {rounds.map((r) => (
          <li key={r.id}>
            <span className="hs-board-round">Round {r.round} · {roundOutcome(r)}</span>
            <ul>
              {r.options.map((o) => (
                <li key={o.id} className={o.id === r.winningOptionId ? 'is-won' : undefined}>
                  {o.id === r.winningOptionId && '✓ '}
                  {o.start ? optionWhen(o.start, o.end) : 'A night'} · {o.approvals.length} of {r.eligibleIds.length}
                  {o.approvals.length ? ` · ${o.approvals.map(name).join(', ')}` : ''}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </details>
  );
}
