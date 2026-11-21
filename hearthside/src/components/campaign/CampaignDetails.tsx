"use client";

import GildedPanel from '@/components/design-system/GildedPanel';
import {
  campaignFacts, gmTitleOf, memberName,
  type CampaignDetail, type Member, type PartyView,
} from '@/lib/campaignPage';
import CampaignTorch from './CampaignTorch';

/**
 * A campaign's details on gilded leather (#224): its description in the story
 * face, when it started and ended, then when it was set up, its Game Master
 * (with the torch), owner, quorum, table and Discord, as the portfolio's page
 * lists them.
 */
export default function CampaignDetails({ campaign, members, view, viewerId, onTorchChanged }: {
  campaign: CampaignDetail;
  /** Null when the viewer may not see the party. */
  members: Member[] | null;
  view: PartyView;
  viewerId: string | null;
  onTorchChanged: (owner: string | null) => Promise<void>;
}) {
  const facts = campaignFacts(campaign);
  const title = gmTitleOf(campaign);
  const gms = (members ?? []).filter((m) => m.status === 'Game Master');
  const ownerMember = campaign.owner ? members?.find((m) => m.playerId === campaign.owner) : null;
  const owner = !campaign.owner ? 'Admin-managed' : ownerMember ? memberName(ownerMember) : members ? 'Not in the party' : '—';

  return (
    <GildedPanel as="section" className="hs-cp-details" aria-label="About the campaign">
      <div className="hs-cp-pad">
        {campaign.description && <p className="hs-cp-desc">{campaign.description}</p>}
        {(facts.started || facts.ended) && (
          <dl className="hs-cp-facts">
            {facts.started && <div><dt>Started</dt><dd>{facts.started}</dd></div>}
            {facts.ended && <div><dt>Ended</dt><dd>{facts.ended}</dd></div>}
          </dl>
        )}
        <dl className="hs-cp-facts">
          {facts.created && <div><dt>Created</dt><dd>{facts.created}</dd></div>}
          <div>
            <dt>{title}</dt>
            <dd>
              {members ? (gms.map(memberName).join(', ') || 'None yet') : '—'}
              <CampaignTorch campaign={campaign} view={view} viewerId={viewerId} onChanged={onTorchChanged} />
            </dd>
          </div>
          <div><dt>Owner</dt><dd>{owner}</dd></div>
          <div><dt>Quorum</dt><dd>{facts.quorum}</dd></div>
          <div>
            <dt>Table</dt>
            <dd>{facts.table ? <a href={campaign.tableLink!} target="_blank" rel="noopener noreferrer">{facts.table}</a> : 'Not set'}</dd>
          </div>
          <div><dt>Discord server</dt><dd>{facts.discord}</dd></div>
        </dl>
      </div>
    </GildedPanel>
  );
}
