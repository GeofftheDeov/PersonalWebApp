"use client";

import { useCallback, useEffect, useState } from 'react';
import { getOrNull } from './api';
import type { CampaignSummary } from './campaigns';
import { comingUp, played, type AttendedSession, type GcalStatus, type ListedSession, type RoomSession } from './room';

export interface RoomData {
  /** Null until it loads; an empty list if it couldn't. */
  comingUp: RoomSession[] | null;
  played: RoomSession[] | null;
  campaigns: CampaignSummary[] | null;
  /** Null until it loads, or when it couldn't. */
  gcal: GcalStatus | null;
  reloadGcal: () => Promise<void>;
}

/**
 * What Your Room shows beyond the record (which is the session's person):
 * Played from `GET /api/users/profile/sessions`, Coming up from
 * `GET /api/tabletop/sessions`, the campaigns, and Google Calendar's status.
 * Each list shows what it could load, as the portfolio's profile does.
 * Pass `enabled: false` until the person is signed in.
 */
export function useRoom(enabled: boolean): RoomData {
  const [data, setData] = useState<Omit<RoomData, 'reloadGcal'>>({ comingUp: null, played: null, campaigns: null, gcal: null });

  const reloadGcal = useCallback(async () => {
    const gcal = await getOrNull<GcalStatus>('/api/google-calendar/status');
    setData((d) => ({ ...d, gcal }));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const now = new Date();
    getOrNull<AttendedSession[]>('/api/users/profile/sessions')
      .then((rows) => live && setData((d) => ({ ...d, played: played(rows ?? []) })));
    getOrNull<ListedSession[]>('/api/tabletop/sessions')
      .then((rows) => live && setData((d) => ({ ...d, comingUp: comingUp(rows ?? [], now) })));
    getOrNull<CampaignSummary[]>('/api/campaigns')
      .then((rows) => live && setData((d) => ({ ...d, campaigns: rows ?? [] })));
    reloadGcal();
    return () => { live = false; };
  }, [enabled, reloadGcal]);

  return { ...data, reloadGcal };
}
