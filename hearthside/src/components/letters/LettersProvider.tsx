"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { initials } from '@/lib/lettersFormat';

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
}

const LettersContext = createContext<LettersControl | null>(null);

/**
 * Which thread the shell's Letters has open (#221), for the panel and for any
 * page in the shell. The shell layout provides it, so it lasts across page
 * changes. A page opens a thread with `useLetters()`:
 *
 *   const letters = useLetters();
 *   <button onClick={() => letters.openDm(person.id, person.name)}>Write a letter</button>
 */
export function LettersProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<OpenLetter | null>(null);
  const [summoned, setSummoned] = useState(0);

  const summon = useCallback((letter: OpenLetter) => {
    setOpen(letter);
    setSummoned((n) => n + 1);
  }, []);

  const control = useMemo<LettersControl>(() => ({
    open,
    summoned,
    show: setOpen,
    openDm: (personId, name) =>
      summon({ kind: 'dm', id: personId, title: name, subtitle: 'Friend', avatarHint: initials(name) }),
    openCampaign: (campaignId, title) =>
      summon({ kind: 'campaign', id: campaignId, title, subtitle: 'Campaign', avatarHint: initials(title) }),
    close: () => setOpen(null),
  }), [open, summoned, summon]);

  return <LettersContext.Provider value={control}>{children}</LettersContext.Provider>;
}

/** The shell's Letters, for opening a thread from a page. Only inside the shell (`src/app/(shell)`). */
export function useLetters(): LettersControl {
  const control = useContext(LettersContext);
  if (!control) throw new Error('useLetters is for pages in the shell: src/app/(shell)/layout.tsx provides it.');
  return control;
}
