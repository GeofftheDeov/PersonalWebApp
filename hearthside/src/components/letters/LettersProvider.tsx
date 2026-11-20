"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { initials } from '@/lib/lettersFormat';
import { useSession } from '@/lib/session';

/** The thread Letters has open: what it needs to name it before the thread list has it (a first DM). */
export interface OpenLetter {
  kind: 'campaign' | 'dm';
  /** The campaign's id, or the friend's account id. */
  id: string;
  title: string;
  /** "Campaign · 5 in the party", or "Friend". */
  subtitle: string;
  /** Up to two initials for the avatar. */
  avatarHint: string;
  /** Set when a page asked for this thread (not the list): its compose box takes focus. */
  summon?: number;
}

export interface LettersControl {
  /** The open thread, or null while Letters shows the thread list. */
  open: OpenLetter | null;
  /** Counts the times a page asked for a thread, so the panel comes into view (and its compose box takes focus). */
  summoned: number;
  /** Opens a thread from the list (no scrolling: the person is already looking at it). */
  show(letter: OpenLetter): void;
  /** Opens your letters with a friend ("Write a letter" on their page, #231). */
  openDm(personId: string, name: string): void;
  /** Opens a campaign's Table Talk. */
  openCampaign(campaignId: string, title: string): void;
  /** Back to the thread list. */
  close(): void;
  /**
   * Whether this page shows Letters (#251): someone is signed in and a
   * `<Letters/>` panel is mounted (every page in the shell; not the sign-in
   * pages or `/join/:id`). The top bar offers a friend's MESSAGE only then.
   */
  shown: boolean;
}

const LettersContext = createContext<LettersControl | null>(null);
/** How a mounted `<Letters/>` panel says it's on the page: returns its unmount. */
const PanelContext = createContext<(() => () => void) | null>(null);

/**
 * Which thread Letters has open (#221), for the panel, any page and the top
 * bar (#251). The root layout provides it, so it lasts across page changes,
 * and the top bar's friend MESSAGE can open a letter. Where Letters appears is
 * up to each page: the shell draws it, and the pages outside the shell (the
 * sign-in pages, `/join/:id`) don't. A page opens a thread with `useLetters()`:
 *
 *   const letters = useLetters();
 *   <button onClick={() => letters.openDm(person.id, person.name)}>Write a letter</button>
 *
 * It holds nothing but which thread is open, and only while someone is
 * signed in: signing out (or in as someone else) closes it. The thread list,
 * the threads and the live socket belong to `<Letters/>`, which reads nothing
 * while nobody is signed in.
 */
export function LettersProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const me = session.status === 'signedIn' ? session.user.id : null;
  const [open, setOpen] = useState<OpenLetter | null>(null);
  const [summoned, setSummoned] = useState(0);
  const [panels, setPanels] = useState(0);

  // Another person's letter never stays open past a sign-out.
  useEffect(() => { setOpen(null); }, [me]);

  const addPanel = useCallback(() => {
    setPanels((n) => n + 1);
    return () => setPanels((n) => n - 1);
  }, []);

  const summons = useRef(0);
  const summon = useCallback((letter: OpenLetter) => {
    const n = ++summons.current;
    setOpen({ ...letter, summon: n });
    setSummoned(n);
  }, []);

  const control = useMemo<LettersControl>(() => ({
    open: me ? open : null,
    summoned,
    shown: me !== null && panels > 0,
    show: (letter) => setOpen({ ...letter, summon: undefined }),
    openDm: (personId, name) =>
      summon({ kind: 'dm', id: personId, title: name, subtitle: 'Friend', avatarHint: initials(name) }),
    openCampaign: (campaignId, title) =>
      summon({ kind: 'campaign', id: campaignId, title, subtitle: 'Campaign', avatarHint: initials(title) }),
    close: () => setOpen(null),
  }), [me, open, summoned, panels, summon]);

  return (
    <LettersContext.Provider value={control}>
      <PanelContext.Provider value={addPanel}>{children}</PanelContext.Provider>
    </LettersContext.Provider>
  );
}

/** Letters, for opening a thread from a page or the top bar. The root layout (src/app/layout.tsx) provides it. */
export function useLetters(): LettersControl {
  const control = useContext(LettersContext);
  if (!control) throw new Error('useLetters needs LettersProvider, which src/app/layout.tsx provides.');
  return control;
}

/** For `<Letters/>`: marks the page as showing Letters while it's mounted (`LettersControl.shown`). */
export function useLettersPanel(): void {
  const addPanel = useContext(PanelContext);
  if (!addPanel) throw new Error('Letters needs LettersProvider, which src/app/layout.tsx provides.');
  useEffect(() => addPanel(), [addPanel]);
}
