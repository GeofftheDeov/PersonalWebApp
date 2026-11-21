"use client";

import { createElement, useEffect, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { gildOne } from '@/design-system/hearthside';

type PanelTag = 'div' | 'nav' | 'section' | 'aside' | 'article' | 'header' | 'form';

export interface GildedPanelProps extends HTMLAttributes<HTMLElement> {
  /** The element to render. Default `div`. */
  as?: PanelTag;
  children?: ReactNode;
}

/**
 * Gilded leather (the design system's GildedPanel): the app's tools sit on
 * it. The leather and the gold frame are CSS (`hs-gilded`); the hairline and
 * the four filigree corners are added after mounting and taken off again on
 * unmount.
 *
 *   <GildedPanel as="nav" className="hs-nav" aria-label="Main">…</GildedPanel>
 */
export default function GildedPanel({ as = 'div', className, children, ...rest }: GildedPanelProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return gildOne(ref.current);
  }, []);
  return createElement(as, { ...rest, ref, className: className ? `hs-gilded ${className}` : 'hs-gilded' }, children);
}
