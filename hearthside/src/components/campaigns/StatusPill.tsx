import { statusLabel, type CampaignStatus } from '@/lib/campaigns';

/**
 * A campaign's status (spec #69): In progress is amber with a lit dot,
 * Completed a moss seal, Not started a muted outline. Seal red stays for
 * "needs someone", as the design system says.
 */
export default function StatusPill({ status }: { status: CampaignStatus }) {
  const tone = status === 'In Progress' ? ' is-live' : status === 'Completed' ? ' is-done' : '';
  return <span className={`hs-status${tone}`}>{statusLabel(status)}</span>;
}
