"use client";

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { mountFloor, reduceMotion, type Floor as FloorHandle } from '@/design-system/hearthside';
import { floorPage } from '@/lib/nav';

/**
 * The floor (the design system's Floor): honey-oak boards drawn by WebGL,
 * fixed behind every Hearthside page, with the hearth's glow over them.
 * Without WebGL the design system's CSS floor stands in.
 *
 * On a route change the boards slide sideways to the new place's page (the
 * nav's order, src/lib/nav.ts), as the design system's "Building a page"
 * says. Under reduced motion the floor stays still.
 *
 * The canvas is made here rather than rendered: giving the WebGL context back
 * on unmount spoils a canvas for good, and React may mount this twice (Strict
 * Mode), so each mount draws on a fresh one.
 */
export default function Floor() {
  const host = useRef<HTMLDivElement>(null);
  const floor = useRef<FloorHandle | null>(null);
  const pathname = usePathname() ?? '/';
  // The route the boards are showing: placed without a slide on mount, then
  // slid to each new route.
  const shownPath = useRef(pathname);

  useEffect(() => {
    const canvas = document.createElement('canvas');
    canvas.className = 'hs-floor';
    canvas.setAttribute('aria-hidden', 'true');
    host.current?.appendChild(canvas);
    const f = mountFloor(canvas);
    const page = floorPage(shownPath.current);
    if (page !== null) f.page(page, false);
    floor.current = f;
    return () => {
      f.destroy();
      canvas.remove();
      floor.current = null;
    };
  }, []);

  useEffect(() => {
    if (shownPath.current === pathname) return;
    shownPath.current = pathname;
    const page = floorPage(pathname);
    if (page === null || !floor.current || reduceMotion()) return;
    floor.current.page(page);
  }, [pathname]);

  return (
    <>
      <div ref={host} className="hs-floor-host" aria-hidden="true" />
      <div className="hs-glow" aria-hidden="true" />
    </>
  );
}
