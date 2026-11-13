"use client";

import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '@gtd/shared/api';
import { api, errorOf, getOrNull } from './api';
import { useRequiredSession } from './session';
import type { SessionListItem } from './sessionPage';

/**
 * A session as `GET /api/tabletop/sessions/:id` sends it (the fields the page
 * reads). `agenda` is there only for those who may read and write Prep notes
 * (#213): test it with `canWritePrepNotes`, never by its value.
 */
export interface SessionDetail {
  _id: string;
  title?: string | null;
  date?: string | null;
  endDate?: string | null;
  location?: string | null;
  isOnline?: boolean | null;
  agenda?: string | null;
  /** The tale. */
  summary?: string | null;
  /** The recording's link. */
  vodUrl?: string | null;
  googleCalendarLink?: string | null;
  discordEventId?: string | null;
  googleEventId?: string | null;
  status?: 'planning' | 'scheduled' | 'cancelled' | 'completed' | null;
  /** The one-session stand-in GM's id (#89). */
  gmOverride?: string | null;
  createdAt?: string | null;
  campaign?: { _id: string; title: string; gmTitle?: string | null; tableLink?: string | null } | null;
}

export interface PartyMember {
  id: string;
  name: string;
}

/** What the page reads from `GET /api/planning/sessions/:id`: the party and the viewer's part in it. */
export interface PlanningRead {
  session: {
    gmOverride: PartyMember | null;
    venue: { id: string; name: string; address: string | null } | null;
  };
  campaign: { id: string; title: string; gmTitle: string | null; tableLink: string | null; gameMasterIds: string[] };
  party: PartyMember[];
  /** `isGameMaster`: the campaign's GM, the stand-in or an admin. `canPassTorch`: the campaign's own GM or an admin. */
  viewer: { id: string; isGameMaster: boolean; canPassTorch: boolean };
}

export type SessionPageState =
  | { status: 'loading' }
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ready'; session: SessionDetail; planning: PlanningRead | null; siblings: SessionListItem[] | null };

/** The fields the page edits; only those sent change (PUT /api/tabletop/sessions/:id). */
export type SessionPatch = Partial<Pick<SessionDetail, 'title' | 'date' | 'endDate' | 'location' | 'isOnline' | 'agenda' | 'summary' | 'vodUrl'>>;

/**
 * A session's page's data, for a signed-in viewer: the session, its
 * planning read (the party, the GM, the stand-in, the venue) and its
 * campaign's sessions (for previous and next). The two extras are left out
 * if they fail; the page shows what it has.
 */
export function useSessionPage(id: string) {
  const { status } = useRequiredSession();
  const [state, setState] = useState<SessionPageState>({ status: 'loading' });

  const load = useCallback(async () => {
    const path = encodeURIComponent(id);
    try {
      const [session, planning] = await Promise.all([
        api.get<SessionDetail>(`/api/tabletop/sessions/${path}`),
        getOrNull<PlanningRead>(`/api/planning/sessions/${path}`),
      ]);
      const campaignId = session.campaign?._id;
      const siblings = campaignId
        ? await getOrNull<SessionListItem[]>(`/api/campaigns/${encodeURIComponent(campaignId)}/sessions`)
        : null;
      setState({ status: 'ready', session, planning, siblings });
    } catch (err) {
      // A 401 has already sent the person to sign in and back.
      if (err instanceof ApiError && err.status === 401) return;
      if (err instanceof ApiError && [400, 403, 404].includes(err.status)) setState({ status: 'missing' });
      else setState({ status: 'error', error: errorOf(err, 'The session couldn’t be fetched. Try again in a moment.') });
    }
  }, [id]);

  useEffect(() => {
    if (status === 'signedIn') load();
  }, [status, load]);

  /** Saves the GM's changes and shows the session as the server returns it. Throws if it refuses. */
  const save = useCallback(async (patch: SessionPatch) => {
    const saved = await api.put<SessionDetail>(`/api/tabletop/sessions/${encodeURIComponent(id)}`, patch);
    setState((s) => (s.status === 'ready' && saved ? { ...s, session: { ...s.session, ...saved } } : s));
    return saved;
  }, [id]);

  return { state, reload: load, save };
}
