"use client";

import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import CampaignDetails from '@/components/campaign/CampaignDetails';
import CampaignHead from '@/components/campaign/CampaignHead';
import CampaignNoticeBoard from '@/components/campaign/CampaignNoticeBoard';
import CampaignParty from '@/components/campaign/CampaignParty';
import CampaignRecords from '@/components/campaign/CampaignRecords';
import EditCampaignForm from '@/components/campaign/EditCampaignForm';
import BannerEditor from '@/components/campaigns/BannerEditor';
import RemoveBannerDialog from '@/components/campaigns/RemoveBannerDialog';
import TableTalk from '@/components/letters/TableTalk';
import BackLink from '@/components/shell/BackLink';
import { canManageBanner } from '@/lib/campaigns';
import { memberName, partyLine, partyView } from '@/lib/campaignPage';
import { useRequiredSession } from '@/lib/session';
import { useCampaignPage } from '@/lib/useCampaignPage';
import { useNoticeBoard } from '@/lib/useNoticeBoards';

/**
 * A campaign's page (spec #69): the portfolio's layout and every control, in
 * Hearthside's materials, as prototype/hearthside-campaign-details decided.
 * Part 1 (#224) is the top half: the head on the floor (back link, banner in
 * a gilded frame, title and status), the details (and their edit form) and the
 * party on gilded leather, the torch, and gilded dialogs for every
 * confirmation and invite. Part 2 (#225) fills the slots below, for the
 * party: the Notice Board (`#notice-board`), each notice on parchment; Table
 * Talk beside the party, the same thread Letters lists; and Sessions |
 * Characters on leather. Someone outside the party sees the details only.
 */
export default function CampaignPage() {
  const params = useParams();
  const id = String(params?.id ?? '');
  // A fresh page per campaign, so nothing (an open form, a dialog) carries over to the next.
  return <CampaignView key={id} id={id} />;
}

function CampaignView({ id }: { id: string }) {
  const router = useRouter();
  const { user, capabilities } = useRequiredSession();
  const { state, reloadMembers, setCampaign } = useCampaignPage(id);
  const [editing, setEditing] = useState(false);
  const [banner, setBanner] = useState<'change' | 'remove' | null>(null);
  // The Notice Board is the party's (the server refuses anyone else); Coming up shares its data.
  const inParty = state.status === 'ready' && state.members !== null;
  const board = useNoticeBoard(inParty ? id : null);

  if (state.status === 'loading') return <p className="hs-note hs-cp-wait" role="status">Fetching the campaign…</p>;
  if (state.status !== 'ready') {
    return (
      <header className="hs-page-head">
        <BackLink href="/campaigns" full="Back to Campaigns">Campaigns</BackLink>
        <h1>{state.status === 'missing' ? 'No such campaign' : 'The campaign didn’t come'}</h1>
        <p>{state.status === 'missing' ? 'It isn’t here, or it’s been taken down.' : state.error}</p>
      </header>
    );
  }

  const { campaign, members } = state;
  const view = partyView(campaign, members ?? [], user, capabilities);
  const playing = view.active.filter((m) => m.playerId).length;
  // A member can read the party's Table Talk; so can an admin.
  const talks = inParty && (!!view.mine || view.isAdmin);

  // Who plans (the GM, the title) and who's in the party show on the board too: read it again after a change.
  const partyChanged = async () => {
    await reloadMembers();
    void board.reload();
  };
  const torchChanged = async (owner: string | null) => {
    setCampaign({ owner });
    await partyChanged();
  };
  const nameOf = (personId: string) => {
    const m = members?.find((x) => x.playerId === personId);
    return m ? memberName(m) : 'someone';
  };

  return (
    <>
      <CampaignHead
        campaign={campaign}
        partyLine={inParty ? partyLine(campaign, view) : null}
        canManageBanner={canManageBanner(campaign, user, capabilities)}
        canEdit={inParty && !editing}
        onEdit={() => setEditing(true)}
        onChangeBanner={() => setBanner('change')}
        onRemoveBanner={() => setBanner('remove')}
      />

      {editing ? (
        <EditCampaignForm
          campaign={campaign}
          isOwner={view.isOwner}
          partySize={view.active.filter((m) => m.playerId).length}
          onSaved={(saved, done) => { setCampaign(saved); if (done) setEditing(false); void board.reload(); }}
          onClose={() => setEditing(false)}
        />
      ) : (
        <CampaignDetails campaign={campaign} members={members} view={view} viewerId={user?.id ?? null} onTorchChanged={torchChanged} />
      )}

      {/* The Notice Board (#225): one parchment sheet per session being planned, and the GM's "Plan a session".
          Bells link here (`/campaigns/:id#notice-board`). Outside the party, an empty slot that hides itself. */}
      {inParty ? (
        <CampaignNoticeBoard campaignId={campaign._id} campaignTitle={campaign.title}
          board={board.board} error={board.error} reload={board.reload} />
      ) : (
        <section id="notice-board" className="hs-cp-slot" data-slot="notice-board" />
      )}

      {/* The party beside Table Talk when there's room (#225 fills Table Talk's slot); stacked otherwise. */}
      <div className="hs-cp-split">
        <div className="hs-cp-split-in">
          {inParty ? (
            <CampaignParty campaign={campaign} view={view} onChanged={partyChanged} onLeft={() => router.push('/campaigns')} />
          ) : (
            <p className="hs-note">Only the party sees who&rsquo;s in it. Ask one of them for an invite.</p>
          )}
          <div className="hs-cp-slot" data-slot="table-talk">
            {talks && <TableTalk campaignId={campaign._id} title={campaign.title} partySize={playing} />}
          </div>
        </div>
      </div>

      {/* Sessions | Characters (#225): Coming up beside Previous sessions from 1100px, and the party's adventurers. */}
      <div className="hs-cp-slot" data-slot="records">
        {inParty && (
          <CampaignRecords campaign={campaign} isGM={view.isGM} board={board.board} boardError={board.error}
            reloadBoard={board.reload} nameOf={nameOf} />
        )}
      </div>

      {banner === 'change' && (
        <BannerEditor campaignId={campaign._id} onClose={() => setBanner(null)} onSaved={(b) => { setCampaign(b); setBanner(null); }} />
      )}
      {banner === 'remove' && (
        <RemoveBannerDialog campaign={campaign} onClose={() => setBanner(null)} onRemoved={(b) => { setCampaign(b); setBanner(null); }} />
      )}
    </>
  );
}
