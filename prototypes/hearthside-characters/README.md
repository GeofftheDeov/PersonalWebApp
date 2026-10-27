# PROTOTYPE: Hearthside Adventurers (the Characters page)

Throwaway. This branch is not meant to be merged. It keeps the prototype as the record of how the decision was made. Build the real page fresh: this code has no tests and stubs every action.

## The question

What should Hearthside's Characters page look like, in the Hearthside design system? The design system already names it **Adventurers** in the nav, and lists "an adventurer's sheet" among the patterns it doesn't have yet.

The page has to stay **game-system agnostic**. A player shouldn't have to copy their sheet out of D&D Beyond, Demiplane or a PDF to be represented here. So an adventurer is:

- **Required:** a name. Nothing else.
- **Asked for:** art, plus a class and a level, both in the player's own words. "Class, role or calling" is free text. Level is an optional number: Call of Cthulhu has none, so Dr. Ada Marsh shows no level seal.
- **Linked, not copied:** the campaign, the sessions they played, and "Where the full sheet lives", a URL to wherever the real sheet is kept.
- **Optional:** the game, a one-line description ("In a line"), a short story, and **Details**: label and value pairs the player names, such as Ancestry: Ysoki, Ship: The Gull's Wager or Sanity: 31, from 65. This is where system-specific things go without Hearthside knowing any system.
- **Status:** Adventuring, Retired or Fallen. Fallen can name the session they fell in.

The editor is the same in every layout: a gilded dialog, with "New adventurer" on the roster and "Edit" on an adventurer's page.

## The layouts

- **A, "Portrait gallery"** (art first). The roster is portraits in gilded frames hung on the floor, each with a brass name plate (name, class and level) and the next session under it. Retired and fallen adventurers hang in "The Hall of Heroes" below: retired ones fade to sepia, and fallen ones lose their colour and get a black ribbon. An adventurer's page leads with a large portrait and a strip of every piece of their art. You can add art, flip through it, and make any piece the portrait. Beside the art, a leather panel holds the level seal, the facts, the player's details, the story and the link to the full sheet. Below come the party (the campaign banner and the other players' adventurers) and every session played, with the next one first and level-ups tagged.
- **B, "Ledger and sheet"** (words first). The roster is a leather ledger with Adventuring and Retired-and-fallen tabs. Each row has a round portrait, the name, class, level and game, the campaign, and the next session. Picking a row shows that adventurer's **parchment sheet** below, pinned to the floor. The portrait is taped into its corner, and the sheet has a ledger of facts and details, "The full sheet is kept on D&D Beyond", their story, the sessions they played, and more art taped along the bottom.
- **C, "The road so far"** (history first). The roster is grouped by campaign: each campaign's banner with your adventurer's medallion and the party they travel with. The groups are "On the road", "Between adventures" (not in a campaign) and "Tales told" (finished campaigns). Campaigns you run as Dungeon Master say so instead. An adventurer's page has a hero with their art blurred behind a large medallion, then **the road**, a timeline from the next session back through each one played. It marks the levels reached, the session they fell in, retiring, joining the campaign and the day they were made. Their sheet (facts, details, story, art) sits beside it.

Material is part of the question. The design system keeps parchment for "one session's own business". B puts an adventurer on parchment, which stretches that rule. A and C keep them on leather and the floor.

## What the data would need

The prototype shows more than the `characters` table holds today (`backend/db/schema.sql`: name, player, one campaign, game_type, class, level, is_dead).

- **Which sessions an adventurer played: not recorded yet.** Attendance (`player_sessions`) records players, not characters. Every layout's session list, and C's whole road, needs a character on attendance (or a session ↔ character table), filled in when the GM confirms who came.
- **Level history:** "Reached level 5 after Session 6" needs the level change to be dated or tied to a session. Today `level` is a single number.
- **New columns:** art (several images, one of them the portrait), sheet link, epithet, story, details (label/value pairs), and status in place of `is_dead`. Status adds Retired, and Fallen can name a session.
- **One campaign per adventurer** stays as it is. Nothing here needs more.

## Still open

- Uploaded art is shown 3:4 for portraits and zoomed onto the head for round medallions. Real uploads would need a cropper, like the campaign banner's.
- Other players' adventurers (in "the party" / "Travels with") open read-only. That page isn't drawn here.
- The design system has no form styles yet. The editor follows the message composer (`surface`, `line`, `radius`), as the campaign page did.
- The level seal, portrait frame, brass plate, medallion and taped photo are drawn in this prototype. Whichever survive should go into the design system.

## Running it

From the repo root:

```
python -m http.server 4174 --bind 127.0.0.1 --directory prototypes/hearthside-characters
```

Then open http://127.0.0.1:4174/hearthside-characters-prototype.html (or start `characters-prototype` from `.claude/launch.json`). It needs a server rather than a double-click because it loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR).

Use the bar at the bottom or the arrow keys to switch layouts. `?variant=A|B|C` picks a layout and `&adventurer=kestrel` opens one adventurer. The bar also switches:

- **Data: Geoff's adventurers / no adventurers yet.** Six adventurers across four games, or none, to see the empty state.

All data is made up and kept in memory, with "today" fixed at Mon Oct 26 2026 (the same campaigns and sessions as the Almanac prototype). Kestrel's next session carries the Almanac's "Level Kestrel up to 6" quest. The portraits are painted by the page as stand-ins for uploads, and Wren has none, to show the fallback. Uploading a real image works, but only in memory: new adventurers, edits and art all vanish on reload.
