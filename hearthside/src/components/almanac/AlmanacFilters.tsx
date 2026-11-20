"use client";

import { useEffect, useId, useRef, useState } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import {
  NO_FILTER, WHERE_OPTIONS, isFiltered, toggleCampaign,
  type AlmanacFilter,
} from '@/lib/almanac';
import type { CampaignSummary } from '@/lib/campaigns';
import BannerArt from './BannerArt';

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

interface Choice {
  id: string;
  title: string;
}

/**
 * Campaigns as a dropdown of their banners (chosen over chips in the
 * prototype). Pick any number: a picked one keeps its colour, gains a gold
 * rim and a filled check seal, and the rest fade once anything is picked.
 * Closed, the button stacks the picked banners and says "All campaigns" or
 * "2 campaigns", and each pick sits beside it as a token with a × to remove
 * it. Show all clears the picks; Done, Escape or a click outside closes it.
 * The list hangs from the whole filter panel, so it can't run off a phone.
 */
function CampaignPicker({ choices, picked, counts, banners, onToggle, onClear }: {
  choices: readonly Choice[];
  picked: readonly string[];
  counts: Record<string, number>;
  banners: ReadonlyMap<string, CampaignSummary>;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector('button')?.focus();
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const chosen = choices.filter((c) => picked.includes(c.id));
  const summary = chosen.length ? plural(chosen.length, 'campaign') : 'All campaigns';
  const art = (c: Choice, className?: string) => (
    <BannerArt id={c.id} title={c.title} url={banners.get(c.id)?.bannerUrl} className={className} />
  );

  return (
    <div ref={root} className={chosen.length ? 'hs-alm-dd has-sel' : 'hs-alm-dd'}>
      <button
        ref={button}
        type="button"
        className="hs-alm-dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={chosen.length ? chosen.map((c) => c.title).join(', ') : undefined}
        disabled={!choices.length}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="hs-alm-dd-stack">{(chosen.length ? chosen : choices).slice(0, 4).map((c) => <span key={c.id}>{art(c, 'hs-alm-thumb')}</span>)}</span>
        <span className="hs-alm-dd-txt">{summary}</span>
        <span className="hs-alm-dd-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {chosen.map((c) => (
        <button key={c.id} type="button" className="hs-alm-tok" aria-label={`Stop filtering to ${c.title}`} onClick={() => onToggle(c.id)}>
          {art(c, 'hs-alm-thumb')}
          <span className="hs-alm-tok-n">{c.title}</span>
          <span className="hs-alm-tok-x" aria-hidden="true">×</span>
        </button>
      ))}
      {open && (
        <GildedPanel className="hs-alm-dd-pop">
          <div className="hs-alm-dd-h">
            <span>{chosen.length ? `${chosen.length} of ${choices.length} picked` : 'Pick any campaigns'}</span>
            {chosen.length > 0 && <button type="button" className="hs-alm-link" onClick={onClear}>Show all</button>}
          </div>
          <div ref={list} id={listId} className="hs-alm-dd-list" role="listbox" aria-multiselectable="true" aria-label="Campaigns">
            {choices.map((c) => {
              const on = picked.includes(c.id);
              const hasBanner = !!banners.get(c.id)?.bannerUrl;
              return (
                <button key={c.id} type="button" role="option" aria-selected={on} className={on ? 'hs-alm-opt is-on' : 'hs-alm-opt'} onClick={() => onToggle(c.id)}>
                  {art(c)}
                  <span className="hs-alm-opt-name">
                    <b>{c.title}</b>
                    <small>{plural(counts[c.id] ?? 0, 'session')} coming up{hasBanner ? '' : ' · no banner yet'}</small>
                  </span>
                  <span className="hs-alm-opt-check" aria-hidden="true" />
                </button>
              );
            })}
          </div>
          <div className="hs-alm-dd-f">
            <button type="button" className="hs-btn-amber" onClick={() => { setOpen(false); button.current?.focus(); }}>Done</button>
          </div>
        </GildedPanel>
      )}
    </div>
  );
}

/**
 * The Almanac's filters, under its heading, for both the list and the
 * calendar: any number of campaigns, and anywhere, in person or online. Each
 * choice shows how many sessions coming up it would leave; Clear filters
 * shows once one is set. Your Quests in the rail is the shell's, so it stays
 * unfiltered.
 */
export default function AlmanacFilters({ filter, onChange, choices, counts, banners }: {
  filter: AlmanacFilter;
  onChange: (f: AlmanacFilter) => void;
  choices: readonly Choice[];
  counts: { campaigns: Record<string, number>; where: Record<string, number> };
  banners: ReadonlyMap<string, CampaignSummary>;
}) {
  const campLabel = useId();
  const whereLabel = useId();
  return (
    <GildedPanel className="hs-alm-filters" role="group" aria-label="Filter sessions">
      <div className="hs-alm-frow" role="group" aria-labelledby={campLabel}>
        <span className="hs-alm-flab" id={campLabel}>Campaigns</span>
        <CampaignPicker
          choices={choices}
          picked={filter.campaigns}
          counts={counts.campaigns}
          banners={banners}
          onToggle={(id) => onChange(toggleCampaign(filter, id))}
          onClear={() => onChange({ ...filter, campaigns: [] })}
        />
      </div>
      <div className="hs-alm-frow" role="group" aria-labelledby={whereLabel}>
        <span className="hs-alm-flab" id={whereLabel}>Where</span>
        {WHERE_OPTIONS.map((w) => (
          <button key={w.id} type="button" className="hs-alm-chip" aria-pressed={filter.where === w.id} onClick={() => onChange({ ...filter, where: w.id })}>
            {w.label}{' '}<span className="hs-alm-n">{counts.where[w.id] ?? 0}</span>
          </button>
        ))}
        {isFiltered(filter) && (
          <button type="button" className="hs-alm-link hs-alm-clear" onClick={() => onChange(NO_FILTER)}>Clear filters</button>
        )}
      </div>
    </GildedPanel>
  );
}
