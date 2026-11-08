"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Menu } from 'lucide-react';
import GildedPanel from '@/components/design-system/GildedPanel';
import { NAV, currentNav } from '@/lib/nav';
import { ShellBackContext, type BackTarget } from './BackLink';

export interface AppShellProps {
  /** The page. */
  children: ReactNode;
  /** Under the nav in the rail: Your Quests (#221). */
  quests?: ReactNode;
  /** The right-hand column: Letters (#221). Left out, the column stays empty. */
  letters?: ReactNode;
}

/**
 * The shell (the design system's AppShell), the same on every Hearthside page
 * but the signing-in and invite pages: the rail (the Hearthside name, the nav
 * with the current place marked, then Your Quests), the page, and Letters.
 *
 * Wide, it's three columns; under 1100px the rail and Letters stack on the
 * left. Under 760px it's one column, and the nav folds behind a menu button on
 * the left of the row under the top bar, with the page's back link
 * (`<BackLink>`) on the right; this replaces the design system's 2 × 2 nav
 * grid (spec #69, from the campaign-page prototype).
 */
export default function AppShell({ children, quests, letters }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const current = currentNav(pathname);
  const [menuOpen, setMenuOpen] = useState(false);
  const [back, setBack] = useState<BackTarget | null>(null);

  useEffect(() => setMenuOpen(false), [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  return (
    <ShellBackContext.Provider value={setBack}>
      <div className="hs-shell-wrap">
        <div className="hs-shell">
          <aside className="hs-rail">
            <div className={menuOpen ? 'hs-bar is-open' : 'hs-bar'}>
              <button
                type="button"
                className="hs-burger"
                aria-label="Menu"
                aria-expanded={menuOpen}
                aria-controls="hs-main-nav"
                onClick={() => setMenuOpen((open) => !open)}
              >
                <Menu strokeWidth={1.5} aria-hidden="true" />
              </button>
              <div className="hs-brand">Hearthside<small>The Party Gathers</small></div>
              {back && (
                <Link className="hs-btn-amber hs-back hs-back-m" href={back.href}>
                  ← {back.label}
                </Link>
              )}
              <GildedPanel as="nav" className="hs-nav" id="hs-main-nav" aria-label="Main">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={item === current ? 'page' : undefined}
                    onClick={() => setMenuOpen(false)}
                  >
                    {item.label}
                  </Link>
                ))}
              </GildedPanel>
            </div>
            {quests}
          </aside>

          <main className="hs-page">{children}</main>

          {letters && <aside className="hs-letters-col" aria-label="Letters">{letters}</aside>}
        </div>
      </div>
    </ShellBackContext.Provider>
  );
}
