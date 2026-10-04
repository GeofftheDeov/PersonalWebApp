"use client";

import React, { useEffect, useState } from 'react';
import { Map } from 'lucide-react';
import { fallbackBannerStyle } from '@/lib/banner';

/**
 * A campaign's 4:1 banner (#81), or, with none (or one that fails to load), a
 * patterned fallback in the campaign's own colours so the layout never breaks.
 */
export default function CampaignBanner({ url, seed, title, compact = false, className = '', children }: {
    url?: string | null;
    /** Picks the fallback's colours; the campaign id. */
    seed: string;
    /** For the image's alt text. */
    title: string;
    /** Small thumbnails skip the fallback's icon. */
    compact?: boolean;
    className?: string;
    /** Overlaid on the banner (e.g. the owner's "Change banner" button). */
    children?: React.ReactNode;
}) {
    const [broken, setBroken] = useState(false);
    useEffect(() => setBroken(false), [url]);
    const showImage = !!url && !broken;

    return (
        <div className={`relative aspect-[4/1] overflow-hidden ${className}`} style={showImage ? undefined : fallbackBannerStyle(seed)}>
            {showImage ? (
                <img src={url!} alt={`${title} banner`} className="absolute inset-0 w-full h-full object-cover" onError={() => setBroken(true)} />
            ) : !compact && (
                <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                    <Map className="w-1/12 h-auto max-w-12 text-white/40" />
                </div>
            )}
            {children}
        </div>
    );
}
