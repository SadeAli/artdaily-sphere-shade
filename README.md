# Shade a Sphere 🌑

A daily drill for the anatomy of light on form. Two spheres per round,
each with a given sun: **draw** the terminator across the sphere in one
stroke — the drill fits the principal axis of your line, so it trains the
hand, not just the eye — then drag the core-shadow band, the bounce
(reflected) light and the occlusion shadow to where they belong. Hit
done and the true anatomy is revealed in lilac, with a dashed line from
each of your marks to where it belonged, next to a flat-value plan
sphere with its bands named. Sphere 1 is side-lit, sphere 2 goes
three-quarter or back.

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
every angle gets a 3° grace band (and the occlusion 0.08R) before a
linear falloff, so 100 is honestly reachable. Terminator weighs 0.4,
core 0.25, occlusion 0.2, bounce 0.15; a round is the mean of the two
spheres. No rendering is judged — this is geometry, not mood.

Keys 1–4 pick a mark (1 = terminator axis), arrows nudge, enter is done.
Nothing costs you a sphere by accident: "done" asks once if you press it
before a terminator exists, and "new round" asks before it scraps a round
in progress.

Run it: `python3 -m http.server 8080` in this folder, open
`http://localhost:8080/`. Zero build, zero deps, no tracking.

Part of [Art Daily](https://artdaily.sadeali.com/) — tiny scored
warmups from [sadeali.com](https://sadeali.com/).
