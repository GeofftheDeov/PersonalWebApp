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

## The answer

**D, "Gallery + road": A's roster with C's adventurer page.** Picked by Geoff on 2026-10-26. The prototype now opens on it, and A, B and C stay in the switcher for comparison.

- **Roster:** A's portrait wall and Hall of Heroes. Hovering or focusing a portrait lights its frame brighter than in round 1: a stronger gold rim and a firelight glow around it.
- **An adventurer's page:** C's hero and road, with the right-hand column reorganized:
  - **Art** is its own panel, above the sheet. It's a grid of every piece, with the portrait marked, plus an Add art tile. Picking a piece opens it large, where you can step through the pieces and make any of them the portrait. C's page shows the same changes.
  - **Their sheet** holds the facts, the player's details and their story, then **The full sheet**, then **Travels with** (moved inside the panel), then Edit.
  - **The full sheet** can be a link (D&D Beyond, Demiplane, Drive), an **uploaded copy** (a PDF or a picture), or both. "Upload a sheet", "Replace the copy" and "Link to it" sit right there, and the editor has the same upload. Hearthside keeps the file as it is and never reads it into fields, so it stays game-system agnostic. Parsing an import from a particular system would break that, so it isn't offered.
- **Sessions come from attendance (decided).** An adventurer was at a session if their player was. If the player wasn't, the GM says whether the adventurer was there anyway when confirming who came. The road shows all three cases: played; played while you were away ("the party brought Kestrel Vane along", dashed node); and sat out (struck through and faded, counted as "missed"). "As the GM: take attendance" on the bar opens the GM's dialog for the open adventurer's latest session. Unticking a player asks "Was Kestrel Vane there?", with the answers "No, they sat it out" and "Yes, the party played them". Saving updates the road. In the real app this belongs in the campaign page's attendance step.

- **Who sees the campaign (decided 2026-10-27).** An adventurer's campaign and sessions show only to people in that adventurer's campaign. That matches the player-profile prototype's rule: a campaign-mate sees all your adventurers, but not campaigns they're not in. Anyone else, whether a friend or a campaign-mate from a different campaign, sees:
  - **On the roster:** each adventurer's game, with no campaign and no next session. The page is titled "Geoff's adventurers", with no New adventurer button.
  - **On an adventurer's page:** the hero, the art and their sheet. There's no road and no Campaign row. Status says "Fallen" without naming the session, and there's no Travels with. The art and the sheet then share the width.
  - **Never, for anyone but the owner:** Edit, Add art, Make this the portrait, the sheet's upload, link and Remove buttons, or the owner's quests on the next session. The full sheet still opens for them, and it's left out when there's none.

  A campaign-mate in the same campaign sees the road as it is, read only, with "Geoff was away" in place of "You were away".

## What the data would need

The prototype shows more than the `characters` table holds today (`backend/db/schema.sql`: name, player, one campaign, game_type, class, level, is_dead).

- **Which sessions an adventurer played.** Attendance (`player_sessions`) records players, not characters. The rule above needs two more things:
  - Each adventurer's span in their campaign: the session they joined at, and the one they left at by falling or retiring. That span says which adventurer a player's attendance counts for. Pip played Sessions 1 to 9 of The Lantern Road and Mags played 10 to 18, both for Geoff.
  - A record of the adventurers who were at a session without their player, set from the GM's attendance step.

  If a player ever has two adventurers in one campaign at once, attendance can't tell which one came. The GM would have to pick, which this prototype doesn't draw.
- **The uploaded sheet:** a file per adventurer (S3, like campaign banners), shown to the party.
- **Level history:** "Reached level 5 after Session 6" needs the level change to be dated or tied to a session. Today `level` is a single number.
- **New columns:** art (several images, one of them the portrait), sheet link, epithet, story, details (label/value pairs), and status in place of `is_dead`. Status adds Retired, and Fallen can name a session.
- **One campaign per adventurer** stays as it is. Nothing here needs more.
- **Reading someone else's adventurer:** an endpoint that returns the adventurer to anyone allowed to see them. It includes the campaign, the road and Travels with only when the viewer is in the adventurer's campaign, which the server decides from `campaign_members` and doesn't leave to the page. Who may open them at all (friends, campaign-mates, or anyone with the link) isn't decided.

## Still open

- Uploaded art is shown 3:4 for portraits and zoomed onto the head for round medallions. Real uploads would need a cropper, like the campaign banner's.
- Other players' adventurers (in "the party" / "Travels with") open read-only, the way "Viewing as" draws Geoff's for someone else.
- When someone else is viewing, the rail still shows Geoff's quests and letters. In the app, the rail is the viewer's own.
- The design system has no form styles yet. The editor follows the message composer (`surface`, `line`, `radius`), as the campaign page did.
- The level seal, portrait frame, brass plate, medallion and taped photo are drawn in this prototype. Whichever survive should go into the design system.

## Running it

From the repo root:

```
python -m http.server 4174 --bind 127.0.0.1 --directory prototypes/hearthside-characters
```

Then open http://127.0.0.1:4174/hearthside-characters-prototype.html (or start `characters-prototype` from `.claude/launch.json`). It needs a server rather than a double-click because it loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR).

Use the bar at the bottom or the arrow keys to switch layouts. `?variant=A|B|C|D` picks a layout (D is the default) and `&adventurer=kestrel` opens one adventurer. The bar also has:

- **Data: Geoff's adventurers / no adventurers yet.** Six adventurers across four games, or none, to see the empty state.
- **Viewing as: you / Avery / Sam** (D only). Avery is in Bones of the Brinewood with you, so they see Brother Odran's road but not the others'. Sam is a friend with no campaigns in common. `&viewer=avery|sam` picks one.
- **As the GM: take attendance.** The GM's attendance dialog, for the open adventurer's latest session. It's shown only while viewing as you.

The sample attendance has Geoff away from Starfall Salvage's Session 3 (the party brought Kestrel along) and Session 5 (Kestrel sat it out), and from The Lantern Road's Sessions 6 (Pip sat it out) and 14 (Mags came anyway).

All data is made up and kept in memory, with "today" fixed at Mon Oct 26 2026 (the same campaigns and sessions as the Almanac prototype). Kestrel's next session carries the Almanac's "Level Kestrel up to 6" quest. The portraits are painted by the page as stand-ins for uploads, and Wren has none, to show the fallback. Uploading a real image works, but only in memory: new adventurers, edits and art all vanish on reload.
