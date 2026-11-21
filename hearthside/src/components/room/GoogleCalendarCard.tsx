"use client";

import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import { api, errorOf } from '@/lib/api';
import { gcalState, type GcalStatus } from '@/lib/room';

/**
 * Google Calendar under Integrations (layout A), as the portfolio's card:
 * the name and status on the left, one Connect or Disconnect button on the
 * right, the result line under it, and the reconnect line when an older
 * connection can't read free/busy (`needsReconsent`).
 *
 * Connect asks `GET /api/google-calendar/auth-url` and leaves for Google; the
 * callback brings the person back to `/room?gcal=…` on Hearthside (#215),
 * and the page passes that outcome in as `notice`.
 */
export default function GoogleCalendarCard({ status, notice, onChanged }: {
  /** Null while it loads, or if it couldn't. */
  status: GcalStatus | null;
  /** The result line: from `?gcal=` on the way back from Google. */
  notice: string | null;
  /** After Disconnect: read the status again. */
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const line = said ?? notice;
  const state = gcalState(status);

  const connect = async () => {
    setBusy('connect');
    setSaid(null);
    try {
      const { url } = await api.get<{ url: string }>('/api/google-calendar/auth-url');
      window.location.assign(url);
    } catch (err) {
      setSaid(errorOf(err, 'Google Calendar isn’t set up on the server.'));
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    setSaid(null);
    try {
      await api.delete('/api/google-calendar');
      await onChanged();
      setSaid('Disconnected. Sessions already on your calendar stay there.');
    } catch (err) {
      setSaid(errorOf(err, 'It couldn’t be disconnected. Try again in a moment.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="hs-room-ig" aria-labelledby="hs-room-gcal">
      <span className="hs-room-ig-mark" aria-hidden="true"><CalendarDays strokeWidth={1.5} /></span>
      <div className="hs-room-ig-text">
        <div className="hs-room-ig-name">
          <h3 id="hs-room-gcal">Google Calendar</h3>
          <span className={`hs-room-pill is-${state.tone}`}>{status ? state.pill : '…'}</span>
        </div>
        <p className="hs-room-ig-sub">{state.line}</p>
        {status?.connected && status.needsReconsent && (
          <p className="hs-room-ig-warn">
            To let your busy time count when your party plans a night, reconnect once.{' '}
            <button type="button" className="hs-cp-link" disabled={!!busy} onClick={connect}>Reconnect</button>
          </p>
        )}
      </div>
      {status?.connected ? (
        <button type="button" className="hs-ghost is-warn hs-room-ig-btn" disabled={!!busy} onClick={disconnect}>
          {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
        </button>
      ) : (
        <button type="button" className="hs-btn-amber hs-room-ig-btn" disabled={!!busy} onClick={connect}>
          {busy === 'connect' ? 'Opening Google…' : 'Connect'}
        </button>
      )}
      {line && <p className="hs-room-ig-note" role="status">{line}</p>}
    </section>
  );
}
