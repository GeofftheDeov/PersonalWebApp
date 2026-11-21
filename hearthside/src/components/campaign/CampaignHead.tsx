"use client";

import CampaignBanner from '@/components/campaigns/CampaignBanner';
import StatusPill from '@/components/campaigns/StatusPill';
import GildedPanel from '@/components/design-system/GildedPanel';
import BackLink from '@/components/shell/BackLink';
import type { CampaignDetail } from '@/lib/campaignPage';

/**
 * A campaign's head, on the floor (#224): "← Back to Campaigns" (on phones,
 * "← Campaigns" in the shell's row), the banner in a gilded frame with the
 * owner's Change banner (or Add banner) and Remove, then the title as the
 * page's heading with its status and the party line, and Edit.
 */
export default function CampaignHead({ campaign, partyLine, canManageBanner, canEdit, onEdit, onChangeBanner, onRemoveBanner }: {
  campaign: CampaignDetail;
  /** "5 in the party · Geoff is Dungeon Master"; null when the viewer can't see the party. */
  partyLine: string | null;
  canManageBanner: boolean;
  /** Edit shows (anyone in the party, and admins), and the form isn't open already. */
  canEdit: boolean;
  onEdit: () => void;
  onChangeBanner: () => void;
  onRemoveBanner: () => void;
}) {
  return (
    <header className="hs-page-head hs-cp-head">
      <BackLink href="/campaigns" full="Back to Campaigns">Campaigns</BackLink>
      <GildedPanel className="hs-cp-banner">
        <CampaignBanner id={campaign._id} title={campaign.title} url={campaign.bannerUrl}>
          {canManageBanner && (
            <div className="hs-banner-tools">
              <button type="button" className="hs-banner-tool" onClick={onChangeBanner}>
                {campaign.bannerKey ? 'Change banner' : 'Add banner'}
              </button>
              {campaign.bannerKey && <button type="button" className="hs-banner-tool" onClick={onRemoveBanner}>Remove</button>}
            </div>
          )}
        </CampaignBanner>
      </GildedPanel>
      <div className="hs-cp-title-row">
        <div className="hs-cp-title">
          <div className="hs-cp-kicker">Campaign</div>
          <h1>{campaign.title}</h1>
          <p>
            <StatusPill status={campaign.status} />
            {partyLine && <span>· {partyLine}</span>}
          </p>
        </div>
        {canEdit && <button type="button" className="hs-btn-amber hs-cp-edit" onClick={onEdit}>Edit</button>}
      </div>
    </header>
  );
}
