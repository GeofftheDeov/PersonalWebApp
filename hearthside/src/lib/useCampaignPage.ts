"use client";

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@gtd/shared/api';
import { api, errorOf, getOrNull } from './api';
import { useRequiredSession } from './session';
import type { CampaignDetail, Member } from './campaignPage';

export type CampaignPageState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; error: string }
  /** `members` is null when the viewer may not see the party (they aren't in it). */
  | { status: 'ready'; campaign: CampaignDetail; members: Member[] | null };

/**
 * A campaign's page's data, for a signed-in viewer (#224): the campaign
 * (`GET /api/campaigns/:id`) and its party (`GET /api/campaigns/:id/members`,
 * inactive members included for GMs and admins). Anyone signed in can read a
 * campaign; only its party and admins can read the members, so for anyone
 * else `members` is null.
 *
 *   const { state, reloadMembers, setCampaign } = useCampaignPage(id);
 */
export function useCampaignPage(id: string) {
  const { status } = useRequiredSession();
  const [state, setState] = useState<CampaignPageState>({ status: 'loading' });
  const path = encodeURIComponent(id);

  const load = useCallback(async () => {
    try {
      const [campaign, members] = await Promise.all([
        api.get<CampaignDetail>(`/api/campaigns/${path}`),
        getOrNull<Member[]>(`/api/campaigns/${path}/members`),
      ]);
      setState({ status: 'ready', campaign, members });
    } catch (err) {
      // A 401 has already sent the person to sign in and back.
      if (err instanceof ApiError && err.status === 401) return;
      if (err instanceof ApiError && [400, 403, 404].includes(err.status)) setState({ status: 'missing' });
      else setState({ status: 'error', error: errorOf(err, 'The campaign couldn’t be fetched. Try again in a moment.') });
    }
  }, [path]);

  useEffect(() => {
    if (status === 'signedIn') load();
  }, [status, load]);

  /** Re-reads the party after a change to it (the torch, someone made inactive, removed). */
  const reloadMembers = useCallback(async () => {
    const members = await getOrNull<Member[]>(`/api/campaigns/${path}/members`);
    if (members) setState((s) => (s.status === 'ready' ? { ...s, members } : s));
  }, [path]);

  /** Shows a change to the campaign the server has made (a save, a banner, a new owner). */
  const setCampaign = useCallback((patch: Partial<CampaignDetail>) => {
    setState((s) => (s.status === 'ready' ? { ...s, campaign: { ...s.campaign, ...patch } } : s));
  }, []);

  return { state, reload: load, reloadMembers, setCampaign };
}
