"use client";

import { useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { mountSheet, type NoticeSheet as SheetHandle } from '@/design-system/hearthside';

export interface NoticeSheetProps extends HTMLAttributes<HTMLElement> {
  /** What the sheet's wear is seeded from: use the session's id, so it always ages the same way. */
  seed: string;
  children?: ReactNode;
}

/**
 * Parchment (the design system's NoticeSheet): one session's own business,
 * pinned to the board. The sheet's content is markup; its weathered paper is
 * drawn onto a canvas behind it after mounting, redrawn as it resizes, and
 * taken out again on unmount. Until it's drawn (or without canvas) the CSS
 * paper shows.
 */
export default function NoticeSheet({ seed, className, children, ...rest }: NoticeSheetProps) {
  const ref = useRef<HTMLElement>(null);
  const sheet = useRef<SheetHandle | null>(null);
  // The seed the paper was last drawn with, so an unchanged seed doesn't redraw it.
  const drawnSeed = useRef(seed);

  useEffect(() => {
    if (!ref.current) return;
    const s = mountSheet(ref.current, { seed: drawnSeed.current });
    sheet.current = s;
    return () => {
      s.destroy();
      sheet.current = null;
    };
    // The seed is read once here; a change goes through setSeed below.
  }, []);

  useEffect(() => {
    if (seed === drawnSeed.current) return;
    drawnSeed.current = seed;
    sheet.current?.setSeed(seed);
  }, [seed]);

  return (
    <article ref={ref} {...rest} className={className ? `hs-sheet ${className}` : 'hs-sheet'} data-seed={seed}>
      {children}
    </article>
  );
}
