"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@gtd/shared/api';
import { api, errorOf } from '@/lib/api';
import { PORTFOLIO_URL } from '@/lib/config';
import {
  ROOM_TAB_LABEL, gcalResult, headLine, photoProblem, roomTab, withGame, withoutGame,
  type LedgerPerson, type RoomTab,
} from '@/lib/room';
import { session, useRequiredSession } from '@/lib/session';
import { useRoom } from '@/lib/useRoom';
import EditRecordDialog from './EditRecordDialog';
import GoogleCalendarCard from './GoogleCalendarCard';
import LedgerHead from './LedgerHead';
import LedgerTabs, { type LedgerTab } from './LedgerTabs';
import RecordPanel from './RecordPanel';
import RoomCampaigns from './RoomCampaigns';
import RoomSessions from './RoomSessions';

/**
 * Your Room (#230, spec #69): layout A, "The ledger", from
 * prototype/hearthside-player-profile. The head on the floor (photo, name,
 * handle and unique ID, counts, Edit), then a gilded tab strip with one
 * leather panel at a time: Record, Sessions, Campaigns and Integrations.
 * `/room` draws it, and so does `/players/<your own id>`.
 *
 * `?tab=` opens a tab; `?gcal=` (the way back from Google, #215) shows its
 * result on the Google Calendar card and opens Integrations. Both are taken
 * off the address once read.
 */
export default function YourRoom() {
  const { status, user } = useRequiredSession();
  const me = user as unknown as LedgerPerson | null;
  const room = useRoom(status === 'signedIn');
  const now = useMemo(() => new Date(), []);
  const [tab, setTab] = useState<RoomTab>('record');
  const [gcalNotice, setGcalNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Read once: React's development double mount runs this twice, and the first run has already cleared the address.
  const readQuery = useRef(false);
  useEffect(() => {
    if (readQuery.current) return;
    readQuery.current = true;
    const q = new URLSearchParams(window.location.search);
    const gcal = q.get('gcal');
    setTab(roomTab(q.get('tab'), gcal));
    setGcalNotice(gcalResult(gcal));
    if (q.has('gcal') || q.has('tab')) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.hash);
  }, []);

  if (!me) return <p className="hs-note hs-room-wait" role="status">Opening your room…</p>;

  const refresh = () => session.refresh().then(() => undefined);

  const pickPhoto = async (file: File) => {
    const problem = photoProblem(file);
    setPhotoError(problem);
    if (problem) return;
    setPhotoBusy(true);
    const form = new FormData();
    form.append('profilePicture', file);
    try {
      await api.post('/api/users/profile/picture', form);
      await refresh();
    } catch (err) {
      setPhotoError(err instanceof ApiError ? errorOf(err, 'The photo couldn’t be uploaded.') : 'The photo couldn’t be uploaded. Try again in a moment.');
    } finally {
      setPhotoBusy(false);
    }
  };

  const saveGames = async (favoriteGames: string[]) => {
    await api.put('/api/users/profile', { favoriteGames });
    await refresh();
  };

  const tabs: LedgerTab<RoomTab>[] = [
    { id: 'record', label: ROOM_TAB_LABEL.record },
    { id: 'sessions', label: ROOM_TAB_LABEL.sessions, count: room.played?.length },
    { id: 'campaigns', label: ROOM_TAB_LABEL.campaigns, count: room.campaigns?.length },
    { id: 'integrations', label: ROOM_TAB_LABEL.integrations },
  ];
  const line = room.played && room.campaigns
    ? headLine({ sessions: room.played.length, campaigns: room.campaigns.length, since: me.createdAt })
    : null;

  return (
    <>
      <LedgerHead
        person={me}
        line={line}
        photo={{ onPick: pickPhoto, busy: photoBusy }}
        photoError={photoError}
        actions={<button type="button" className="hs-btn-amber hs-room-edit" onClick={() => setEditing(true)}>Edit</button>}
      />
      <LedgerTabs tabs={tabs} tab={tab} onTab={setTab} label="Your Room">
        {tab === 'record' && (
          <RecordPanel person={me} own games={{ onSave: saveGames, add: withGame, remove: withoutGame }}>
            <div className="hs-room-sec">
              <p className="hs-fine">
                Your API keys stay on the portfolio’s profile.{' '}
                <a className="hs-room-link" href={`${PORTFOLIO_URL}/profile`}>Open your profile there</a>
              </p>
            </div>
          </RecordPanel>
        )}
        {tab === 'sessions' && <RoomSessions comingUp={room.comingUp} played={room.played} now={now} />}
        {tab === 'campaigns' && <RoomCampaigns campaigns={room.campaigns} />}
        {tab === 'integrations' && <GoogleCalendarCard status={room.gcal} notice={gcalNotice} onChanged={room.reloadGcal} />}
      </LedgerTabs>
      {editing && <EditRecordDialog person={me} onClose={() => setEditing(false)} onSaved={refresh} />}
    </>
  );
}
