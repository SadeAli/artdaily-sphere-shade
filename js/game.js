/* ============================================================
   game.js — Shade a Sphere. Two spheres per round, light given.
   The player DRAWS the terminator across the sphere with one
   stroke, then drags three marks — core shadow, bounce
   (reflected) light, occlusion shadow — into place, hits done,
   and the true shading anatomy is revealed in the accent next to
   a flat-value "plan" sphere. Placement is scored, not rendering.

   The light is a real 3D unit vector: an azimuth on the sheet
   plus a tilt out of it (toward the viewer, or behind the form),
   declared in the little plan view. Everything the reveal draws
   is derived from that vector against real surface normals — the
   terminator is the projection of the great circle P·L = 0, the
   core is the projected small circle 22° past it, the bounce
   comes from a real ground-bounce vector, and the cast shadow is
   the sphere swept along the sun onto the floor under a declared
   16° camera pitch. No stylized ellipses.

   Canvas angles are in degrees, 0 = +x (right), 90 = +y (DOWN,
   canvas space), so "up" is negative. The light azimuth is the
   direction from the sphere centre toward the sun; suns stay
   above the horizon, so it is always negative.
   ============================================================ */
(function () {
  'use strict';

  var SLUG = 'sphere-shade';
  var SPHERES_PER_ROUND = 2;
  var DEG = Math.PI / 180;

  /* ============================================================
     Pure scoring + geometry — inputs in, numbers out. No canvas,
     no DOM; every function here is unit-testable in isolation.
     ============================================================ */

  var CORE_BETA = 22;    /* the core band sits this far past the terminator */
  var GRACE_DEG = 3;     /* inside this, a mark is simply right (pen standard) */
  var GRACE_R = 0.08;    /* …and the same idea for the occlusion, in radii */
  var GRACE_PX = 11;     /* …with a pixel floor, so a small sheet is not stricter */
  var ZERO_PX = 60;      /* …and a floor under the occlusion ramp too */
  var OCC_BIAS = 0.22;   /* contact pool, pushed this far down-light */
  /* THE CORE'S DEAD BAND. The ground bounce is exactly anti-parallel to
     the light when the sun stands 45° over the floor — B(L)·L =
     −sin(alt + 45°) identically — so the only component that varies
     along the core circle, |cos(alt + 45°)|, is zero there: every point
     of the core catches the same bounce and "where is the core darkest"
     has no answer. Lights inside this band of 45° are not dealt (see
     newSphere), and trueCoreAngle falls back to the anti-light point
     rather than let a knife-edge optimum pick for it. */
  var CORE_DEAD_BAND = 6;
  var CORE_FLAT_EPS = 1e-3;

  /* the camera looks down by this much — the one declared angle that
     makes a horizontal floor read as a plane instead of a line, and
     lets a cast shadow be projected onto it for real. */
  var CAM_PITCH = 16 * DEG;
  var SIN_P = Math.sin(CAM_PITCH);
  var COS_P = Math.cos(CAM_PITCH);
  var UP = { x: 0, y: -COS_P, z: SIN_P };   /* world up, canvas y is down */
  var GZ = { x: 0, y: -SIN_P, z: -COS_P };  /* ground, away from the viewer */

  /* NaN-safe: degenerate inputs (0/0, NaN angles) fall to 0, never NaN */
  function clamp01(x) { return x >= 1 ? 1 : (x > 0 ? x : 0); }

  /* normalize to (-180, 180] */
  function norm180(a) {
    a = a % 360;
    if (a > 180) a -= 360;
    if (a <= -180) a += 360;
    return a;
  }

  /* shortest signed rotation from -> to, in (-180, 180] */
  function signedDeltaDeg(from, to) { return norm180(to - from); }

  /* absolute angular difference, [0, 180] */
  function angDiffDeg(a, b) { return Math.abs(signedDeltaDeg(a, b)); }

  /* difference between two AXES (no direction), [0, 90] */
  function axisDiffDeg(a, b) {
    var d = angDiffDeg(a, b);
    return d > 90 ? 180 - d : d;
  }

  /* signed axis difference, (-90, 90] — which way the axis is off */
  function signedAxisDeltaDeg(from, to) {
    var d = signedDeltaDeg(from, to);
    if (d > 90) d -= 180;
    if (d <= -90) d += 180;
    return d;
  }

  function dot3(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
  function cross3(a, b) {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  }
  function unit3(v) {
    var m = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
    return { x: v.x / m, y: v.y / m, z: v.z / m };
  }

  /* the light, for real: azimuth on the sheet, tilt out of it
     (+ = toward the viewer, − = behind the form). */
  function lightVec(azDeg, tiltDeg) {
    var a = azDeg * DEG, t = tiltDeg * DEG;
    return {
      x: Math.cos(t) * Math.cos(a),
      y: Math.cos(t) * Math.sin(a),
      z: Math.sin(t),
    };
  }
  function lightAzDeg(L) { return norm180(Math.atan2(L.y, L.x) / DEG); }

  /* Basis of the terminator plane: u lies in the picture plane and is
     the projected ellipse's major axis; v carries the tilt. Both ⟂ L,
     so P(t) = R(u·cos t + v·sin t) walks the terminator great circle,
     and v.z < 0 means the visible half is exactly t ∈ [−π, 0]. */
  function termBasis(L) {
    var m = Math.sqrt(L.x * L.x + L.y * L.y) || 1;
    var u = { x: L.y / m, y: -L.x / m, z: 0 };
    return { u: u, v: cross3(L, u) };
  }

  function circlePoint(basis, centre, rho, t) {
    var ct = Math.cos(t), st = Math.sin(t);
    return {
      x: centre.x + rho * (basis.u.x * ct + basis.v.x * st),
      y: centre.y + rho * (basis.u.y * ct + basis.v.y * st),
      z: centre.z + rho * (basis.u.z * ct + basis.v.z * st),
    };
  }

  /* The terminator is the great circle perpendicular to the light, so
     its projected axis is the light azimuth turned 90° — true for any
     tilt. The tilt only decides how fat the projected ellipse is
     (semi-minor R·|Lz|) and which way it bulges, which is why the
     scored quantity survives the rebuild untouched. */
  function trueTerminatorAxis(L) { return norm180(lightAzDeg(L) + 90); }

  /* The core-shadow small circle: every point CORE_BETA past the
     terminator on the shadow side, i.e. P·L = −sin β. Radius R·cos β,
     centre pushed −R·sin β along the light — so it projects as the
     terminator ellipse, scaled and offset toward the shadow. */
  function coreCircle(R, L) {
    var b = CORE_BETA * DEG, s = R * Math.sin(b);
    return {
      basis: termBasis(L),
      centre: { x: -s * L.x, y: -s * L.y, z: -s * L.z },
      rho: R * Math.cos(b),
    };
  }

  /* Ground bounce as a real light: it arrives from below and from the
     side away from the sun (the lit floor beyond the cast shadow), so
     it carries depth whenever the sun does. */
  function bounceVec(L) {
    var anti = { x: -L.x, y: -L.y, z: -L.z };
    var d = dot3(anti, UP);
    var h = unit3({ x: anti.x - d * UP.x, y: anti.y - d * UP.y, z: anti.z - d * UP.z });
    return unit3({ x: h.x - UP.x, y: h.y - UP.y, z: h.z - UP.z });
  }

  /* Reflected light reads brightest where the surface faces the bounce;
     on screen that is the direction the bounce vector projects to. */
  function trueReflectedAngle(L) {
    var B = bounceVec(L);
    return norm180(Math.atan2(B.y, B.x) / DEG);
  }

  /* The core reads darkest where the core circle turns furthest from
     the bounce and is still on the visible face — closed form, with the
     two rim crossings as the fallbacks when the optimum is round the
     back. Returns the screen angle of that point. */
  function trueCoreAngle(L) {
    var c = coreCircle(1, L);
    var B = bounceVec(L);
    var p = dot3(c.basis.u, B), q = dot3(c.basis.v, B);
    var m = Math.sqrt(p * p + q * q);
    /* Bounce anti-parallel to the light: the core is uniformly lit and
       the optimum below is a coin toss between two opposite arcs. The
       well-defined answer is the textbook one — straight opposite the
       light — instead of whichever end the arithmetic happened to land
       on. newSphere does not deal these lights; this is the brace. */
    if (m < CORE_FLAT_EPS) return norm180(lightAzDeg(L) + 180);
    var cand = [Math.atan2(-q / m, -p / m)];
    var s = -c.centre.z / (c.rho * c.basis.v.z);
    if (s >= -1 && s <= 1) {
      var t1 = Math.asin(s);
      cand.push(t1, Math.PI - t1);
    }
    var best = null, bestF = -Infinity, i, t, P, f;
    for (i = 0; i < cand.length; i++) {
      t = cand[i];
      P = circlePoint(c.basis, c.centre, c.rho, t);
      if (P.z < -1e-9) continue;
      f = -(p * Math.cos(t) + q * Math.sin(t));
      if (f > bestF) { bestF = f; best = P; }
    }
    if (!best) best = circlePoint(c.basis, c.centre, c.rho, cand[0]);
    return norm180(Math.atan2(best.y, best.x) / DEG);
  }

  /* sun altitude over the floor, degrees (not its tilt out of the sheet) */
  function sunAltitudeDeg(L) {
    var d = dot3(L, UP);
    if (d > 1) d = 1;
    if (d < -1) d = -1;
    return Math.asin(d) / DEG;
  }

  /* the direction a shadow runs, in ground coords (a = screen x,
     b = away from the viewer): anti-light, flattened onto the floor */
  function shadowDirGround(L) {
    var anti = { x: -L.x, y: -L.y, z: -L.z };
    var d = dot3(anti, UP);
    var f = { x: anti.x - d * UP.x, y: anti.y - d * UP.y, z: anti.z - d * UP.z };
    /* a sun at the exact zenith flattens to nothing — no run at all. The
       ellipse still needs an axis to be built around, so point it away from
       the viewer and the pool comes out round, which is what an overhead
       sun actually casts. */
    if (!(Math.sqrt(f.x * f.x + f.y * f.y + f.z * f.z) > 1e-9)) return { a: 0, b: 1 };
    var h = unit3(f);
    return { a: h.x, b: dot3(h, GZ) };
  }

  /* Occlusion shadow: the pool at the contact point, pushed down-light
     along the floor — which on a pitched camera means it slides UP the
     sheet when the sun is in front of the form, and toward the viewer
     when the sun is behind it. */
  function trueOcclusionCenter(cx, groundY, R, L) {
    var d = shadowDirGround(L);
    return {
      x: cx + OCC_BIAS * R * d.a,
      y: groundY - OCC_BIAS * R * d.b * SIN_P,
    };
  }

  /* The cast shadow of a sphere resting on the floor: sweep the
     silhouette down the sun and you get an ellipse, semi-major
     r/sin(alt) along the run, semi-minor r across it, centre a
     r/tan(alt) walk away from the light. */
  function castShadowEllipse(R, L) {
    var alt = Math.max(sunAltitudeDeg(L), 14) * DEG; /* grazing suns stay drawable */
    var d = shadowDirGround(L);
    var run = R / Math.tan(alt);
    return { a: run * d.a, b: run * d.b, major: R / Math.sin(alt), minor: R, dir: d };
  }

  /* The angle RAMPS are knowledge, not motor skill: this drill throws the
     drawn line away and scores only the axis it implies (fitStrokeAxis),
     and the three marks are angle drags that work at any distance from the
     sphere — so a mouse and a pen that mean the same thing already score
     the same, and widening the ramps would only hand out points for not
     knowing where the light is. What DOES depend on the hardware is the
     GRACE zone: the slop between "I meant that" and "I hit that". That is
     what ArtDaily.ease() opens per input mode — and the HUD says which
     mode it opened for. The occlusion works in pixels with a floor under
     both the grace and the ramp, so a 330px phone sheet is not judged to a
     stricter absolute standard than a 700px desktop one. */
  function scoreTerminator(axisDeg, L, grace) {
    var angErr = axisDiffDeg(axisDeg, trueTerminatorAxis(L));
    return 100 * clamp01(1 - Math.max(0, angErr - grace) / 75);
  }
  function scoreCore(angDeg, L, grace) {
    var bandAngErr = angDiffDeg(angDeg, trueCoreAngle(L));
    return 100 * clamp01(1 - Math.max(0, bandAngErr - grace) / 60);
  }
  function scoreReflected(angDeg, L, grace) {
    var arcAngErr = angDiffDeg(angDeg, trueReflectedAngle(L));
    return 100 * clamp01(1 - Math.max(0, arcAngErr - grace) / 70);
  }
  function scoreOcclusion(px, py, tx, ty, graceDist, zeroDist) {
    var dist = Math.hypot(px - tx, py - ty);
    if (!isFinite(dist)) return 0;
    return 100 * clamp01(1 - Math.max(0, dist - graceDist) / (zeroDist > 0 ? zeroDist : ZERO_PX));
  }

  /* The three tolerances a round is scored with, for the hardware in the
     player's hand right now. Pure: pass the sphere radius in, get pixels
     and degrees out. */
  function tolerances(R, ease) {
    /* NaN falls to 0 via `||`; a non-finite radius has to be caught too,
       because an infinite ramp makes scoreOcclusion hand out 100 for any
       distance at all — a wrong score rather than a harsh one. */
    var r = (R > 0 && isFinite(R)) ? R : 0;
    return {
      grace: ease(GRACE_DEG),
      occGrace: Math.max(ease(GRACE_R) * r, ease(GRACE_PX)),
      occZero: Math.max(0.9 * r, ZERO_PX),
    };
  }
  function itemScore(t, c, r, o) {
    return 0.4 * t + 0.25 * c + 0.15 * r + 0.2 * o;
  }
  function roundScore(items) {
    var sum = 0, i;
    for (i = 0; i < items.length; i++) sum += items[i];
    return items.length ? sum / items.length : 0;
  }

  /* THE ARROW ON THE COLD-OPEN CUE. The centre of the sphere used to say
     "…to the light ↗" with that glyph hard-coded, and the sun stands
     up-LEFT on half the lights dealt — including half of the easy ones a
     first-ever visit gets. The first instruction a beginner reads pointed
     the wrong way every other round. It is derived from the azimuth now:
     canvas degrees, 0 = right, 90 = down, so "up" is negative. A
     non-finite azimuth has no direction to name and gets none. */
  var GLYPHS = ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'];
  function lightGlyph(azDeg) {
    if (!isFinite(azDeg)) return '';
    var oct = Math.round(norm180(azDeg) / 45);
    return GLYPHS[((oct % 8) + 8) % 8];
  }

  /* THE FIRST REVEAL HAS TO TEACH, NOT JUST SCORE. The sphere's reveal
     line said "42/100 — ink is yours, lilac is the answer" and stopped
     there: the four part scores existed (they are printed on the sheet in
     8–11px type, next to glyphs nothing defines) but the one sentence a
     beginner actually reads — and the ONLY thing a screen-reader player
     ever gets — carried no lesson at all. Every sibling drill names the
     miss in words; this one did not.

     So the weakest of the four marks is named, in plain words, with the
     one thing about it that is always true. Those claims are checked, not
     guessed: the bounce truth is below the sphere's centre on the screen
     and within 31° of straight-away-from-the-sun on EVERY light this
     drill deals (measured over the dealt azimuth/tilt ranges), and the
     terminator is exactly 90° from the light at any tilt. The core's
     darkest point genuinely wanders — up to 144° off the anti-light
     direction on the steeper lights — so it gets no invented rule of
     thumb; it gets pointed at the dashed line and the named value plan,
     which is where the answer honestly lives. Pure: parts in, string out. */
  var MARK_NOTE = {
    t: 'your line — it runs at a right angle (90°) to the light arrow, whatever the tilt.',
    c: 'the c mark (darkest band) — follow its dashed line to the lilac answer, ' +
       'and see it named on the value plan.',
    b: 'the b mark (bounce light) — it sits low on the shadow side, where the floor ' +
       'throws light back up.',
    o: 'the o mark (contact shadow) — it hugs the ground under the ball, nudged a ' +
       'little away from the sun.',
  };
  function finite0(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function markNote(parts) {
    if (!parts) return '';
    var keys = ['t', 'c', 'b', 'o'], k = 't', i;
    for (i = 1; i < keys.length; i++) {
      if (finite0(parts[keys[i]]) < finite0(parts[k])) k = keys[i];
    }
    if (finite0(parts[k]) >= 75) return 'all four marks landed.';
    return 'weakest was ' + MARK_NOTE[k];
  }

  /* Least-squares principal axis of a drawn stroke, in degrees, plus
     how far the stroke actually runs along it — a tap is not a line. */
  function fitStrokeAxis(pts) {
    var n = pts.length, i, mx = 0, my = 0;
    if (n < 3) return null;
    for (i = 0; i < n; i++) { mx += pts[i].x; my += pts[i].y; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0, dx, dy;
    for (i = 0; i < n; i++) {
      dx = pts[i].x - mx; dy = pts[i].y - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    if (sxx + syy < 1e-6) return null;
    var axis = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    var ux = Math.cos(axis), uy = Math.sin(axis);
    var lo = Infinity, hi = -Infinity, proj;
    for (i = 0; i < n; i++) {
      proj = (pts[i].x - mx) * ux + (pts[i].y - my) * uy;
      if (proj < lo) lo = proj;
      if (proj > hi) hi = proj;
    }
    /* A non-finite sample poisons the fit, and `NaN < need` is false — so
       an unreadable stroke would be COMMITTED as the terminator and then
       draw nothing. Unreadable is unreadable: say so the same way a short
       stroke does. */
    if (!isFinite(axis) || !isFinite(hi - lo)) return null;
    return { axis: norm180(axis / DEG), span: hi - lo };
  }

  /* How much ground bounce a normal catches. The floor is a broad
     source rather than a point, so the bounce wraps — without that a
     front-lit form would show its reflected light only as a one-pixel
     sliver on the rim. The wrap is affine, so it never moves where the
     bounce is strongest, only how far it reaches. */
  var BOUNCE_WRAP = 0.9;
  function bounceLift(n, B) { return (dot3(n, B) + BOUNCE_WRAP) / (1 + BOUNCE_WRAP); }
  function maxBounceLift(B) {
    var peak = B.z > 0 ? 1 : Math.hypot(B.x, B.y); /* best a visible normal can do */
    return (peak + BOUNCE_WRAP) / (1 + BOUNCE_WRAP);
  }

  /* Which flat value a point of the plan sphere belongs to, from its
     real normal: 0 light · 1 halftone · 2 shadow · 3 core · 4 bounce. */
  var CORE_IN = Math.sin(14 * DEG);
  var CORE_OUT = Math.sin(32 * DEG);
  var HALF_IN = Math.sin(26 * DEG);
  function planBand(n, L, B, maxLift) {
    var d = dot3(n, L);
    if (d > HALF_IN) return 0;
    if (d > 0) return 1;
    var b = bounceLift(n, B) / (maxLift || 1);
    if (b > 0.86) return 4;
    if (d < -CORE_IN && d > -CORE_OUT && b < 0.7) return 3;
    return 2;
  }

  /* ============================================================
     Canvas / DOM below this line.
     ============================================================ */
  var canvas = document.getElementById('gameCanvas');
  var ctx = canvas.getContext('2d');
  var hint = document.getElementById('hint');
  var toast = document.getElementById('toast');
  var hudRound = document.getElementById('hudRound');
  var hudScore = document.getElementById('hudScore');
  var hudBest = document.getElementById('hudBest');
  var btnDone = document.getElementById('btnDone');
  var btnRound = document.getElementById('btnRound');

  ArtDaily.init({ slug: SLUG });

  var COARSE = (function () {
    try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
  })();

  /* A player with no recorded best is here for the first time: both
     spheres keep the easy near-picture-plane light, so the first round is
     winnable before the drill starts escalating. */
  var FIRST_VISIT = ArtDaily.best() === null;

  function ease(v) { return ArtDaily.ease(v); }

  /* Grab reach for the three marks. A screenless pen tablet has the
     hardest job of any device here — the hand is out of sight — so
     ArtDaily.startRadius gives it the widest zone, and a coarse pointer
     never drops below the 44px target the sheet's own CSS enforces. */
  function hitR() { return Math.max(ArtDaily.startRadius(26), COARSE ? 30 : 22); }

  /* Mark orbits. Bounce rides just outside the rim so that on a 330px
     phone it is not 10px from the core mark: 0.75R vs 1.08R keeps them a
     third of a radius apart at every size. */
  var CORE_ORBIT = 0.75, BOUNCE_ORBIT = 1.08;

  /* ---- theme-aware inks ----
     Every ink is a custom property on :root, and the ONLY thing that moves
     them is the data-theme attribute (see css/style.css) — so reading them
     once per theme is the same answer as reading them once per repaint,
     minus a forced style recalculation on every single pointermove. An
     empty read (stylesheet not parsed yet) is never cached, so a cold boot
     still corrects itself on the next frame. */
  var inkCache = null, inkTheme = '';
  function inks() {
    var t = ArtDaily.theme();
    if (inkCache && inkTheme === t) return inkCache;
    var cs = getComputedStyle(document.documentElement);
    var c = {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      accent: cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--lilac').trim(),
      card: cs.getPropertyValue('--card').trim(),
    };
    if (c.ink && c.card) { inkCache = c; inkTheme = t; }
    return c;
  }

  var monoFamily = '';
  function monoFont(px, weight) {
    if (!monoFamily) monoFamily = getComputedStyle(document.body).fontFamily;
    return (weight || 600) + ' ' + px + 'px ' + monoFamily;
  }

  /* raw lilac clears 3:1 on paper for strokes, but small text needs
     4.5:1 — so accent LABELS get inked toward graphite. */
  function accentInk(c) {
    if (ArtDaily.theme() === 'dark') return c.accent;
    var a = parseHex(c.accent), k = parseHex(c.ink);
    return 'rgb(' +
      Math.round(a[0] * 0.55 + k[0] * 0.45) + ',' +
      Math.round(a[1] * 0.55 + k[1] * 0.45) + ',' +
      Math.round(a[2] * 0.55 + k[2] * 0.45) + ')';
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ----
     Assigning canvas.width BLANKS the sheet and throws away the plan
     bitmap, so it is only ever assigned when something really moved. An
     address bar sliding up on a phone fires a stream of resizes at an
     unchanged width; those now cost nothing and, crucially, no longer
     flash the drawing away and re-render the plan sphere pixel by pixel. */
  var W = 0, H = 0, fitDpr = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    var w = Math.max(1, Math.round(rect.width));
    /* taller sheet on phones: the sphere, the plan view and the reveal
       all need room that a 0.62 ratio does not give at 340px. */
    var h = Math.round(w * (w < 520 ? 0.78 : 0.62));
    var dpr = window.devicePixelRatio || 1;
    if (w === W && h === H && dpr === fitDpr) return false;
    W = w; H = h; fitDpr = dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    planCache.key = null;
    return true;
  }

  /* ---- round state ---- */
  var round = 0, sphereIdx = 0, items = [], phase = 'idle';
  var S = null;      /* { L, az, tilt, cx, cy, R, groundY } */
  var marks = null;  /* { t, k, r, odx, ody, stroke, drawn } */
  var parts = null;  /* rounded part scores for the reveal ticks */
  var kbSel = 0, kbActive = false;
  var confirmNew = false, confirmTimer = null, confirmHint = '';
  var doneNag = false;  /* has done-with-nothing-drawn already been queried? */

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function relayout() {
    if (!S) return;
    /* A phone gets a BIGGER sphere, not just a smaller sheet: at 0.175·W
       the radius fell to 58px at 330px wide, which is what put the core
       and bounce marks 10px apart under one fingertip. */
    S.R = Math.max(40, Math.min(0.30 * H, (W < 520 ? 0.20 : 0.175) * W));
    S.groundY = Math.round(0.74 * H);
    S.cx = Math.round(0.30 * W);
    S.cy = S.groundY - S.R;
    /* the plan view rides the top-right corner, and shrinks rather than
       crowd the value-plan sphere that appears under it on reveal */
    S.mr = Math.max(14, Math.min(30, Math.round(0.055 * W)));
    var room = S.groundY - 1.6 * S.R - 22; /* top of the 'value plan' label */
    if (2 * S.mr + 37 > room) S.mr = Math.max(11, Math.floor((room - 37) / 2));
    S.my = S.mr + 22;
    S.mx = W - S.mr - 14;
  }

  function newSphere(idx) {
    var az, tilt, L, alt, tries = 0;
    /* first-ever visit: keep BOTH spheres on the easy light. Escalating
       before the first idea has landed is how a beginner decides the
       drill is not for them. */
    var easy = idx === 0 || (FIRST_VISIT && round <= 1);
    do {
      if (easy) {
        /* side light close to the picture plane: the classic almost
           straight terminator, low sun */
        az = Math.random() < 0.5 ? rand(-166, -146) : rand(-34, -14);
        tilt = (Math.random() < 0.5 ? -1 : 1) * rand(7, 18);
      } else {
        /* three-quarter or back light, high sun: the terminator bulges
           and the core swings off the centre line. Azimuths stay clear
           of dead vertical, where left and right flanks read equally
           dark and the core has no honest answer. */
        az = Math.random() < 0.5 ? rand(-132, -106) : rand(-74, -48);
        tilt = Math.random() < 0.5 ? -rand(26, 46) : rand(22, 36);
      }
      L = lightVec(az, tilt);
      alt = sunAltitudeDeg(L);
      tries += 1;
      /* …and never a sun sitting on 45°, where the ground bounce cancels
         along the light and the core has no darkest point to find (see
         CORE_DEAD_BAND). About one draw in ten is re-rolled for it. */
    } while (tries < 24 && (alt < 15 || alt > 74 || Math.abs(alt - 45) < CORE_DEAD_BAND));

    S = { L: L, az: az, tilt: tilt };
    relayout();
    var ax = -Math.cos(az * DEG);
    marks = {
      t: norm180(az),                       /* parked along the light = wrong */
      k: norm180(az + rand(-15, 15)),       /* parked on the lit pole */
      r: norm180((ax >= 0 ? 180 : 0) + rand(-15, 15)), /* lit-side horizon */
      odx: ax >= 0 ? -1.05 : 1.05,          /* parked on the lit side */
      ody: 0.26,
      stroke: null,
      drawn: false,
      moved: false,
    };
    parts = null;
    doneNag = false;
    planCache.key = null;
    phase = 'place';
  }

  function newRound() {
    clearConfirm();
    round += 1;
    sphereIdx = 0;
    items = [];
    newSphere(0);
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    btnDone.disabled = false;
    setDoneLabel('done', '✓');
    setPlaceHint();
    draw();
  }

  /* mid-round the new-round button throws away a scored sphere, so it
     asks first instead of silently binning it. */
  var CONFIRM_MSG = 'that scraps this round — press again to start over, or carry on.';
  function requestNewRound() {
    var midRound = (phase === 'place' || phase === 'reveal') &&
      (sphereIdx > 0 || items.length > 0 || (marks && (marks.drawn || marks.moved)));
    if (!midRound || confirmNew) { newRound(); return; }
    confirmNew = true;
    btnRound.textContent = 'discard round?';
    confirmHint = hint.textContent;
    hint.textContent = CONFIRM_MSG;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(clearConfirm, 4500);
  }

  function clearConfirm() {
    clearTimeout(confirmTimer);
    if (!confirmNew) return;
    confirmNew = false;
    /* The prompt leaves with the button it belonged to, whatever cleared
       it — the timer, a press on the sheet, a press on done. Only the
       timer used to do this, so grabbing a mark while the button was armed
       snapped the button back to "new round" and left the sheet warning
       about a discard that was no longer on offer, for the rest of the
       sphere. Restoring is conditional because anything that has written
       to the hint since owns the line: the reveal's score, a miss message,
       the short-line nudge. */
    if (hint.textContent === CONFIRM_MSG) {
      if (phase === 'place') setPlaceHint();
      else hint.textContent = confirmHint;
    }
    btnRound.textContent = '';
    btnRound.appendChild(document.createTextNode('new round '));
    var s = document.createElement('span');
    s.setAttribute('aria-hidden', 'true');
    s.textContent = '↻';
    btnRound.appendChild(s);
  }

  /* Plain words first, studio words second. The one fact that makes this
     drill winnable — the line runs square to the light — used to live in
     the fourth paragraph of a collapsed how-to while carrying 40% of the
     score. It says it on the first screen now, and the reveal is where
     "terminator" gets defined by a picture.

     ONE INSTRUCTION AT A TIME. The single hint used to carry the line, the
     lift-and-resume rule and all three marks in one 350-character
     paragraph — a wall of text on the cold-open screen, four fifths of it
     about a step the player has not reached. So the line is asked for
     alone, and the three marks are named the moment the line exists.
     Lift-and-resume is not dropped, only moved: commitStroke says it at
     the exact moment a short stroke is lifted, which is the only moment
     it means anything. */
  function setPlaceHint() {
    var head = 'sphere ' + (sphereIdx + 1) + ' of ' + SPHERES_PER_ROUND + ' — ';
    if (!marks || !marks.drawn) {
      /* "square to" is a studio idiom for "at a right angle to", and it
         was carrying 40% of the score on the first screen a beginner
         ever sees. Say the school word. */
      hint.textContent = head + 'draw the line across the sphere that runs at a ' +
        'right angle (90°) to the light arrow: that is where the light stops ' +
        '(its studio name is the terminator).';
      return;
    }
    hint.textContent = head + 'line set. now drag the three marks — ' +
      'c = darkest band · b = light bouncing back off the floor · ' +
      'o = where the ball touches the ground — then press done. (keys 1–4 + arrows)';
  }

  /* the glyph is decoration — screen readers should hear "next sphere",
     not "next sphere right-arrow" (same shape clearConfirm uses). */
  function setDoneLabel(txt, sym) {
    btnDone.textContent = '';
    btnDone.appendChild(document.createTextNode(txt + ' '));
    var s = document.createElement('span');
    s.setAttribute('aria-hidden', 'true');
    s.textContent = sym;
    btnDone.appendChild(s);
  }

  /* ---- geometry helpers (pixel space) ---- */
  function pt(cx, cy, radius, deg) {
    return { x: cx + radius * Math.cos(deg * DEG), y: cy + radius * Math.sin(deg * DEG) };
  }

  function handlePoints() {
    return [
      pt(S.cx, S.cy, CORE_ORBIT * S.R, marks.k),
      pt(S.cx, S.cy, BOUNCE_ORBIT * S.R, marks.r),
      { x: S.cx + marks.odx * S.R, y: S.groundY + marks.ody * S.R },
    ];
  }

  /* the light a drawn terminator axis implies: same tilt, azimuth
     square to the stroke, on the side the real sun is on. */
  function impliedLight(axisDeg) {
    var a1 = norm180(axisDeg + 90), a2 = norm180(axisDeg - 90);
    var az = angDiffDeg(a1, S.az) <= angDiffDeg(a2, S.az) ? a1 : a2;
    return lightVec(az, S.tilt);
  }

  /* walk the projected terminator: visible half is t ∈ [−π, 0] */
  function traceGreatCircle(cx, cy, R, L, from, to) {
    var b = termBasis(L), i, t, ct, st, x, y;
    for (i = 0; i <= 40; i++) {
      t = from + (to - from) * (i / 40);
      ct = Math.cos(t); st = Math.sin(t);
      x = cx + R * (b.u.x * ct + b.v.x * st);
      y = cy + R * (b.u.y * ct + b.v.y * st);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }

  function drawTerminator(cx, cy, R, L, color, lw, faintAlpha) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    /* the half that runs round the back, dashed and faint */
    ctx.globalAlpha = faintAlpha;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    traceGreatCircle(cx, cy, R, L, 0, Math.PI);
    ctx.stroke();
    /* the half you can actually see */
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    ctx.lineWidth = lw;
    ctx.beginPath();
    traceGreatCircle(cx, cy, R, L, -Math.PI, 0);
    ctx.stroke();
    ctx.restore();
  }

  /* the visible stretch of the core small circle, thick where it reads
     darkest and thin where the ground bounce starts lifting it */
  function drawCoreCircle(cx, cy, R, L, color, alpha) {
    var c = coreCircle(R, L);
    var darkest = trueCoreAngle(L);
    var i, t, P, prev = false, x, y;
    var thick = Math.max(7, 0.15 * R);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    for (i = 0; i <= 120; i++) {
      t = -Math.PI + (2 * Math.PI) * (i / 120);
      P = circlePoint(c.basis, c.centre, c.rho, t);
      if (P.z < 0) { prev = false; continue; }
      x = cx + P.x; y = cy + P.y;
      var near = angDiffDeg(norm180(Math.atan2(P.y, P.x) / DEG), darkest) < 46;
      if (!prev) { ctx.beginPath(); ctx.moveTo(x, y); }
      else {
        ctx.lineTo(x, y);
        ctx.lineWidth = near ? thick : 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
      }
      prev = true;
    }
    ctx.restore();
  }

  function arcBand(cx, cy, radius, centerDeg, halfSpanDeg, lw, style, alpha, dash) {
    ctx.save();
    ctx.strokeStyle = style;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, (centerDeg - halfSpanDeg) * DEG, (centerDeg + halfSpanDeg) * DEG);
    ctx.stroke();
    ctx.restore();
  }

  function drawOcclusionEllipse(x, y, R, style, alpha, fill, lw) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.ellipse(x, y, 0.5 * R, 0.14 * R, 0, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = style; ctx.fill(); }
    else { ctx.strokeStyle = style; ctx.lineWidth = lw || 2; ctx.stroke(); }
    ctx.restore();
  }

  /* ---- flat value scale, theme-aware: on paper we shade with
     ink, in the night studio we lift with chalk — either way
     level 0 = lit, level 1 = darkest, and values still read ---- */
  function parseHex(s) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s || '');
    if (!m) return [128, 128, 128];
    var h = m[1];
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function valueRgb(c, level) {
    var a = parseHex(c.card), b = parseHex(c.ink);
    var w = ArtDaily.theme() === 'dark' ? 0.88 - 0.78 * level : 0.04 + 0.8 * level;
    return [
      Math.round(a[0] + (b[0] - a[0]) * w),
      Math.round(a[1] + (b[1] - a[1]) * w),
      Math.round(a[2] + (b[2] - a[2]) * w),
    ];
  }
  function valueColor(c, level) {
    var v = valueRgb(c, level);
    return 'rgb(' + v[0] + ',' + v[1] + ',' + v[2] + ')';
  }

  /* ---- the reveal's flat-value plan sphere: every pixel is a real
     surface normal tested against the real light and the real ground
     bounce, then posterised. The bands are geometry, not styling. ---- */
  var PLAN_LEVELS = [0.05, 0.3, 0.58, 0.82, 0.34];
  var planCache = { key: null, img: null, box: 0 };

  function renderPlan(R, L, c) {
    var dpr = window.devicePixelRatio || 1;
    var box = Math.ceil(2 * R + 2);
    var dev = Math.max(2, Math.round(box * dpr));
    var off = document.createElement('canvas');
    off.width = dev; off.height = dev;
    var octx = off.getContext('2d');
    var img = octx.createImageData(dev, dev);
    var data = img.data;
    var B = bounceVec(L);
    var maxLift = maxBounceLift(B);
    var cols = [], i;
    for (i = 0; i < PLAN_LEVELS.length; i++) cols.push(valueRgb(c, PLAN_LEVELS[i]));
    var aa = 1.5 / (R * dpr);
    var n = { x: 0, y: 0, z: 0 };
    for (var py = 0; py < dev; py++) {
      var ny = (((py + 0.5) / dpr) - box / 2) / R;
      for (var px = 0; px < dev; px++) {
        var nx = (((px + 0.5) / dpr) - box / 2) / R;
        var d2 = nx * nx + ny * ny;
        var alpha = (1 - Math.sqrt(d2)) / aa + 0.5;
        if (alpha <= 0) continue;
        if (alpha > 1) alpha = 1;
        n.x = nx; n.y = ny; n.z = Math.sqrt(d2 >= 1 ? 0 : 1 - d2);
        var col = cols[planBand(n, L, B, maxLift)];
        var o = (py * dev + px) * 4;
        data[o] = col[0];
        data[o + 1] = col[1];
        data[o + 2] = col[2];
        data[o + 3] = Math.round(alpha * 255);
      }
    }
    octx.putImageData(img, 0, 0);
    return { img: off, box: box };
  }

  function ensurePlan(R, c) {
    var key = [round, sphereIdx, W, ArtDaily.theme(), window.devicePixelRatio || 1].join(':');
    if (planCache.key === key) return planCache;
    planCache.key = key;
    var p = renderPlan(R, S.L, c);
    planCache.img = p.img;
    planCache.box = p.box;
    return planCache;
  }

  /* a ground-plane ellipse walked onto the sheet: depth foreshortens by
     sin(pitch), which is what tips it into a real screen ellipse */
  function traceGroundEllipse(ox, oy, e, grow) {
    var pa = -e.dir.b, pb = e.dir.a, k, t, ca, sa, ga, gb;
    for (k = 0; k <= 48; k++) {
      t = k / 48 * Math.PI * 2;
      ca = Math.cos(t) * e.major * grow;
      sa = Math.sin(t) * e.minor * grow;
      ga = e.a + ca * e.dir.a + sa * pa;
      gb = e.b + ca * e.dir.b + sa * pb;
      if (k === 0) ctx.moveTo(ox + ga, oy - gb * SIN_P);
      else ctx.lineTo(ox + ga, oy - gb * SIN_P);
    }
    ctx.closePath();
  }

  function drawValuePlan(c) {
    var r2 = 0.8 * S.R;
    var cx2 = Math.round(0.72 * W);
    var cy2 = S.groundY - r2;
    var L = S.L;
    var occ = trueOcclusionCenter(cx2, S.groundY, r2, L);

    ctx.save();
    /* the plan is an inset illustration: a long shadow runs out of its
       panel instead of smearing over the sphere you were marking. */
    ctx.beginPath();
    ctx.rect(Math.round(0.5 * W), cy2 - r2 - 16, W - Math.round(0.5 * W), S.groundY - cy2 + r2 + 16 + 1.1 * r2);
    ctx.clip();

    /* cast shadow, swept along the real sun onto the floor */
    ctx.fillStyle = valueColor(c, 0.45);
    ctx.beginPath();
    traceGroundEllipse(cx2, S.groundY, castShadowEllipse(r2, L), 1);
    ctx.fill();
    drawOcclusionEllipse(occ.x, occ.y, r2, valueColor(c, 0.85), 1, true);

    var plan = ensurePlan(r2, c);
    ctx.drawImage(plan.img, cx2 - plan.box / 2, cy2 - plan.box / 2, plan.box, plan.box);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx2, cy2, r2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = c.ink; /* not muted: 10px text needs full contrast on paper */
    ctx.font = monoFont(10, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('value plan', cx2, cy2 - r2 - 8);
    ctx.restore();

    /* name the bands the drill trains but never spelled out — including
       the terminator itself, which was the one word the title concept
       depended on and the only one the sheet never showed */
    var cp = pt(cx2, cy2, 0.86 * r2, trueCoreAngle(L));
    var bp = pt(cx2, cy2, 0.95 * r2, trueReflectedAngle(L));
    var tp = pt(cx2, cy2, r2, trueTerminatorAxis(L));
    planLabel(c, cx2, cy2, tp, 'terminator');
    planLabel(c, cx2, cy2, cp, 'core');
    planLabel(c, cx2, cy2, bp, 'bounce');
  }

  /* a short leader from a band out to its name, clamped onto the sheet */
  function planLabel(c, cx2, cy2, p, txt) {
    var dx = p.x - cx2, dy = p.y - cy2;
    var m = Math.hypot(dx, dy) || 1;
    var lx = p.x + (dx / m) * 16, ly = p.y + (dy / m) * 16;
    ctx.save();
    ctx.font = monoFont(10, 700);
    ctx.textBaseline = 'middle';
    var w = ctx.measureText(txt).width;
    var right = dx >= 0;
    lx = Math.max(6 + (right ? 0 : w), Math.min(W - 6 - (right ? w : 0), lx));
    ly = Math.max(10, Math.min(H - 6, ly));
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.fillStyle = c.ink;
    ctx.textAlign = right ? 'left' : 'right';
    ctx.fillText(txt, lx + (right ? 3 : -3), ly);
    ctx.restore();
  }

  /* ---- the sun, and the plan view that declares its depth ---- */
  function drawSun(c) {
    var L = S.L;
    var sun = pt(S.cx, S.cy, S.R + 46, S.az);
    sun.x = Math.min(W - 14, Math.max(14, sun.x));
    sun.y = Math.min(S.groundY - 18, Math.max(14, sun.y));
    /* never park the sun on the plan view */
    if (sun.y < S.my + S.mr + 16) sun.x = Math.min(sun.x, S.mx - S.mr - 22);
    ctx.save();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    if (L.z < 0) ctx.setLineDash([4, 3]); /* the sun is behind the form */
    ctx.beginPath();
    ctx.arc(sun.x, sun.y, 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    var i, a, p1, p2;
    for (i = 0; i < 8; i++) {
      a = i * 45 * DEG;
      ctx.beginPath();
      ctx.moveTo(sun.x + 12 * Math.cos(a), sun.y + 12 * Math.sin(a));
      ctx.lineTo(sun.x + 17 * Math.cos(a), sun.y + 17 * Math.sin(a));
      ctx.stroke();
    }
    /* short arrow along the true light direction, toward the sphere */
    p1 = pt(S.cx, S.cy, S.R + 32, S.az);
    p2 = pt(S.cx, S.cy, S.R + 12, S.az);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
    var back = Math.atan2(p1.y - p2.y, p1.x - p2.x);
    ctx.beginPath();
    ctx.moveTo(p2.x, p2.y);
    ctx.lineTo(p2.x + 7 * Math.cos(back + 0.5), p2.y + 7 * Math.sin(back + 0.5));
    ctx.moveTo(p2.x, p2.y);
    ctx.lineTo(p2.x + 7 * Math.cos(back - 0.5), p2.y + 7 * Math.sin(back - 0.5));
    ctx.stroke();
    ctx.fillStyle = c.ink; /* not muted: 10px text needs full contrast on paper */
    ctx.font = monoFont(10, 600);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('light', sun.x, Math.min(S.groundY - 4, sun.y + 30));
    ctx.restore();
  }

  /* The plan view: the same sphere seen from above, with the light's
     horizontal direction as an arrow and you at the bottom. It is the
     only place the light's depth can be shown honestly — and the
     terminator's bulge and the core's offset both hang off it. */
  function drawPlanView(c) {
    var L = S.L, mr = S.mr, px = S.mx, py = S.my;
    var hx = L.x, hz = L.z;
    var m = Math.hypot(hx, hz) || 1;
    hx /= m; hz /= m;
    ctx.save();
    ctx.font = monoFont(10, 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = c.ink;
    ctx.fillText('plan · ' + Math.round(Math.abs(S.tilt)) + '°', px, py - mr - 8);
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, mr, 0, Math.PI * 2);
    ctx.stroke();
    /* the light, arriving */
    var sx = px + hx * (mr + 17), sy = py + hz * (mr + 17);
    var ex = px + hx * (mr + 4), ey = py + hz * (mr + 4);
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    var back = Math.atan2(sy - ey, sx - ex);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex + 6 * Math.cos(back + 0.5), ey + 6 * Math.sin(back + 0.5));
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex + 6 * Math.cos(back - 0.5), ey + 6 * Math.sin(back - 0.5));
    ctx.stroke();
    /* you, watching from the bottom */
    var vy = py + mr + 12;
    ctx.fillStyle = c.ink;
    ctx.beginPath();
    ctx.moveTo(px, vy - 6);
    ctx.lineTo(px + 5, vy + 3);
    ctx.lineTo(px - 5, vy + 3);
    ctx.closePath();
    ctx.fill();
    ctx.font = monoFont(10, 600);
    ctx.textAlign = 'right';
    ctx.fillText('you', px - 8, vy + 3);
    ctx.restore();
  }

  function tickGlyph(v) { return v >= 75 ? '✓' : (v >= 45 ? '~' : '✗'); }
  function turnGlyph(d) { return d >= 0 ? '↻' : '↺'; }

  function drawTicks(c) {
    /* "term" was an abbreviation of a word the drill spends the whole
       reveal teaching, and on its own it reads as the English "term".
       The player drew a LINE; the value plan next to it is where the
       studio name gets attached to the picture. */
    var row1 = 'line ' + parts.t + ' ' + tickGlyph(parts.t) + ' ' +
      Math.abs(Math.round(parts.dt)) + '°' + turnGlyph(parts.dt) +
      '  ·  core ' + parts.c + ' ' + tickGlyph(parts.c) + ' ' +
      Math.abs(Math.round(parts.dc)) + '°' + turnGlyph(parts.dc);
    /* "0.42R" was algebra: R is the sphere's radius, a letter this sheet
       never prints anywhere, on the first reveal a beginner ever reads. */
    var row2 = 'bounce ' + parts.b + ' ' + tickGlyph(parts.b) + ' ' +
      Math.abs(Math.round(parts.db)) + '°' + turnGlyph(parts.db) +
      '  ·  contact ' + parts.o + ' ' + tickGlyph(parts.o) + ' ' +
      parts.do_.toFixed(2) + ' × radius';
    /* …and the third row is the legend, so it defines the OTHER undefined
       glyph on these two lines too: ↻ / ↺ is which way to turn the mark. */
    var row3 = 'ink = you · lilac = answer · ↻↺ = which way to turn';
    ctx.save();
    /* The legend was never measured, only rows 1 and 2 were — so the row
       that exists to explain the other two was the one free to run off the
       card it is printed on (and, on a 330px phone, off the sheet). It is
       sized with them now, and it can no longer come out LARGER than the
       rows it captions: the old loop left `size` one step below the size it
       had measured, then floored the legend at 9px, so an 8px row 1 sat
       under a 9px row 3. */
    var size = 11, w = 0, legend = 9;
    while (true) {
      /* one step smaller than the rows, but never bigger than them — the
         old max(9, …) alone still printed a 9px legend under 8px rows */
      legend = Math.min(size, Math.max(9, size - 1));
      ctx.font = monoFont(size, 700);
      w = Math.max(ctx.measureText(row1).width, ctx.measureText(row2).width);
      ctx.font = monoFont(legend, 600);
      w = Math.max(w, ctx.measureText(row3).width) + 16;
      if (w <= W - 12 || size <= 8) break;
      size -= 1;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    var top = Math.min(S.groundY + 14, H - 58);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = c.card;
    ctx.fillRect(0.5 * W - w / 2, top, w, 54);
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.ink;
    ctx.font = monoFont(size, 700);
    ctx.fillText(row1, 0.5 * W, top + 15);
    ctx.fillText(row2, 0.5 * W, top + 31);
    ctx.font = monoFont(legend, 600);
    ctx.fillText(row3, 0.5 * W, top + 47);
    ctx.restore();
  }

  /* ---- repaint scheduling ----
     A pen or a trackpad delivers positions far faster than the screen can
     show them. Repainting synchronously inside every pointermove burned
     three or four complete redraws — sun, plan view, sphere, terminator,
     handles — inside one displayed frame, and only the last of them was
     ever seen. draw() now just ASKS for the next frame; the browser runs
     paint() once, immediately before it composites, which is also the
     freshest possible moment to read the pointer's position from. */
  var rafId = 0;
  function draw() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () { rafId = 0; paint(); });
  }
  /* for the paths that must not show a blank frame — a resize has already
     cleared the sheet, so it repaints on the spot */
  function paintNow() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    paint();
  }

  /* ---- painting (canvas bg stays clear so the CSS dot-grid shows) ---- */
  function paint() {
    var c = inks();
    ctx.clearRect(0, 0, W, H);
    if (!S || !marks) return;
    var cx = S.cx, cy = S.cy, R = S.R;

    /* ground line */
    ctx.save();
    ctx.strokeStyle = c.muted;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(8, S.groundY);
    ctx.lineTo(W - 8, S.groundY);
    ctx.stroke();
    ctx.restore();

    drawSun(c);
    drawPlanView(c);

    /* sphere outline */
    ctx.save();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    /* the player's marks, drawn live */
    drawOcclusionEllipse(cx + marks.odx * R, S.groundY + marks.ody * R, R, c.ink, 0.45, true);
    if (marks.stroke && marks.stroke.length > 1) {
      ctx.save();
      ctx.strokeStyle = c.ink;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(marks.stroke[0].x, marks.stroke[0].y);
      for (var si = 1; si < marks.stroke.length; si++) ctx.lineTo(marks.stroke[si].x, marks.stroke[si].y);
      ctx.stroke();
      ctx.restore();
    }
    drawTerminator(cx, cy, R, impliedLight(marks.t), c.ink, marks.drawn ? 2.5 : 1.5, marks.drawn ? 0.3 : 0.18);
    if (!marks.drawn) {
      /* The cold-open cue. It was 35 characters centred on a sphere whose
         centre is 0.30·W, so on a 340px phone its left end hung off the
         sheet — the first instruction of the drill, clipped. Shorter, kept
         on the sheet by its own measured width, haloed in the card colour
         so it stays readable where it crosses the parked terminator, and
         the arrow now points at the sun that was actually dealt. */
      ctx.save();
      ctx.font = monoFont(10, 600);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      var cue = 'draw at 90° to the light ' + lightGlyph(S.az);
      var half = ctx.measureText(cue).width / 2;
      var cueX = Math.max(Math.min(half + 4, 0.5 * W),
        Math.min(cx, Math.max(W - half - 4, 0.5 * W)));
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = c.card;
      ctx.strokeText(cue, cueX, cy);
      ctx.fillStyle = c.ink;
      ctx.fillText(cue, cueX, cy);
      ctx.restore();
    }
    arcBand(cx, cy, CORE_ORBIT * R, marks.k, 22, Math.max(8, 0.14 * R), c.ink, 0.4, null);
    arcBand(cx, cy, 0.92 * R, marks.r, 24, 2.5, c.ink, 0.9, [5, 4]);

    /* the answer, in the accent */
    if (phase === 'reveal' || phase === 'done') {
      var L = S.L;
      var occ = trueOcclusionCenter(cx, S.groundY, R, L);
      drawTerminator(cx, cy, R, L, c.accent, 3, 0.35);
      drawCoreCircle(cx, cy, R, L, c.accent, 0.9);
      arcBand(cx, cy, 0.92 * R, trueReflectedAngle(L), 24, 2.5, c.accent, 1, [5, 4]);
      drawOcclusionEllipse(occ.x, occ.y, R, c.accent, 1, false, 2.5);
      drawDeltas(c, occ);
      drawValuePlan(c);
    }

    /* handles on top */
    var hp = handlePoints();
    var letters = ['c', 'b', 'o'];
    /* the knob is drawn at roughly half its own grab reach, so the target
       a mode gets is the target it can see */
    var hr = Math.max(13, Math.min(18, Math.round(0.45 * hitR())));
    var i;
    ctx.save();
    ctx.font = monoFont(11, 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.arc(hp[i].x, hp[i].y, hr, 0, Math.PI * 2);
      ctx.fillStyle = c.card;
      ctx.fill();
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (kbActive && kbSel === i + 1 && phase === 'place') {
        ctx.save();
        ctx.strokeStyle = c.accent;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(hp[i].x, hp[i].y, hr + 5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = c.ink;
      ctx.fillText(letters[i], hp[i].x, hp[i].y + 0.5);
    }
    if (kbActive && kbSel === 0 && phase === 'place') {
      ctx.strokeStyle = c.accent;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();

    if ((phase === 'reveal' || phase === 'done') && parts) drawTicks(c);
  }

  /* every mark gets a line to where it should have gone — the delta,
     not just the colour difference */
  function drawDeltas(c, occ) {
    var cx = S.cx, cy = S.cy, R = S.R, L = S.L;
    var hp = handlePoints();
    var truth = [
      pt(cx, cy, CORE_ORBIT * R, trueCoreAngle(L)),
      pt(cx, cy, BOUNCE_ORBIT * R, trueReflectedAngle(L)),
      occ,
    ];
    ctx.save();
    ctx.strokeStyle = accentInk(c); /* thin lines need 4.5:1, not 3:1 */
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 3]);
    for (var i = 0; i < 3; i++) {
      if (Math.hypot(hp[i].x - truth[i].x, hp[i].y - truth[i].y) < 6) continue;
      ctx.beginPath();
      ctx.moveTo(hp[i].x, hp[i].y);
      ctx.lineTo(truth[i].x, truth[i].y);
      ctx.stroke();
    }
    /* the terminator misses by an angle, so it gets an arc at the rim */
    var a0 = marks.t, a1 = trueTerminatorAxis(L);
    var d = signedAxisDeltaDeg(a0, a1);
    if (Math.abs(d) > 1) {
      ctx.setLineDash([]);
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(cx, cy, R + 9, a0 * DEG, (a0 + d) * DEG, d < 0);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---- input ---- */
  /* One rect per EVENT, not one per sample: a 240Hz pen hands over a dozen
     coalesced positions in a single dispatch, and measuring the canvas box
     a dozen times to convert them is a dozen forced layouts for one answer
     that cannot have changed in between. */
  function pointerPos(ev, rect) {
    var r = rect || canvas.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  /* Every position the hardware actually recorded, not just the one the
     browser chose to dispatch. Between two pointermove events a fast flick
     may have travelled 200px through three real samples; without these the
     stroke is the chord across them, and its fitted length — the thing
     that decides whether the line counts — comes up short on exactly the
     confident, quick strokes this drill is trying to encourage.
     ArtDaily.samples is that pattern once, guarded; this drill used to
     hand-roll it, and an engine that throws out of getCoalescedEvents took
     the whole pointermove handler down with it. */

  var dragging = -1, dragId = null, grabOff = null, drawingStroke = false;
  var dragType = '';           /* pointerType that owns the sheet */
  var lastPenAt = 0;           /* palm rejection: when a pen was last seen */
  var liftAt = 0, liftPt = null; /* where and when the last stroke segment ended */
  var RESUME_MS = 2500;

  /* Palm rejection. pointerId guarding alone only rejects the SECOND
     contact — on a tablet the palm usually lands FIRST — so a pen press
     takes the sheet off a touch that is mid-stroke, and a touch press is
     ignored for a moment after any pen. */
  function palmBlocked(ev) {
    return ev.pointerType === 'touch' && lastPenAt && (Date.now() - lastPenAt) < 1200;
  }
  function penPreempts(ev) {
    return ev.pointerType === 'pen' && dragId !== null && dragType === 'touch';
  }
  function releasePointer() {
    if (dragId !== null) { try { canvas.releasePointerCapture(dragId); } catch (e) {} }
    dragging = -1;
    dragId = null;
    dragType = '';
    grabOff = null;
    drawingStroke = false;
  }

  function applyDrag(idx, p) {
    var deg = Math.atan2(p.y - S.cy, p.x - S.cx) / DEG;
    marks.moved = true;
    if (idx === 0) marks.k = norm180(deg + grabOff);
    else if (idx === 1) marks.r = norm180(deg + grabOff);
    else {
      marks.odx = Math.max(-1.9, Math.min(1.9, (p.x - S.cx) / S.R + grabOff.x));
      marks.ody = Math.max(-0.12, Math.min(0.55, (p.y - S.groundY) / S.R + grabOff.y));
    }
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (phase !== 'place') {
      /* never a dead tap: say what the sheet is waiting for */
      if (phase === 'reveal') hint.textContent = 'compare your ink with the lilac answer, then press “next sphere”.';
      else if (phase === 'done') hint.textContent = 'round done — press “new round” to go again.';
      return;
    }
    if (ev.pointerType === 'pen') lastPenAt = Date.now();
    if (palmBlocked(ev)) return;
    /* one pointer owns the sheet: a second finger (or a palm) must not
       restart the stroke you are halfway through — unless it is the pen,
       which is the hand that meant it. */
    if (dragId !== null) {
      if (!penPreempts(ev)) return;
      if (drawingStroke && marks.stroke) marks.stroke = null; /* palm ink, not yours */
      releasePointer();
    }
    ev.preventDefault();
    /* preventDefault suppresses click-to-focus, and the keys the hint
       advertises (1–4 + arrows) are the precision path for every hand
       that cannot creep — restore focus explicitly. */
    try { canvas.focus({ preventScroll: true }); } catch (e) { canvas.focus(); }
    clearConfirm();
    var p = pointerPos(ev);
    var hp = handlePoints();
    var reach = hitR();
    var bestIdx = -1, bestD = Infinity, i, d;
    for (i = 0; i < 3; i++) {
      /* every mark keeps its full reach from the very first frame. The old
         15px pre-stroke reach for c and b was a trap: a beginner reaching
         for a mark missed, fell through to the stroke branch, and drew an
         accidental terminator instead. */
      d = Math.hypot(p.x - hp[i].x, p.y - hp[i].y);
      if (d < reach && d < bestD) { bestD = d; bestIdx = i; }
    }
    /* outside the sphere there is nothing else a press can mean, so snap:
       take the nearest mark within 3× its reach rather than refusing. A
       screenless tablet cannot see its own hand — a refusal there reads as
       "this site is broken". */
    if (bestIdx < 0 && Math.hypot(p.x - S.cx, p.y - S.cy) > S.R * 1.15) {
      for (i = 0; i < 3; i++) {
        d = Math.hypot(p.x - hp[i].x, p.y - hp[i].y);
        if (d < 3 * reach && d < bestD) { bestD = d; bestIdx = i; }
      }
    }
    if (bestIdx >= 0) {
      /* pick it up where you touched it — no teleport on a near miss */
      dragging = bestIdx;
      dragId = ev.pointerId;
      dragType = ev.pointerType;
      kbSel = bestIdx + 1;
      var deg = Math.atan2(p.y - S.cy, p.x - S.cx) / DEG;
      if (bestIdx === 0) grabOff = signedDeltaDeg(deg, marks.k);
      else if (bestIdx === 1) grabOff = signedDeltaDeg(deg, marks.r);
      else {
        grabOff = {
          x: marks.odx - (p.x - S.cx) / S.R,
          y: marks.ody - (p.y - S.groundY) / S.R,
        };
      }
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
      draw();
      return;
    }
    /* The start zone is R·1.15, and a press up to R·1.8 SNAPS onto it
       rather than being refused: the first sample is pulled to the edge of
       the zone and the rest of the stroke is yours. */
    var fromC = Math.hypot(p.x - S.cx, p.y - S.cy);
    if (fromC <= S.R * 1.8) {
      if (fromC > S.R * 1.15 && fromC > 0) {
        p = {
          x: S.cx + (p.x - S.cx) * (S.R * 1.15) / fromC,
          y: S.cy + (p.y - S.cy) * (S.R * 1.15) / fromC,
        };
      }
      drawingStroke = true;
      dragId = ev.pointerId;
      dragType = ev.pointerType;
      /* A trackpad runs out of pad long before the sphere runs out of
         width, so a lift does NOT end the line: press again near where you
         stopped, soon after, and the same line carries on. The axis is
         fitted to every segment together. */
      var carry = marks.stroke && marks.stroke.length && liftPt &&
        (Date.now() - liftAt) < RESUME_MS &&
        Math.hypot(p.x - liftPt.x, p.y - liftPt.y) <= ArtDaily.startRadius(46);
      if (!carry) marks.stroke = [];
      marks.stroke.push(p);
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
      draw();
      return;
    }
    hint.textContent = 'draw your line across the sphere, or drag one of the c · b · o marks.';
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (phase !== 'place' || ev.pointerId !== dragId) return;
    if (dragging < 0 && !drawingStroke) return;
    ev.preventDefault();
    var rect = canvas.getBoundingClientRect();
    if (drawingStroke) {
      var evs = ArtDaily.samples(ev), i, p, last;
      for (i = 0; i < evs.length; i++) {
        p = pointerPos(evs[i], rect);
        last = marks.stroke[marks.stroke.length - 1];
        if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 2) marks.stroke.push(p);
      }
    } else {
      /* a drag only ever wants where the hand IS — the samples in between
         are positions it has already left */
      applyDrag(dragging, pointerPos(ev, rect));
    }
    draw();
  });

  function endDrag(ev) {
    if (dragId === null) return;
    if (ev && ev.pointerId !== dragId) return;
    /* "done" can score the sphere while a finger is still drawing (a
       second finger, or Enter), so the phase may already be 'reveal' by
       the time the pointer lifts. Committing then would overwrite the
       scored terminator and replace the reveal's score line with the
       placing hint — the in-flight stroke is dropped instead. */
    if (phase !== 'place') {
      drawingStroke = false;
      dragging = -1;
      dragId = null;
      dragType = '';
      grabOff = null;
      return;
    }
    if (drawingStroke) {
      var s = marks.stroke;
      /* THE TAIL OF A FAST STROKE. pointerup carries a position of its own,
         and it is the only record of where the hand actually stopped — the
         last pointermove can be most of a frame behind it. Dropping it cost
         the stroke its final travel, which is precisely the travel a quick
         confident flick has the most of, and `span` is what decides whether
         the line is accepted at all. It also anchors lift-and-resume: the
         press that carries on is measured against where you really lifted. */
      if (s && ev && ev.type === 'pointerup' && typeof ev.clientX === 'number') {
        var end = pointerPos(ev);
        var tail = s.length ? s[s.length - 1] : null;
        if (!tail || Math.hypot(end.x - tail.x, end.y - tail.y) >= 0.5) s.push(end);
      }
      if (s && s.length) { liftPt = s[s.length - 1]; liftAt = Date.now(); }
      drawingStroke = false;
      dragging = -1;
      dragId = null;
      dragType = '';
      grabOff = null;
      commitStroke();
      return;
    }
    dragging = -1;
    dragId = null;
    dragType = '';
    grabOff = null;
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  /* A pointerup lost outside the canvas used to lock the sheet for good,
     because pointerdown returns early while one is in flight. */
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  /* The line, fitted: the principal axis of every segment drawn so far
     becomes the terminator. A short attempt is an UNFINISHED line, not a
     bad one — the ink is kept and the sheet says exactly what happened,
     instead of binning the stroke and blaming the hand that made it. */
  function commitStroke() {
    /* nothing is fitted once the sphere is scored — endDrag already
       drops an in-flight stroke, and this is the belt to that brace */
    if (phase !== 'place') return;
    var pts = [], i, s = marks.stroke || [];
    for (i = 0; i < s.length; i++) {
      if (Math.hypot(s[i].x - S.cx, s[i].y - S.cy) <= S.R * 1.25) pts.push(s[i]);
    }
    var fit = fitStrokeAxis(pts);
    var need = Math.max(26, 0.45 * S.R);
    if (!fit || fit.span < need) {
      hint.textContent = 'you lifted — that line is still short. press near where you stopped ' +
        'and carry on; the two halves count as one line.';
      draw();
      return;
    }
    marks.t = fit.axis;
    marks.drawn = true;
    setPlaceHint();
    draw();
  }

  /* keyboard: 1–4 picks a mark, arrows nudge it, enter = done */
  canvas.addEventListener('keydown', function (ev) {
    var k = ev.key;
    if (k === 'Enter') {
      ev.preventDefault();
      if (phase === 'done') newRound(); else doneAction();
      return;
    }
    if (phase !== 'place') return;
    if (k === '1' || k === '2' || k === '3' || k === '4') {
      kbSel = Number(k) - 1;
      kbActive = true;
      ev.preventDefault();
      draw();
      return;
    }
    var dx = k === 'ArrowLeft' ? -1 : (k === 'ArrowRight' ? 1 : 0);
    var dy = k === 'ArrowUp' ? -1 : (k === 'ArrowDown' ? 1 : 0);
    if (!dx && !dy) return;
    ev.preventDefault();
    kbActive = true;
    clearConfirm();
    marks.moved = true;
    if (kbSel === 3) {
      marks.odx = Math.max(-1.9, Math.min(1.9, marks.odx + dx * 0.04));
      marks.ody = Math.max(-0.12, Math.min(0.55, marks.ody + dy * 0.04));
    } else {
      var step = (dx + dy) * 2; /* right/down = clockwise in canvas space */
      if (kbSel === 0) {
        marks.t = norm180(marks.t + step);
        /* nudging the line by keyboard IS drawing it, so the hint has to
           move on to the marks exactly as it does after a stroke */
        if (!marks.drawn) { marks.drawn = true; setPlaceHint(); }
        marks.stroke = null;
      } else if (kbSel === 1) marks.k = norm180(marks.k + step);
      else marks.r = norm180(marks.r + step);
    }
    draw();
  });

  /* ---- done / next / finish ---- */
  function doneAction() {
    /* Pressing done is an answer to "discard round?" too — it means no.
       Without this the arm-timer was still running: it fired 4.5s later,
       saw phase 'reveal' and pasted the placing hint it had saved back
       over the sphere's score line, so the one screen that explains the
       reveal vanished mid-read. (newRound already clears it; this path
       did not.) */
    clearConfirm();
    if (phase === 'place') {
      /* Done before a single stroke would score the parked marks, and the
         terminator alone is 40% of the sphere. Ask once — the same way
         "new round" asks — then take the player at their word. */
      if (!marks.drawn && !doneNag) {
        doneNag = true;
        hint.textContent = 'nothing drawn yet — a line across the sphere, at a right angle (90°) to the light, sets the terminator. press done again to score it as it stands.';
        return;
      }
      var L = S.L;
      var tol = tolerances(S.R, ease);
      var t = scoreTerminator(marks.t, L, tol.grace);
      var cc = scoreCore(marks.k, L, tol.grace);
      var b = scoreReflected(marks.r, L, tol.grace);
      var occ = trueOcclusionCenter(S.cx, S.groundY, S.R, L);
      var ox = S.cx + marks.odx * S.R, oy = S.groundY + marks.ody * S.R;
      var o = scoreOcclusion(ox, oy, occ.x, occ.y, tol.occGrace, tol.occZero);
      var item = itemScore(t, cc, b, o);
      items.push(item);
      parts = {
        t: Math.round(t), c: Math.round(cc), b: Math.round(b), o: Math.round(o),
        dt: signedAxisDeltaDeg(marks.t, trueTerminatorAxis(L)),
        dc: signedDeltaDeg(marks.k, trueCoreAngle(L)),
        db: signedDeltaDeg(marks.r, trueReflectedAngle(L)),
        do_: Math.hypot(ox - occ.x, oy - occ.y) / S.R,
      };
      phase = 'reveal';
      if (sphereIdx < SPHERES_PER_ROUND - 1) {
        setDoneLabel('next sphere', '→');
        hint.textContent = 'sphere ' + (sphereIdx + 1) + ': ' + Math.round(item) +
          '/100 — ink is yours, lilac is the answer. ' + markNote(parts) + ' ' +
          (FIRST_VISIT && round <= 1
            ? 'the next light is the same easy kind.'
            : 'the next light is trickier.');
      } else {
        finishRound();
      }
      draw();
      return;
    }
    if (phase === 'reveal' && sphereIdx < SPHERES_PER_ROUND - 1) {
      sphereIdx += 1;
      newSphere(sphereIdx);
      setDoneLabel('done', '✓');
      setPlaceHint();
      draw();
    }
  }

  function finishRound() {
    phase = 'done';
    var res = ArtDaily.report(roundScore(items));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — ink is yours, lilac is the answer. ' +
      markNote(parts) + ' press “new round” to go again.';
    setDoneLabel('finished', '✓');
    btnDone.disabled = true;
    /* A first-ever round has no previous best, so isNewBest is
       trivially true and "new best!" celebrates nothing — on the one
       round where the number most needs saying what it IS. The SDK
       marks that round with isFirst; an older vendored SDK simply
       leaves it undefined and the old wording stands. */
    showToast(res.isFirst
      ? 'first score ' + res.score + ' / 100 — your mark to beat'
      : (res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
  }

  var toastTimer = null;
  function showToast(msg, celebrate) {
    toast.innerHTML = '';
    var s = document.createElement('span');
    s.className = celebrate ? 'toast-accent' : '';
    s.textContent = msg;
    toast.appendChild(s);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.hidden = true; }, 2200);
  }

  /* ---- chrome wiring ---- */
  btnDone.addEventListener('click', doneAction);
  btnRound.addEventListener('click', requestNewRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(function () { inkCache = null; planCache.key = null; paintNow(); });
  /* the hardware can change mid-session (a laptop user plugs in a tablet):
     the marks are drawn at the size of the reach that mode gets. */
  ArtDaily.onInput(function () { draw(); });

  /* A phone fires `resize` on every pixel of address-bar slide, and each
     one used to reallocate the canvas backing store, re-lay-out the sphere
     and rescale the stroke. The width is what the sheet is built from, so
     a resize that did not change it has no work in it at all — and the
     ones that do change it are folded into a single frame. */
  var resizeRaf = 0;
  function onResize() {
    resizeRaf = 0;
    var oldR = S ? S.R : 0, oldCx = S ? S.cx : 0, oldCy = S ? S.cy : 0;
    if (!fitCanvas()) return;   /* nothing moved, and nothing was cleared */
    relayout();
    /* a drawn stroke is in pixels — carry it onto the new sheet */
    if (oldR) {
      var moveP = function (p) {
        return {
          x: S.cx + (p.x - oldCx) * S.R / oldR,
          y: S.cy + (p.y - oldCy) * S.R / oldR,
        };
      };
      if (marks && marks.stroke) {
        for (var i = 0; i < marks.stroke.length; i++) marks.stroke[i] = moveP(marks.stroke[i]);
      }
      /* …and so is WHERE YOU LIFTED. liftPt held a reference to the very
         point object the loop above replaces, so after a rotation it
         still pointed at the old sheet's pixels — and lift-and-resume
         measures the next press against it. Inside the 2.5s resume
         window a phone turned mid-line either refused to carry the line
         on (the press was nowhere near the stale point) or carried one
         it should not have. It travels with the ink it came from. */
      if (liftPt) liftPt = moveP(liftPt);
    }
    paintNow();   /* fitCanvas already blanked the sheet — no empty frame */
  }
  window.addEventListener('resize', function () {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(onResize);
  });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
