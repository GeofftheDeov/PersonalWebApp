"use client";

import { TopBar } from '@gtd/shared/topbar';
import { HEARTHSIDE_URL } from '../lib/hearthside';
import { letters } from '../lib/letters';

/**
 * The top bar, from the package shared with Hearthside (#211). The root
 * layout is a server component, and `letters` can't cross to the client from
 * there, so it's wired up here. Its "Game Night" goes to Hearthside once
 * Hearthside is configured (#234).
 */
export default function Navigation() {
  return <TopBar site="portfolio" letters={letters} hearthsideUrl={HEARTHSIDE_URL} />;
}
