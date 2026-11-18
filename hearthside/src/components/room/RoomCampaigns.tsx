"use client";

import Link from 'next/link';
import CampaignBanner from '@/components/campaigns/CampaignBanner';
import StatusPill from '@/components/campaigns/StatusPill';
import { campaignDates, type CampaignSummary } from '@/lib/campaigns';

/**
 * The Campaigns tab (layout A): the player's campaigns, each a banner (or
 * its dyed cloth) with its title and status, linking to its page. Your Room
 * only: another player's page never lists campaigns (spec #69).
 */
export default function RoomCampaigns({ campaigns }: { campaigns: CampaignSummary[] | null }) {
  if (!campaigns) return <div className="hs-room-sec"><p className="hs-room-empty" role="status">Gathering your campaigns…</p></div>;
  if (!campaigns.length) {
    return (
      <div className="hs-room-sec">
        <p className="hs-room-empty">Not in any campaigns yet. A Game Master can invite you, or you can start one from <Link href="/campaigns">Campaigns</Link>.</p>
      </div>
    );
  }
  return (
    <ul className="hs-room-ccs" aria-label="Your campaigns">
      {campaigns.map((c) => {
        const dates = campaignDates(c);
        return (
          <li key={c._id} className={c.status === 'Completed' ? 'hs-room-cc is-done' : 'hs-room-cc'}>
            <CampaignBanner id={c._id} title={c.title} url={c.bannerUrl} />
            <div className="hs-room-cc-body">
              <h3><Link href={`/campaigns/${c._id}`}>{c.title}</Link></h3>
              <div className="hs-room-cc-meta">
                <StatusPill status={c.status} />
                {dates && <span className="hs-when">{dates}</span>}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
