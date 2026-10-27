# PROTOTYPE: Hearthside Almanac

Throwaway. This branch is not meant to be merged. It keeps the prototype as the record of how the decision was made. Build the real page fresh: this code has no tests and stubs every action.

## The question

What should Hearthside's Almanac (the calendar behind the "Almanac" menu item, #69) look like, in the Hearthside design system? It shows your game sessions and your quests: the same facts `GET /api/quests/almanac` returns today (each dated session's title, campaign, date and end date, status, online or location, and your quests on it). The PWA's version is `frontend/src/components/CalendarView.tsx`, which also mixes in personal tasks and events; Hearthside's doesn't.

## The layouts

- **A, "The Month".** A month grid on gilded leather. Session days carry a chip (campaign, start time, title); quests sit on the day they're due. Picking a day lays that day's sessions out below as parchment sheets, with your quests on them. On phones the cells shrink to dots.
- **B, "Chronicle".** No grid. A running list by week ("This week", "Next week"), each day's date set large on the floor beside it. Every session is a pinned parchment sheet with your quests; quests due on other days get a small leather panel on their own day. "Played" lists past sessions.
- **C, "Campaign lanes".** A sideways-scrolling timeline, one lane per campaign. Sessions are amber seals carrying the session number; quests are diamonds on their due day, dotted to the session they're for. Picking either opens that session's sheet below.

All three show an "Awaiting a night" panel for sessions still picking a date. **The Almanac API leaves these out today** (it only returns dated sessions), so keeping that panel would need a backend change.

## The answer

Not decided yet.

## Running it

From the repo root:

```
python -m http.server 4173 --bind 127.0.0.1 --directory prototypes/hearthside-almanac
```

Then open http://127.0.0.1:4173/hearthside-almanac-prototype.html (or start `almanac-prototype` from `.claude/launch.json`). It needs a server rather than a double-click because it loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR).

Use the bar at the bottom or the arrow keys to switch layouts; `?variant=A|B|C` picks one. The bar also switches:

- **Quests: on their due day / with their session.** Whether quests appear on the calendar on their own due day, or only as a count on their session.
- **Data: a busy month / a quiet month.** Nine sessions across three campaigns (with a cancelled one, a weekend-long one and an undated one), or a single session with no quests, to see the empty states.

All data is made up and kept in memory, with "today" fixed at Mon Oct 26 2026. Checking a quest updates the page and Your Quests in the rail together; nothing is saved.
