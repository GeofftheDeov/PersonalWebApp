"use client";

import { useRef, type KeyboardEvent } from 'react';

export interface AlmanacTab<T extends string> {
  id: T;
  label: string;
  count?: number | string;
}

/**
 * A strip of tabs (the design system's `hs-tabs`) for the Almanac: Coming up
 * and Played, Month and Week. The arrow keys, Home and End move between them,
 * as tabs do. Each tab's id is `${idPrefix}-${id}`, for its panel's
 * `aria-labelledby`.
 */
export default function AlmanacTabs<T extends string>({ label, tabs, value, onChange, panelId, idPrefix }: {
  label: string;
  tabs: readonly AlmanacTab<T>[];
  value: T;
  onChange: (t: T) => void;
  panelId: string;
  idPrefix: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKey = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    onChange(tabs[to].id);
    refs.current[to]?.focus();
  };

  return (
    <div className="hs-tabs hs-alm-tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[i] = el; }}
          type="button"
          role="tab"
          id={`${idPrefix}-${t.id}`}
          aria-selected={t.id === value}
          aria-controls={panelId}
          tabIndex={t.id === value ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => onKey(e, i)}
        >
          {t.label}
          {t.count != null && <>{' '}<span className="hs-alm-n">{t.count}</span></>}
        </button>
      ))}
    </div>
  );
}
