# PROTOTYPE: Hearthside Campaigns page

Throwaway. This branch is not meant to be merged. It keeps the prototype as the record of how the decision was made. Build the real page fresh: this code has no tests and stubs every action.

## The question

What should Hearthside's Campaigns page look like (the list behind the "Campaigns" menu item, #69), in the Hearthside design system? It has to show everything the PWA's Campaigns tab shows (`frontend/src/app/game-night/page.tsx`) and give campaign banners (#81) a place in the design.

## The answer

**Layout B, "Roster", as revised.** Picked by Geoff on 2026-10-25.

- Filter tabs by status, in a gilded strip: All, In progress, Not started, Completed, each with its count.
- One card per campaign. The banner is the card's background: the card is at least 4:1 so the whole banner shows, and it grows taller if the text needs room.
- The campaign's title, status, dates and description sit on a gilded leather panel (with the filigree corners) over the left side of the banner, at most 60% of the card's width.
- The owner's Change banner and Remove buttons sit in the banner's bottom-right corner.
- No banner: a dyed-cloth fallback in Hearthside colours, with the campaign's initials stitched in gold on the right. This replaces the PWA's teal and yellow gradients.
- Phones (under 620px): the banner shows as a strip across the top of the card, and the panel fills the card below it.
- Statuses: In progress is amber with a lit dot, Completed is a moss seal, Not started is a muted outline. Seal red is kept for "needs someone", as the design system says.

Rejected: A, "Gallery" (each banner in a gilt frame with a plaque below; too much scrolling for the information), and C, "Spotlight" (one campaign large, the rest on a shelf; hides most campaigns' details).

## Running it

Open `hearthside-campaigns-prototype.html` in a browser. It loads `bundle.css` and `bundle.js`, copies of the Hearthside design system's components (https://claude.ai/artifact/4X4uHuC4vyx4Qk6mLR8KoR). The published version is https://claude.ai/artifact/U2Q8dsPLmvcFnBvDfXaDjg.

Use the bar at the bottom or the arrow keys to switch layouts. The bar also switches between viewing as the campaign's owner or as a player, and between uploaded banners and none set. All data is made up and kept in memory. The banner pictures are drawn by the page as stand-ins for uploads, and a picked image is centre-cropped rather than going through the PWA's cropper.
