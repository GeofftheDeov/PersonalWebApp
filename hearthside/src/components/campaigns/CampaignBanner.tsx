"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { campaignInitials, clothFor } from '@/lib/campaigns';

/**
 * The dyed-cloth fallback for a campaign without a banner (spec #69): a cloth
 * in one of Hearthside's dyes, picked by the campaign's id so it always looks
 * the same, with the campaign's initials stitched in gold.
 */
export function DyedCloth({ id, title }: { id: string; title: string }) {
  const [c1, c2] = clothFor(id);
  return (
    <div className="hs-cloth" role="img" aria-label={`${title}: no banner yet`} style={{ '--c1': c1, '--c2': c2 } as CSSProperties}>
      <span>{campaignInitials(title)}</span>
    </div>
  );
}

export interface CampaignBannerProps {
  /** The campaign's id: picks the cloth when there's no banner. */
  id: string;
  title: string;
  /** The campaign's `bannerUrl`; null or a picture that won't load shows the cloth. */
  url?: string | null;
  className?: string;
  /** Laid over the banner. */
  children?: ReactNode;
}

/**
 * A campaign's banner (#81) at 4:1, or its dyed cloth. For the Campaigns
 * page's cards, the invite page (#232) and the Almanac (#228):
 *
 *   <CampaignBanner id={c._id} title={c.title} url={c.bannerUrl} />
 *
 * By itself it keeps 4:1. Inside a Campaigns card it fills the card instead
 * (globals.css, `.hs-roster-card`).
 */
export default function CampaignBanner({ id, title, url, className, children }: CampaignBannerProps) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  return (
    <div className={className ? `hs-banner ${className}` : 'hs-banner'}>
      {url && !broken
        ? <img src={url} alt={`${title} banner`} onError={() => setBroken(true)} />
        : <DyedCloth id={id} title={title} />}
      {children}
    </div>
  );
}
