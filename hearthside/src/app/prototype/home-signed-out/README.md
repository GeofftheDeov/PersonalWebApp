# PROTOTYPE: Hearthside's home, signed out

**Question:** what should `/` show someone who isn't signed in? Today `/` (The Hearth) sends them straight to `/login`.
The "Hearthside Home" design canvas already storyboards one answer, an animated walk-in from the street to the
Notice Board. These are four fresh takes that don't depend on that animation.

Run it: `npm run dev` in `hearthside/`, then open `http://127.0.0.1:3002/prototype/home-signed-out`.
Flip variants with the bar at the bottom, or ← →, or `?variant=A|B|C|D`. No backend is needed: nothing here signs
anyone in (links go to the real `/login` and `/signup`; B's inline form is a stub).

| Key | Name | Structure | Primary affordance |
|---|---|---|---|
| A | The notice | One parchment sheet is the page, written as a tavern notice; the Notice Board's three steps explain the product, with an example vote | Sign in / Create an account at the sheet's foot |
| B | At the door | Split: big line and the four places on the floor, sign-in form in a gilded panel beside it | Signing in, right on the home page |
| C | The week | A road down the floor, Monday to Friday, each day showing the part of Hearthside that does that job | Reading the story, then the CTA at the road's end |
| D | The round table | The session page's table top, with the five places on brass plates round it; choosing one fills the card in the middle | Exploring the places, CTA always on the card |

All four sit under the real top bar on the real floor, outside the shell (no rail, no Letters), as the sign-in pages do.

## Folding in the winner

- `/` lives in the `(shell)` route group, so a signed-out home needs either the shell layout to skip itself when
  signed out, or The Hearth moved out of the group with its own layout. That's the real implementation decision.
- `useRequiredSession` on `/` becomes `useSession`, rendering this page on `signedOut` and The Hearth on `signedIn`.
- Rebuild the chosen variant properly; drop `src/app/prototype/` and `src/components/prototype/` from main.

## Verdict

_(to fill in once a variant is chosen, and why)_
