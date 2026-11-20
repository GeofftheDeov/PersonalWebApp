"use client";

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@gtd/shared/api';
import { api, errorOf, getOrNull } from './api';
import type { CampaignDetail, Member } from './campaignPage';
import { pendingInviteFor, type PendingInvite } from './invite';
import { useSession } from './session';

export type InviteState =
  | { status: 'loading' }
  /** Signed out: the page offers signing in or up, coming back here. */
  | { status: 'signedOut' }
  | { status: 'missing' }
  | { status: 'error'; error: string }
  /**
   * `invite` is the viewer's pending invite to it, if any; `members` is null
   * when the viewer may not see the party (they aren't in it).
   */
  | { status: 'ready'; campaign: CampaignDetail; invite: PendingInvite | null; members: Member[] | null };

/**
 * The invite page's data (#232): the campaign (`GET /api/campaigns/:id`, open
 * to anyone signed in), the viewer's pending invites
 * (`GET /api/campaign-invites/mine`) and, for someone already in it, the party
 * (`GET /api/campaigns/:id/members`). Nothing is asked while signed out: a 401
 * would send the visitor straight to sign in, and the page offers signing up
 * too.
 *
 *   const { state, viewerId, accept, decline } = useInvite(campaignId);
 */
export function useInvite(id: string) {
  const { status, user } = useSession();
  const [state, setState] = useState<InviteState>({ status: 'loading' });
  const path = encodeURIComponent(id);

  const load = useCallback(async () => {
    try {
      const [campaign, invites, members] = await Promise.all([
        api.get<CampaignDetail>(`/api/campaigns/${path}`),
        getOrNull<PendingInvite[]>('/api/campaign-invites/mine'),
        getOrNull<Member[]>(`/api/campaigns/${path}/members`),
      ]);
      setState({ status: 'ready', campaign, invite: pendingInviteFor(invites, id), members });
    } catch (err) {
      // A 401 has already sent the person to sign in and back.
      if (err instanceof ApiError && err.status === 401) return;
      if (err instanceof ApiError && [400, 403, 404].includes(err.status)) setState({ status: 'missing' });
      else setState({ status: 'error', error: errorOf(err, 'The summons couldn’t be read. Try again in a moment.') });
    }
  }, [path, id]);

  useEffect(() => {
    if (status === 'signedOut') setState({ status: 'signedOut' });
    else if (status === 'signedIn') {
      setState({ status: 'loading' });
      load();
    }
  }, [status, user?.id, load]);

  const invite = state.status === 'ready' ? state.invite : null;

  /**
   * Take the seat. A pending invite is answered, so the bell clears and the
   * inviter hears; with only the link (or an invite answered elsewhere
   * meanwhile: 404 or 409), it joins by the link. A join that finds them
   * already a member (409) has still seated them. Throws anything else.
   */
  const accept = useCallback(async () => {
    if (invite) {
      try {
        await api.put(`/api/campaign-invites/${encodeURIComponent(invite._id)}/respond`, { action: 'accept' });
        return;
      } catch (err) {
        if (!(err instanceof ApiError && (err.status === 404 || err.status === 409))) throw err;
      }
    }
    try {
      await api.post(`/api/campaigns/${path}/join`);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
  }, [invite, path]);

  /**
   * Turn it down. A pending invite is declined (the bell clears, the inviter
   * hears); one already answered elsewhere is fine. With only the link there's
   * nothing to record.
   */
  const decline = useCallback(async () => {
    if (!invite) return;
    try {
      await api.put(`/api/campaign-invites/${encodeURIComponent(invite._id)}/respond`, { action: 'decline' });
    } catch (err) {
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 409))) throw err;
    }
  }, [invite]);

  return { state, viewerId: user?.id ?? null, reload: load, accept, decline };
}
