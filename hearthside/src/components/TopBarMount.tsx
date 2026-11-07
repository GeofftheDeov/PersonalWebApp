"use client";

import { TopBar } from '@gtd/shared/topbar';
import { PORTFOLIO_URL } from '@/lib/config';
import { letters } from '@/lib/letters';

/**
 * The GeofftheDeov top bar across the top of every Hearthside page (#216),
 * from the package shared with the portfolio (#211). The root layout is a
 * server component, and `letters` can't cross to the client from there, so
 * it's wired up here.
 *
 * The bar keeps the portfolio's look. Its Tailwind utilities only apply
 * inside `.hs-topbar` (tailwind.config.js), which also carries the bar's own
 * scoped reset and fonts (globals.css). The wrapper is `display: contents`,
 * so the bar stays sticky against the page, not this box.
 */
export default function TopBarMount() {
  return (
    <div className="hs-topbar">
      <TopBar site="hearthside" letters={letters} portfolioUrl={PORTFOLIO_URL} />
    </div>
  );
}
