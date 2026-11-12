"use client";

import Link from 'next/link';
import GildedPanel from '@/components/design-system/GildedPanel';
import { campaignDates, type CampaignSummary } from '@/lib/campaigns';
import CampaignBanner from './CampaignBanner';
import StatusPill from './StatusPill';

export interface CampaignCardProps {
  campaign: CampaignSummary;
  /** Show the banner controls (the owner and admins: `canManageBanner`). */
  canManage: boolean;
  onChangeBanner: () => void;
  onRemoveBanner: () => void;
}

/**
 * One campaign on the Campaigns page (layout B, "Roster"; spec #69). The
 * banner is the card's background and the card is at least 4:1, growing if
 * the text needs room. The title, status, dates and description sit on a
 * gilded leather panel over the banner's left side, at most 60% of the card.
 * The owner's Change banner (or Add banner) and Remove sit bottom right.
 * Under 620px the banner is a strip across the top, with the panel below it.
 *
 * It renders an `<li>`: put it in a list.
 */
export default function CampaignCard({ campaign: c, canManage, onChangeBanner, onRemoveBanner }: CampaignCardProps) {
  const dates = campaignDates(c);
  return (
    <li className="hs-roster-card">
      <CampaignBanner id={c._id} title={c.title} url={c.bannerUrl} />
      <GildedPanel className="hs-roster-info">
        <h3><Link className="hs-roster-title" href={`/campaigns/${c._id}`}>{c.title}</Link></h3>
        <div className="hs-roster-meta">
          <StatusPill status={c.status} />
          {dates && <span className="hs-when">{dates}</span>}
        </div>
        {c.description && <p className="hs-roster-desc">{c.description}</p>}
      </GildedPanel>
      {canManage && (
        <div className="hs-banner-tools">
          <button type="button" className="hs-banner-tool" onClick={onChangeBanner}>
            {c.bannerKey ? 'Change banner' : 'Add banner'}
          </button>
          {c.bannerKey && (
            <button type="button" className="hs-banner-tool" onClick={onRemoveBanner}>Remove</button>
          )}
        </div>
      )}
    </li>
  );
}
