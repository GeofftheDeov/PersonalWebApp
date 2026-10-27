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

**Layout B, "Chronicle", with a switch to a calendar.** Picked by Geoff on 2026-10-26; the prototype now opens on it.

- The page opens on the list. A List / Calendar switch sits at the right of the page heading.
- **List:** sessions by week, each a parchment sheet beside its date, with Coming up and Played tabs. Quests appear only on their session's sheet, not on their own due days.
- **Calendar:** layout A's grid, with Month and Week tabs across the top of the panel. Week gives each day a tall column with every session (times, title, place) and quest written out in full; on phones it becomes a list of days. Picking a day in either shows that day's sessions as parchment below. Switching between Month and Week keeps the chosen day.

Still open: whether the calendar puts quests on their own due day or only counts them on their session (the bar's "Calendar quests" switch), and the "Awaiting a night" panel, which needs the API change above.

Rejected: C, "Campaign lanes". Layout A as first shown (month only) is kept in the switcher for comparison.

## Running it

From the repo root:

```
python -m http.server 4173 --bind 127.0.0.1 --directory prototypes/hearthside-almanac
```

Then open http://127.0.0.1:4173/hearthside-almanac-prototype.html (or start `almanac-prototype` from `.claude/launch.json`). It needs a server rather than a double-click because it loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR). The published version is https://claude.ai/artifact/Suk8ZxCB2DJ4JqiRgfrsfd.

Use the bar at the bottom or the arrow keys to switch layouts; `?variant=A|B|C` picks one. The bar also switches:

- **Calendar quests: on their due day / with their session.** Whether quests appear on the calendar on their own due day, or only as a count on their session. The list ignores it: there, quests are always on their session's sheet.
- **Data: a busy month / a quiet month.** Nine sessions across three campaigns (with a cancelled one, a weekend-long one and an undated one), or a single session with no quests, to see the empty states.

All data is made up and kept in memory, with "today" fixed at Mon Oct 26 2026. Checking a quest updates the page and Your Quests in the rail together; nothing is saved.
