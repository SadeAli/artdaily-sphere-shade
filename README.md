# Shade a Sphere 🌑

A daily drill for the anatomy of light on form. Two spheres per round,
each with a given sun: **draw** the line across the sphere that runs at
a right angle (90°) to the light arrow — that is the terminator, where the light
stops; the drill fits the principal axis of your line, so it trains the
hand, not just the eye — then drag the core-shadow band, the bounce
(reflected) light and the contact (occlusion) shadow to where they
belong. Hit done and the true anatomy is revealed in lilac, with a
dashed line from each of your marks to where it belonged, next to a
flat-value plan sphere with its bands named — terminator included. The
score line names whichever of the four marks came out weakest
(`markNote`, pure), so the reveal is a lesson and not just a number.
Sphere 1 is side-lit, sphere 2 goes three-quarter or back; on a first
ever visit both spheres keep the easy light, so the first round is
winnable before the drill escalates.

**A lift does not end the line.** A trackpad runs out of pad long before
a sphere runs out of width, so pressing again near where you stopped
(within ~2.5s) carries the same line on, and the axis is fitted to every
segment together. A short attempt is never binned — the ink stays and
the sheet says what happened.

The light is a real 3D unit vector — an azimuth on the sheet plus a tilt
out of it, declared in the little plan view — and every drawn truth is
derived from it: the terminator is the projection of the great circle
`P·L = 0` (semi-minor `R·|Lz|`, visible half exactly the half facing the
viewer), the core is the projected small circle 22° past it, darkest
where it turns furthest from a real ground-bounce vector, the reflected
light follows that same vector, and the cast shadow is the sphere swept
along the sun onto the floor under a declared 16° camera pitch. The
value plan is painted per pixel from real surface normals.

Scoring is placement-only, pure functions at the top of `js/game.js`:
every angle gets a grace band before a linear falloff, so 100 is honestly
reachable. Terminator weighs 0.4, core 0.25, contact 0.2, bounce 0.15; a
round is the mean of the two spheres. No rendering is judged — this is
geometry, not mood.

**The grace band is set for your hardware** via `ArtDaily.ease()`: 3° on
a pen, 6° on a mouse or trackpad, 4.5° on a finger, and the HUD says
which it eased for. The falloff ramps themselves are identical for every
device on purpose — this drill throws the drawn line away and scores only
the axis it implies, so knowing where the light is, not steadiness, is
what the ramps measure. The contact shadow is judged in pixels with a
floor under both its grace (≥11px, eased) and its ramp (≥60px), so a
330px phone sheet is not held to a stricter absolute standard than a
700px desktop one. Marks are grabbed within `ArtDaily.startRadius(26)` —
44px on a pen tablet, where the hand is out of sight — and a press up to
3× that away outside the sphere snaps to the nearest mark instead of
being refused.

Keys 1–4 pick a mark (1 = terminator axis), arrows nudge, enter is done.
Nothing costs you a sphere by accident: "done" asks once if you press it
before a terminator exists, and "new round" asks before it scraps a round
in progress.

Run it: `python3 -m http.server 8080` in this folder, open
`http://localhost:8080/`. Zero build, zero deps, no tracking.

Part of [Art Daily](https://artdaily.sadeali.com/) — tiny scored
warmups from [sadeali.com](https://sadeali.com/).
