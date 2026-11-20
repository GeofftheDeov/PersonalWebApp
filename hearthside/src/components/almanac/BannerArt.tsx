"use client";

import { useEffect, useState, type CSSProperties } from 'react';
import { campaignInitials, clothFor } from '@/lib/campaigns';

/**
 * A campaign's banner as a picture behind something else (#228): a session on
 * the calendar, a pick in the campaign filter. It fills its box (`.hs-alm-bn`,
 * placed by the CSS of where it sits) and is decorative, since the campaign's
 * name is always written beside it. With no banner, or one that won't load, it's
 * the campaign's dyed cloth from the Campaigns page (#223).
 */
export default function BannerArt({ id, title, url, className }: {
  id: string;
  title: string;
  url?: string | null;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  const [c1, c2] = clothFor(id);
  return (
    <span className={className ? `hs-alm-bn ${className}` : 'hs-alm-bn'} aria-hidden="true">
      {url && !broken
        ? <img src={url} alt="" onError={() => setBroken(true)} />
        : <span className="hs-cloth" style={{ '--c1': c1, '--c2': c2 } as CSSProperties}><span>{campaignInitials(title)}</span></span>}
    </span>
  );
}
