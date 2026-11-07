"use client";

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Menu, X, ChevronDown } from 'lucide-react';
import SocialDock from './SocialDock';
import NotificationsBell from './NotificationsBell';
import type { Letters } from '../letters/letters';
import { canAdmin, canPaperclip } from '../session/client';
import { useSession } from '../session/react';
import { topBarLinks, type TopBarSite } from './links';

export type { TopBarSite };

export interface TopBarProps {
  /**
   * Which site it's on. On Hearthside (#216) the portfolio's items go to
   * `portfolioUrl`, "Game Night" is Hearthside's `/`, Login is Hearthside's
   * `/login` returning to the page, and Admin doesn't show (see `topBarLinks`).
   * The bell's filter and the social menu's Campaigns tab are #220's; until
   * then they behave as on the portfolio.
   */
  site: TopBarSite;
  /** The app's Letters (`createLetters`), which carries its API and session clients. */
  letters: Letters;
  /** The portfolio's origin, e.g. `https://geoffthedeov.net`. Required on Hearthside. */
  portfolioUrl?: string;
}

/**
 * The GeofftheDeov navigation bar across the top of both sites (#211, spec
 * #69): the nav, the notifications bell and the social dock. It keeps the
 * portfolio's look, light and dark, wherever it's mounted; its Tailwind
 * classes need the app's Tailwind to scan this package.
 *
 * A client component: mount it from one of the app's own client components,
 * since `letters` can't cross from a server component.
 *
 *   <TopBar site="portfolio" letters={letters} />
 *   <TopBar site="hearthside" letters={letters} portfolioUrl="https://geoffthedeov.net" />
 */
export default function TopBar({ site, letters, portfolioUrl }: TopBarProps) {
  const { api, session } = letters;
  const router = useRouter();
  const pathname = usePathname();
  const links = topBarLinks(site, portfolioUrl);
  // Hearthside's Login comes back to the page it was opened from; the
  // portfolio's is unchanged.
  const loginHref = site === 'hearthside' ? session.loginUrl(pathname ?? '/') : '/login';
  // Who's signed in, and what they may do, come from the session client,
  // which asks the server (#210). See @gtd/shared/session.
  const { status, capabilities: caps } = useSession(session);
  const isLoggedIn = status === 'signedIn';
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [paperclipOpen, setPaperclipOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [mobilePaperclipOpen, setMobilePaperclipOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const paperclipRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // Close desktop dropdowns on route change
  useEffect(() => {
    setPaperclipOpen(false);
    setMoreOpen(false);
  }, [pathname]);

  // Close desktop dropdowns on Esc
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPaperclipOpen(false);
        setMoreOpen(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Close desktop dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (paperclipRef.current && !paperclipRef.current.contains(e.target as Node)) {
        setPaperclipOpen(false);
      }
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleLogout = () => {
    // Clears the parent-domain session cookie (#69), so the other site is
    // logged out as well. The client's state goes either way.
    session.logout().catch(() => {});
    setIsMenuOpen(false);
    router.push('/');
  };

  // The admin portal is server-rendered and still takes a bearer token in its
  // URL. The browser holds none (#210), so ask for one as the link is opened.
  const openAdmin = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    closeMenu();
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const { token } = await api.post<{ token: string }>('/api/users/me/admin-token');
      if (tab) tab.location.href = `/admin?token=${encodeURIComponent(token)}`;
      else window.location.href = `/admin?token=${encodeURIComponent(token)}`;
    } catch {
      tab?.close();
    }
  };

  const closeMenu = () => {
    setIsMenuOpen(false);
    setMobilePaperclipOpen(false);
    setMobileMoreOpen(false);
  };

  const linkCls = "group relative text-lg font-bold text-black dark:text-white";
  const mobileLinkCls = "text-3xl font-black tracking-tight text-black dark:text-white uppercase font-permanent";
  const decorationCls = "absolute -bottom-1 left-0 h-2 w-0 bg-orange-500 group-hover:w-full transition-all duration-300";
  const dropdownItemCls = "block w-full text-left px-4 py-2 font-permanent text-sm uppercase text-black dark:text-white hover:bg-zinc-100 dark:hover:bg-zinc-800 hover:text-teal-600 transition-colors focus:outline-none focus:bg-zinc-100 dark:focus:bg-zinc-800";
  const mobileSubLinkCls = "text-xl font-black tracking-tight text-teal-600 dark:text-teal-400 uppercase font-permanent";

  return (
    <nav className="sticky top-0 z-50 w-full border-b-4 border-black bg-white dark:bg-black dark:border-white">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <Link href={links.home} onClick={closeMenu} className="text-2xl font-black tracking-tighter text-black dark:text-white hover:skew-x-2 transition-transform">
          GEOFF<span className="text-teal-600">THE</span>DEV
        </Link>

        {/* Desktop Menu */}
        <div className="hidden md:flex gap-8 items-center">
          <Link href={links.about} className={linkCls}>
            <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">ABOUT</span>
            <div className={`${decorationCls} rotate-1`} />
          </Link>

          {isLoggedIn && (
            <>
              <Link href={links.dashboard} className={linkCls}>
                <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">DASHBOARD</span>
                <div className={`${decorationCls} -rotate-1`} />
              </Link>

              {/* Paperclip — admins, or people linked to a Paperclip account (#36) */}
              {canPaperclip(caps) && (
                <div className="relative" ref={paperclipRef}>
                  <button
                    onClick={() => { setPaperclipOpen(o => !o); setMoreOpen(false); }}
                    className={`${linkCls} flex items-center gap-1`}
                    aria-expanded={paperclipOpen}
                    aria-haspopup="true"
                  >
                    <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">PAPERCLIP</span>
                    <ChevronDown className={`relative z-10 w-4 h-4 transition-transform duration-200 ${paperclipOpen ? 'rotate-180' : ''}`} />
                    <div className={`${decorationCls} rotate-1`} />
                  </button>
                  {paperclipOpen && (
                    <div className="absolute top-full left-0 mt-2 min-w-[9rem] border-4 border-black bg-white dark:bg-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] z-50 flex flex-col">
                      <Link href={links.paperclip.org} onClick={() => setPaperclipOpen(false)} className={dropdownItemCls} tabIndex={0}>ORG</Link>
                      <Link href={links.paperclip.issues} onClick={() => setPaperclipOpen(false)} className={dropdownItemCls} tabIndex={0}>ISSUES</Link>
                      <Link href={links.paperclip.budgets} onClick={() => setPaperclipOpen(false)} className={dropdownItemCls} tabIndex={0}>BUDGETS</Link>
                    </div>
                  )}
                </div>
              )}

              {/* More dropdown */}
              <div className="relative" ref={moreRef}>
                <button
                  onClick={() => { setMoreOpen(o => !o); setPaperclipOpen(false); }}
                  className={`${linkCls} flex items-center gap-1`}
                  aria-expanded={moreOpen}
                  aria-haspopup="true"
                >
                  <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">MORE</span>
                  <ChevronDown className={`relative z-10 w-4 h-4 transition-transform duration-200 ${moreOpen ? 'rotate-180' : ''}`} />
                  <div className={`${decorationCls} -rotate-1`} />
                </button>
                {moreOpen && (
                  <div className="absolute top-full left-0 mt-2 min-w-[10rem] border-4 border-black bg-white dark:bg-black shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] z-50 flex flex-col">
                    <Link href={links.profile} onClick={() => setMoreOpen(false)} className={dropdownItemCls} tabIndex={0}>PROFILE</Link>
                    <Link href={links.gameNight} onClick={() => setMoreOpen(false)} className={dropdownItemCls} tabIndex={0}>GAME NIGHT</Link>
                  </div>
                )}
              </div>

              {/* Admin portal — app_role only. The server agrees (#43). */}
              {links.admin && canAdmin(caps) && (
                <a
                  href="/admin"
                  onClick={openAdmin}
                  className={linkCls}
                >
                  <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">ADMIN</span>
                  <div className={`${decorationCls} -rotate-1`} />
                </a>
              )}

              <NotificationsBell letters={letters} />
              <SocialDock letters={letters} />

              <button onClick={handleLogout} className={linkCls}>
                <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">LOGOUT</span>
                <div className={`${decorationCls} rotate-2`} />
              </button>
            </>
          )}

          {!isLoggedIn && (
            <Link href={loginHref} className={linkCls}>
              <span className="relative z-10 group-hover:text-teal-600 transition-colors uppercase">LOGIN</span>
              <div className={`${decorationCls} rotate-1`} />
            </Link>
          )}
        </div>

        {/* Hamburger */}
        <button
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          className="md:hidden p-2 text-black dark:text-white transition-transform active:scale-95"
          aria-label="Toggle menu"
        >
          {isMenuOpen ? <X className="w-8 h-8" /> : <Menu className="w-8 h-8" />}
        </button>
      </div>

      {/* Mobile Menu Overlay */}
      {isMenuOpen && (
        <div className="fixed inset-0 top-[76px] z-40 bg-white dark:bg-black p-8 md:hidden flex flex-col items-center justify-center gap-8 overflow-y-auto border-t-4 border-black dark:border-white">
          <Link href={links.about} onClick={closeMenu} className={mobileLinkCls}>ABOUT</Link>

          {isLoggedIn ? (
            <>
              <Link href={links.dashboard} onClick={closeMenu} className={mobileLinkCls}>DASHBOARD</Link>

              {canPaperclip(caps) && (
                <div className="flex flex-col items-center gap-3">
                  <button
                    onClick={() => setMobilePaperclipOpen(o => !o)}
                    className={`${mobileLinkCls} flex items-center gap-2`}
                  >
                    PAPERCLIP
                    <ChevronDown className={`w-6 h-6 transition-transform duration-200 ${mobilePaperclipOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {mobilePaperclipOpen && (
                    <div className="flex flex-col items-center gap-3 pt-1">
                      <Link href={links.paperclip.org} onClick={closeMenu} className={mobileSubLinkCls}>ORG</Link>
                      <Link href={links.paperclip.issues} onClick={closeMenu} className={mobileSubLinkCls}>ISSUES</Link>
                      <Link href={links.paperclip.budgets} onClick={closeMenu} className={mobileSubLinkCls}>BUDGETS</Link>
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-col items-center gap-3">
                <button
                  onClick={() => setMobileMoreOpen(o => !o)}
                  className={`${mobileLinkCls} flex items-center gap-2`}
                >
                  MORE
                  <ChevronDown className={`w-6 h-6 transition-transform duration-200 ${mobileMoreOpen ? 'rotate-180' : ''}`} />
                </button>
                {mobileMoreOpen && (
                  <div className="flex flex-col items-center gap-3 pt-1">
                    <Link href={links.profile} onClick={closeMenu} className={mobileSubLinkCls}>PROFILE</Link>
                    <Link href={links.gameNight} onClick={closeMenu} className={mobileSubLinkCls}>GAME NIGHT</Link>
                  </div>
                )}
              </div>

              {links.admin && canAdmin(caps) && (
                <a
                  href="/admin"
                  onClick={openAdmin}
                  className={mobileLinkCls}
                >
                  ADMIN
                </a>
              )}

              <button onClick={handleLogout} className={mobileLinkCls}>LOGOUT</button>
            </>
          ) : (
            <Link href={loginHref} onClick={closeMenu} className={mobileLinkCls}>LOGIN</Link>
          )}

          <div className="mt-8 flex items-center gap-4">
            <NotificationsBell letters={letters} />
            <SocialDock letters={letters} />
          </div>
        </div>
      )}
    </nav>
  );
}
