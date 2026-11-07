/** One of Hearthside's places, in the rail's nav. */
export interface NavItem {
  label: string;
  href: string;
  /** Other paths whose pages belong to this place (marked as it, and panning the floor to it). */
  under: string[];
}

/**
 * The rail's nav (spec #69), in order. The order is also the floor's page:
 * changing place slides the floorboards one step per item, as in the
 * prototypes. Adventurers keep the word `characters` in their paths, so the
 * portfolio's redirects stay a plain prefix strip.
 */
export const NAV: readonly NavItem[] = [
  { label: "The Hearth", href: "/", under: [] },
  { label: "Campaigns", href: "/campaigns", under: ["/sessions"] },
  { label: "Almanac", href: "/almanac", under: [] },
  { label: "Adventurers", href: "/characters", under: [] },
  { label: "Your Room", href: "/room", under: [] },
];

const within = (path: string, base: string) =>
  base === "/" ? path === "/" : path === base || path.startsWith(`${base}/`);

/** The place a page belongs to, to mark in the nav; null for pages outside them (sign-in, another player). */
export function currentNav(pathname: string): NavItem | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
  return NAV.find((n) => [n.href, ...n.under].some((base) => within(path, base))) ?? null;
}

/** The floor's page for a route, or null to leave the floor where it is. */
export function floorPage(pathname: string): number | null {
  const item = currentNav(pathname);
  return item ? NAV.indexOf(item) : null;
}
