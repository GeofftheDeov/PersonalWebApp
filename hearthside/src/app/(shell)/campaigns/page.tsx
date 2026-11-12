"use client";

import { useCallback, useEffect, useState } from 'react';
import { api, errorOf, getOrNull } from '@/lib/api';
import { useRequiredSession } from '@/lib/session';
import type { Banner } from '@/lib/banner';
import {
  canManageBanner, countByStatus, filterByStatus, statusLabel,
  type CampaignSummary, type StatusFilter,
} from '@/lib/campaigns';
import BannerEditor from '@/components/campaigns/BannerEditor';
import CampaignCard from '@/components/campaigns/CampaignCard';
import NewCampaignDialog from '@/components/campaigns/NewCampaignDialog';
import RemoveBannerDialog from '@/components/campaigns/RemoveBannerDialog';
import StatusTabs, { statusTabId } from '@/components/campaigns/StatusTabs';

const PANEL_ID = 'hs-roster-panel';

type Open =
  | { kind: 'new' }
  | { kind: 'banner'; campaign: CampaignSummary }
  | { kind: 'remove'; campaign: CampaignSummary }
  | null;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * Campaigns (spec #69, #223): layout B, "Roster", from
 * prototype/hearthside-campaigns. The player's campaigns as cards behind
 * gilded status tabs with counts; New campaign opens a gilded dialog; the
 * owner manages each banner from its card.
 */
export default function CampaignsPage() {
  const { status, user, capabilities } = useRequiredSession();
  const [campaigns, setCampaigns] = useState<CampaignSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tally, setTally] = useState<{ sessions: number; characters: number } | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('All');
  const [open, setOpen] = useState<Open>(null);

  const load = useCallback(async () => {
    try {
      setCampaigns(await api.get<CampaignSummary[]>('/api/campaigns'));
      setError(null);
    } catch (err) {
      setError(errorOf(err, 'The roster couldn’t be loaded. Try again in a moment.'));
    }
  }, []);

  useEffect(() => {
    if (status !== 'signedIn') return;
    load();
    // The header's other counts, as the portfolio's Campaigns tab shows them; left out if they don't load.
    Promise.all([
      getOrNull<unknown[]>('/api/tabletop/sessions'),
      getOrNull<unknown[]>('/api/tabletop/characters'),
    ]).then(([s, c]) => { if (s && c) setTally({ sessions: s.length, characters: c.length }); });
  }, [status, load]);

  const setBanner = (id: string, banner: Banner) =>
    setCampaigns((list) => list && list.map((c) => (c._id === id ? { ...c, ...banner } : c)));

  const all = campaigns ?? [];
  const counts = countByStatus(all);
  const shown = filterByStatus(all, filter);

  return (
    <>
      <header className="hs-page-head hs-campaigns-head">
        <div>
          <h1>Campaigns</h1>
          {campaigns && (
            <p>
              <b>{plural(all.length, 'campaign')}</b>
              {tally && <> · {plural(tally.sessions, 'session')} · {plural(tally.characters, 'character')}</>}
            </p>
          )}
        </div>
        <button type="button" className="hs-btn-amber hs-new" onClick={() => setOpen({ kind: 'new' })}>New campaign</button>
      </header>

      <section className="hs-roster-sec" aria-labelledby="hs-roster-heading">
        <h2 className="hs-sec" id="hs-roster-heading">
          <span>The Roster</span>
          {campaigns && <span className="hs-aside">{counts['In Progress']} at the table</span>}
        </h2>
        <StatusTabs value={filter} counts={counts} onChange={setFilter} panelId={PANEL_ID} />

        <div role="tabpanel" id={PANEL_ID} aria-labelledby={statusTabId(filter)} className="hs-roster-panel">
          {error ? (
            <p className="hs-roster-empty" role="alert">{error}</p>
          ) : !campaigns ? (
            <p className="hs-roster-empty">Gathering the roster…</p>
          ) : shown.length ? (
            <ul className="hs-roster" aria-label={`${statusLabel(filter)} campaigns`}>
              {shown.map((c) => (
                <CampaignCard
                  key={c._id}
                  campaign={c}
                  canManage={canManageBanner(c, user, capabilities)}
                  onChangeBanner={() => setOpen({ kind: 'banner', campaign: c })}
                  onRemoveBanner={() => setOpen({ kind: 'remove', campaign: c })}
                />
              ))}
            </ul>
          ) : (
            <p className="hs-roster-empty">
              {all.length ? `No campaigns ${statusLabel(filter).toLowerCase()}.` : 'No campaigns yet. Start one with New campaign.'}
            </p>
          )}
        </div>
      </section>

      {open?.kind === 'new' && (
        <NewCampaignDialog
          onClose={() => setOpen(null)}
          onCreated={() => { setOpen(null); setFilter('All'); load(); }}
        />
      )}
      {open?.kind === 'banner' && (
        <BannerEditor
          campaignId={open.campaign._id}
          onClose={() => setOpen(null)}
          onSaved={(b) => { setBanner(open.campaign._id, b); setOpen(null); }}
        />
      )}
      {open?.kind === 'remove' && (
        <RemoveBannerDialog
          campaign={open.campaign}
          onClose={() => setOpen(null)}
          onRemoved={(b) => { setBanner(open.campaign._id, b); setOpen(null); }}
        />
      )}
    </>
  );
}
