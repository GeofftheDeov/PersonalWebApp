"use client";

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import GildedPanel from '@/components/design-system/GildedPanel';

export interface LedgerTab<T extends string> {
  id: T;
  label: string;
  /** Shown small after the label: "Sessions 12". */
  count?: number | null;
}

const tabId = (id: string) => `hs-room-tab-${id}`;
const PANEL_ID = 'hs-room-panel';

/**
 * The ledger's gilded tab strip and its one leather panel (layout A). The
 * arrow keys, Home and End move between tabs. With fewer than two tabs
 * there's no strip, only the panel (another player's page until #200 gives it
 * tabs).
 */
export default function LedgerTabs<T extends string>({ tabs, tab, onTab, label, children }: {
  tabs: readonly LedgerTab<T>[];
  tab: T;
  onTab: (t: T) => void;
  /** The tablist's name: "Your Room". */
  label: string;
  children: ReactNode;
}) {
  const refs = useRef<Partial<Record<string, HTMLButtonElement | null>>>({});
  const strip = tabs.length > 1;

  const onKey = (e: KeyboardEvent, i: number) => {
    const n = tabs.length;
    const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    onTab(tabs[to].id);
    refs.current[tabs[to].id]?.focus();
  };

  return (
    <>
      {strip && (
        <GildedPanel className="hs-room-tabs">
          <div className="hs-tabs" role="tablist" aria-label={label}>
            {tabs.map((t, i) => (
              <button
                key={t.id}
                ref={(el) => { refs.current[t.id] = el; }}
                type="button"
                role="tab"
                id={tabId(t.id)}
                aria-selected={t.id === tab}
                aria-controls={PANEL_ID}
                tabIndex={t.id === tab ? 0 : -1}
                onClick={() => onTab(t.id)}
                onKeyDown={(e) => onKey(e, i)}
              >
                {t.label}
                {t.count != null && <small> {t.count}</small>}
              </button>
            ))}
          </div>
        </GildedPanel>
      )}
      <GildedPanel
        as="section"
        className="hs-room-panel"
        {...(strip ? { role: 'tabpanel', id: PANEL_ID, 'aria-labelledby': tabId(tab) } : { 'aria-label': label })}
      >
        {children}
      </GildedPanel>
    </>
  );
}
