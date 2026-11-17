"use client";

import Link from 'next/link';
import { useId, useState } from 'react';
import { CirclePause, LogOut, UserCheck, UserMinus } from 'lucide-react';
import ConfirmDialog from '@/components/ConfirmDialog';
import GildedPanel from '@/components/design-system/GildedPanel';
import { api, errorOf } from '@/lib/api';
import {
  gmTitleOf, inactiveQuestion, leaveQuestion, memberName, removeQuestion, roleLine,
  type CampaignDetail, type Member, type PartyView,
} from '@/lib/campaignPage';
import InviteDialog from './InviteDialog';

type Asking =
  | { kind: 'remove'; member: Member }
  | { kind: 'inactive'; member: Member }
  | { kind: 'leave' }
  | { kind: 'invite' }
  | null;

/** The party's icons: Lucide at a hairline stroke. */
const ICON = { size: 15, strokeWidth: 1.5, 'aria-hidden': true } as const;

/**
 * The party on gilded leather (#224), as compact rows: an avatar, the name
 * (linking to the player's page) and their role, with the GM's icon-only
 * buttons under the name so long names keep their width: Make inactive
 * (CirclePause), Remove (UserMinus), and, in the inactive list only GMs see,
 * Reactivate (UserCheck). The note about inactive players is a tooltip on the
 * list's header. The foot has Leave the campaign (LogOut), or why the only GM
 * can't. Invite opens a gilded dialog; every other change is confirmed in one.
 */
export default function CampaignParty({ campaign, view, onChanged, onLeft }: {
  campaign: CampaignDetail;
  view: PartyView;
  /** After a change to the party: re-read it. */
  onChanged: () => Promise<void>;
  /** After the viewer leaves. */
  onLeft: () => void;
}) {
  const tipId = useId();
  const [asking, setAsking] = useState<Asking>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const title = gmTitleOf(campaign);
  const playing = view.active.filter((m) => m.playerId).length;

  const remove = async (m: Member, self: boolean) => {
    await api.delete(`/api/campaign-members/${encodeURIComponent(m._id)}`);
    setAsking(null);
    if (self) { onLeft(); return; }
    await onChanged();
  };

  const setActive = async (m: Member, active: boolean) => {
    await api.patch(`/api/campaign-members/${encodeURIComponent(m._id)}/active`, { active });
    setAsking(null);
    await onChanged();
  };

  // Reactivating needs no confirming (it takes nothing away): it goes straight through.
  const reactivate = async (m: Member) => {
    setBusy(m._id);
    setError(null);
    try {
      await setActive(m, true);
    } catch (err) {
      setError(errorOf(err, 'They couldn’t be brought back. Try again in a moment.'));
    } finally {
      setBusy(null);
    }
  };

  const avatar = (m: Member, off = false) => (
    <span className={`hs-avatar${m.status === 'Game Master' ? ' is-gm' : ''}${off || !m.playerId ? ' is-off' : ''}`} aria-hidden="true">
      {(memberName(m)[0] ?? '?').toUpperCase()}
    </span>
  );

  const removeButton = (m: Member) => view.canRemove(m) && (
    <button type="button" className="hs-cp-mini is-warn" title={`Remove ${memberName(m)} from the campaign`}
      aria-label={`Remove ${memberName(m)}`} onClick={() => { setError(null); setAsking({ kind: 'remove', member: m }); }}>
      <UserMinus {...ICON} />
    </button>
  );

  const row = (m: Member) => {
    const name = memberName(m);
    const roles = roleLine(m, campaign);
    const isMe = !!view.mine && m._id === view.mine._id;
    const who = (
      <>
        <span className="hs-cp-name" title={name}>{name}{isMe && <span className="hs-cp-you"> (you)</span>}</span>
        {roles && <span className={m.status === 'Game Master' ? 'hs-cp-role' : 'hs-cp-role is-plain'}>{roles}</span>}
      </>
    );
    return (
      <li key={m._id}>
        <div className="hs-cp-member">
          {avatar(m)}
          <div className="hs-cp-who">
            {m.playerId ? <Link href={`/players/${m.playerId}`} className="hs-cp-whois">{who}</Link> : <div className="hs-cp-whois">{who}</div>}
            {(view.canDeactivate(m) || view.canRemove(m)) && (
              <div className="hs-cp-tools">
                {view.canDeactivate(m) && (
                  <button type="button" className="hs-cp-mini" title={`Make ${name} inactive`} aria-label={`Make ${name} inactive`}
                    onClick={() => { setError(null); setAsking({ kind: 'inactive', member: m }); }}>
                    <CirclePause {...ICON} />
                  </button>
                )}
                {removeButton(m)}
              </div>
            )}
          </div>
        </div>
      </li>
    );
  };

  return (
    <section className="hs-cp-party" aria-labelledby="hs-cp-party-h">
      <div className="hs-cp-sec-row">
        <h2 className="hs-sec" id="hs-cp-party-h"><span>The Party</span><span className="hs-aside">{playing} playing</span></h2>
        <button type="button" className="hs-btn-amber" onClick={() => setAsking({ kind: 'invite' })}>Invite</button>
      </div>
      {error && <p className="hs-alert hs-cp-note" role="alert">{error}</p>}
      <GildedPanel>
        <ul className="hs-cp-roster" aria-label="The party">
          {view.active.length === 0 && <li className="hs-cp-empty">No players yet.</li>}
          {view.active.map(row)}
          {view.inactive.length > 0 && (
            <li className="hs-cp-inactive-head">
              <span>Inactive ({view.inactive.length})</span>
              <button type="button" className="hs-cp-tip" aria-label="About inactive players" aria-describedby={tipId}>?</button>
              <span role="tooltip" id={tipId} className="hs-cp-tip-text">
                Inactive players can&rsquo;t read or post in Table Talk. Their characters and history stay. Only the {title} sees this list.
              </span>
            </li>
          )}
          {view.inactive.map((m) => {
            const name = memberName(m);
            return (
              <li key={m._id} className="is-inactive">
                <div className="hs-cp-member">
                  {avatar(m, true)}
                  <div className="hs-cp-who">
                    <div className="hs-cp-whois"><span className="hs-cp-name" title={name}>{name}</span></div>
                    <div className="hs-cp-tools">
                      {view.isGM && (
                        <button type="button" className="hs-cp-mini" title={`Reactivate ${name}`} aria-label={`Reactivate ${name}`}
                          disabled={busy === m._id} onClick={() => reactivate(m)}>
                          <UserCheck {...ICON} />
                        </button>
                      )}
                      {removeButton(m)}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
          {view.mine && (
            <li className="hs-cp-roster-foot">
              {view.isLastGm ? (
                <p className="hs-fine">You&rsquo;re the only {title}: pass the torch before you leave.</p>
              ) : (
                <button type="button" className="hs-ghost is-warn" onClick={() => { setError(null); setAsking({ kind: 'leave' }); }}>
                  <LogOut {...ICON} /> Leave the campaign
                </button>
              )}
            </li>
          )}
        </ul>
      </GildedPanel>

      {asking?.kind === 'invite' && <InviteDialog campaignId={campaign._id} onClose={() => setAsking(null)} />}
      {asking?.kind === 'remove' && (
        <ConfirmDialog title={`Remove ${memberName(asking.member)}?`} yes="Remove them" busy="Removing…"
          onYes={() => remove(asking.member, false)} onClose={() => setAsking(null)} fallbackError="They couldn’t be removed.">
          {removeQuestion(campaign, asking.member)}
        </ConfirmDialog>
      )}
      {asking?.kind === 'inactive' && (
        <ConfirmDialog title={`Make ${memberName(asking.member)} inactive?`} yes="Make inactive" busy="Working…"
          onYes={() => setActive(asking.member, false)} onClose={() => setAsking(null)} fallbackError="That couldn’t be changed.">
          {inactiveQuestion(asking.member)}
        </ConfirmDialog>
      )}
      {asking?.kind === 'leave' && view.mine && (
        <ConfirmDialog title="Leave the campaign?" yes="Leave" busy="Leaving…"
          onYes={() => remove(view.mine!, true)} onClose={() => setAsking(null)} fallbackError="You couldn’t leave the campaign.">
          {leaveQuestion(campaign)}
        </ConfirmDialog>
      )}
    </section>
  );
}
