"use client";

import { useRef, type KeyboardEvent } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';
import { STATUS_FILTERS, statusLabel, type StatusFilter } from '@/lib/campaigns';

/** The id of a filter's tab, for its panel's `aria-labelledby`. */
export const statusTabId = (f: StatusFilter) => `hs-status-tab-${f.toLowerCase().replace(/\s+/g, '-')}`;

/**
 * The gilded strip of status tabs, each with its count: All, In progress, Not
 * started, Completed. The arrow keys, Home and End move between them, as tabs do.
 * The panel they control has the id `panelId`.
 */
export default function StatusTabs({ value, counts, onChange, panelId }: {
  value: StatusFilter;
  counts: Record<StatusFilter, number>;
  onChange: (f: StatusFilter) => void;
  panelId: string;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const n = STATUS_FILTERS.length;
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    onChange(STATUS_FILTERS[to]);
    tabs.current[to]?.focus();
  };

  return (
    <GildedPanel className="hs-status-strip">
      <div className="hs-tabs" role="tablist" aria-label="Filter by status">
        {STATUS_FILTERS.map((f, i) => (
          <button
            key={f}
            ref={(el) => { tabs.current[i] = el; }}
            type="button"
            role="tab"
            id={statusTabId(f)}
            aria-selected={f === value}
            aria-controls={panelId}
            tabIndex={f === value ? 0 : -1}
            onClick={() => onChange(f)}
            onKeyDown={(e) => onKey(e, i)}
          >
            {statusLabel(f)} <span className="hs-count">{counts[f]}</span>
          </button>
        ))}
      </div>
    </GildedPanel>
  );
}
