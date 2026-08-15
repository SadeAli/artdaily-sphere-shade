/* ============================================================
   game.js — Shade a Sphere. Two spheres per round, light given.
   The player drags four marks — terminator, core shadow, bounce
   (reflected) light, occlusion shadow — into place, hits done,
   and the true shading anatomy is revealed in the accent next to
   a flat-value "plan" sphere. Placement is scored, not rendering.

   Canvas angles are in degrees, 0 = +x (right), 90 = +y (DOWN,
   canvas space), so "up" is negative. The light azimuth L is the
   direction from sphere centre toward the sun; suns stay above
   the horizon, so L is always negative.
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

  /* terminator = great circle perpendicular to the light */
  function trueTerminatorAxis(light) { return norm180(light + 90); }

  /* Core shadow centre: just past the terminator on the shadow
     side, on the UPPER shadow stretch — ground bounce can't reach
     it there, so that's where the core reads darkest. 22° past
     the upper terminator endpoint, toward the shadow pole. */
  function trueCoreAngle(light) {
    var e1 = norm180(light + 90);
    var e2 = norm180(light - 90);
    var upper = Math.sin(e1 * DEG) < 0 ? e1 : e2; /* canvas y is down */
    var dir = signedDeltaDeg(upper, norm180(light + 180)) >= 0 ? 1 : -1;
    return norm180(upper + dir * 22);
  }

  /* Reflected (bounce) light: lower shadow-side rim — halfway
     between straight down (the ground it bounces off) and the
     point opposite the light; above the contact point. */
  function trueReflectedAngle(light) {
    var shadowAz = norm180(light + 180);
    return norm180(90 + 0.5 * signedDeltaDeg(90, shadowAz));
  }

  /* Occlusion shadow: hugging the contact point, biased away
     from the light (more bias the more side-on the light is). */
  function trueOcclusionCenter(cx, groundY, R, light) {
    var ax = -Math.cos(light * DEG); /* horizontal unit away from light */
    return { x: cx + 0.18 * R * ax, y: groundY + 0.08 * R };
  }

  function scoreTerminator(axisDeg, light) {
    var angErr = axisDiffDeg(axisDeg, trueTerminatorAxis(light));
    return 100 * clamp01(1 - angErr / 75);
  }
  function scoreCore(angDeg, light) {
    var bandAngErr = angDiffDeg(angDeg, trueCoreAngle(light));
    return 100 * clamp01(1 - bandAngErr / 60);
  }
  function scoreReflected(angDeg, light) {
    var arcAngErr = angDiffDeg(angDeg, trueReflectedAngle(light));
    return 100 * clamp01(1 - arcAngErr / 70);
  }
  function scoreOcclusion(px, py, tx, ty, R) {
    var dist = Math.hypot(px - tx, py - ty);
    return 100 * clamp01(1 - dist / (0.9 * R));
  }
  function itemScore(t, c, r, o) {
    return 0.4 * t + 0.25 * c + 0.15 * r + 0.2 * o;
  }
  function roundScore(items) {
    var sum = 0, i;
    for (i = 0; i < items.length; i++) sum += items[i];
    return items.length ? sum / items.length : 0;
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

  ArtDaily.init({ slug: SLUG });

  /* ---- theme-aware inks (re-read on every repaint) ---- */
  function inks() {
    var cs = getComputedStyle(document.documentElement);
    return {
      ink: cs.getPropertyValue('--ink').trim(),
      muted: cs.getPropertyValue('--muted').trim(),
      accent: cs.getPropertyValue('--game-accent').trim() || cs.getPropertyValue('--lilac').trim(),
      card: cs.getPropertyValue('--card').trim(),
    };
  }

  var monoFamily = '';
  function monoFont(px, weight) {
    if (!monoFamily) monoFamily = getComputedStyle(document.body).fontFamily;
    return (weight || 600) + ' ' + px + 'px ' + monoFamily;
  }

  /* ---- crisp canvas at any devicePixelRatio; height tracks width ---- */
  var W = 0, H = 0;
  function fitCanvas() {
    var rect = canvas.getBoundingClientRect();
    W = Math.max(1, Math.round(rect.width));
    H = Math.round(W * 0.62);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---- round state ---- */
  var round = 0, sphereIdx = 0, items = [], phase = 'idle';
  var S = null;      /* { light, cx, cy, R, groundY } */
  var marks = null;  /* { t, k, r, odx, ody } — occlusion stored relative to the sphere so resizes survive */
  var parts = null;  /* rounded part scores for the reveal ticks */
  var kbSel = 0, kbActive = false;

  function rand(lo, hi) { return lo + Math.random() * (hi - lo); }

  function relayout() {
    if (!S) return;
    S.R = Math.max(34, Math.min(0.32 * H, 0.155 * W));
    S.groundY = Math.round(0.74 * H);
    S.cx = Math.round(0.30 * W);
    S.cy = S.groundY - S.R;
  }

  function newSphere(idx) {
    var L;
    if (idx === 0) {
      /* side-lit, low sun */
      L = Math.random() < 0.5 ? rand(-168, -148) : rand(-32, -12);
    } else {
      /* three-quarter / back-lit, high sun (never dead vertical) */
      L = Math.random() < 0.5 ? rand(-128, -102) : rand(-78, -52);
    }
    S = { light: L };
    relayout();
    var ax = -Math.cos(L * DEG);
    marks = {
      t: norm180(L + rand(-12, 12)),        /* aligned with the light = wrong */
      k: norm180(L + rand(-15, 15)),        /* parked on the lit pole */
      r: norm180((ax >= 0 ? 180 : 0) + rand(-15, 15)), /* parked on the lit-side horizon */
      odx: ax >= 0 ? -1.05 : 1.05,          /* parked on the lit side */
      ody: 0.26,
    };
    parts = null;
    phase = 'place';
  }

  function newRound() {
    round += 1;
    sphereIdx = 0;
    items = [];
    newSphere(0);
    hudRound.textContent = String(round);
    hudScore.textContent = '–';
    btnDone.disabled = false;
    setDoneLabel('done ✓');
    hint.textContent = 'sphere 1 of 2 — side light. drag t·c·b·o into place, then hit done.';
    draw();
  }

  function setDoneLabel(txt) { btnDone.textContent = txt; }

  /* ---- geometry helpers (pixel space) ---- */
  function pt(cx, cy, radius, deg) {
    return { x: cx + radius * Math.cos(deg * DEG), y: cy + radius * Math.sin(deg * DEG) };
  }

  function handlePoints() {
    var o = { x: S.cx + marks.odx * S.R, y: S.groundY + marks.ody * S.R };
    return [
      pt(S.cx, S.cy, S.R, marks.t),
      pt(S.cx, S.cy, 0.75 * S.R, marks.k),
      pt(S.cx, S.cy, 0.92 * S.R, marks.r),
      o,
    ];
  }

  /* which param-half of the terminator ellipse bulges toward the shadow */
  function shadowHalfFirst(axisDeg, light) {
    return angDiffDeg(axisDeg + 90, light + 180) < 90;
  }

  /* faint full ellipse + solid shadow-side half */
  function drawTerminator(cx, cy, R, axisDeg, light, color, lw, faintAlpha) {
    var rot = axisDeg * DEG, ry = 0.3 * R;
    var first = shadowHalfFirst(axisDeg, light);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = faintAlpha;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, ry, rot, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = lw;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, ry, rot, first ? 0 : Math.PI, first ? Math.PI : Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /* closed path: the shadow lune between the terminator half and
     the shadow-side rim (used as fill + clip on the plan sphere) */
  function lunePath(cx, cy, R, axisDeg, light) {
    var rot = axisDeg * DEG, ry = 0.3 * R;
    var first = shadowHalfFirst(axisDeg, light);
    var a = first ? rot + Math.PI : rot;  /* rim angle where the ellipse half ends */
    var b = first ? rot : rot + Math.PI;  /* rim angle where it started */
    ctx.beginPath();
    ctx.ellipse(cx, cy, R, ry, rot, first ? 0 : Math.PI, first ? Math.PI : Math.PI * 2);
    /* rim arc back from a to b, traversed through the shadow side */
    var sweepCW = ((b - a) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    var midCW = (a + sweepCW / 2) / DEG;
    var ccw = angDiffDeg(midCW, light + 180) > 90;
    ctx.arc(cx, cy, R, a, b, ccw);
    ctx.closePath();
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
  function valueColor(c, level) {
    var a = parseHex(c.card), b = parseHex(c.ink);
    var w = ArtDaily.theme() === 'dark' ? 0.88 - 0.78 * level : 0.04 + 0.8 * level;
    var r = Math.round(a[0] + (b[0] - a[0]) * w);
    var g = Math.round(a[1] + (b[1] - a[1]) * w);
    var bl = Math.round(a[2] + (b[2] - a[2]) * w);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  /* ---- the reveal's little flat-value plan sphere ---- */
  function drawValuePlan(c) {
    var r2 = 0.8 * S.R;
    var cx2 = Math.round(0.72 * W);
    var cy2 = S.groundY - r2;
    var L = S.light;
    var ax = -Math.cos(L * DEG);
    var axis = trueTerminatorAxis(L);
    var occ = trueOcclusionCenter(cx2, S.groundY, r2, L);

    /* cast shadow stretching away from the light, then occlusion */
    var castRx = r2 * (0.5 + 0.6 * Math.abs(Math.cos(L * DEG)));
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx2 + ax * castRx * 0.8, S.groundY + 0.1 * r2, castRx, 0.2 * r2, 0, 0, Math.PI * 2);
    ctx.fillStyle = valueColor(c, 0.45);
    ctx.fill();
    ctx.restore();
    drawOcclusionEllipse(occ.x, occ.y, r2, valueColor(c, 0.85), 1, true);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx2, cy2, r2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = valueColor(c, 0.05);
    ctx.fillRect(cx2 - r2, cy2 - r2, 2 * r2, 2 * r2);
    /* halftone band hugging the terminator curve only (the stroke
       straddles it; the lune fill below reclaims the shadow half) */
    var first = shadowHalfFirst(axis, L);
    ctx.strokeStyle = valueColor(c, 0.3);
    ctx.lineWidth = 0.34 * r2;
    ctx.beginPath();
    ctx.ellipse(cx2, cy2, r2, 0.3 * r2, axis * DEG, first ? 0 : Math.PI, first ? Math.PI : Math.PI * 2);
    ctx.stroke();
    /* shadow lune */
    lunePath(cx2, cy2, r2, axis, L);
    ctx.fillStyle = valueColor(c, 0.55);
    ctx.fill();
    /* core + bounce live inside the lune only */
    ctx.save();
    lunePath(cx2, cy2, r2, axis, L);
    ctx.clip();
    arcBand(cx2, cy2, 0.72 * r2, trueCoreAngle(L), 42, 0.22 * r2, valueColor(c, 0.8), 1, null);
    arcBand(cx2, cy2, 0.9 * r2, trueReflectedAngle(L), 28, 0.14 * r2, valueColor(c, 0.32), 1, null);
    ctx.restore();
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
  }

  function drawSun(c) {
    var L = S.light;
    var sun = pt(S.cx, S.cy, S.R + 46, L);
    sun.x = Math.min(W - 14, Math.max(14, sun.x));
    sun.y = Math.min(S.groundY - 18, Math.max(14, sun.y));
    ctx.save();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sun.x, sun.y, 9, 0, Math.PI * 2);
    ctx.stroke();
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
    p1 = pt(S.cx, S.cy, S.R + 32, L);
    p2 = pt(S.cx, S.cy, S.R + 12, L);
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

  function tickGlyph(v) { return v >= 75 ? '✓' : (v >= 45 ? '~' : '✗'); }

  function drawTicks(c) {
    var row1 = 'term ' + parts.t + ' ' + tickGlyph(parts.t) + '  ·  core ' + parts.c + ' ' + tickGlyph(parts.c);
    var row2 = 'bounce ' + parts.b + ' ' + tickGlyph(parts.b) + '  ·  occl ' + parts.o + ' ' + tickGlyph(parts.o);
    ctx.save();
    ctx.font = monoFont(11, 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    /* card plate so the ticks stay legible over marks and shadows */
    var w = Math.max(ctx.measureText(row1).width, ctx.measureText(row2).width) + 16;
    ctx.globalAlpha = 0.88;
    ctx.fillStyle = c.card;
    ctx.fillRect(0.5 * W - w / 2, S.groundY + 16, w, 38);
    ctx.globalAlpha = 1;
    ctx.fillStyle = c.ink;
    ctx.fillText(row1, 0.5 * W, S.groundY + 30);
    ctx.fillText(row2, 0.5 * W, S.groundY + 46);
    ctx.restore();
  }

  /* ---- painting (canvas bg stays clear so the CSS dot-grid shows) ---- */
  function draw() {
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

    /* sphere outline */
    ctx.save();
    ctx.strokeStyle = c.ink;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    /* the player's marks, drawn live while dragging */
    drawOcclusionEllipse(cx + marks.odx * R, S.groundY + marks.ody * R, R, c.ink, 0.45, true);
    drawTerminator(cx, cy, R, marks.t, S.light, c.ink, 2.5, 0.3);
    arcBand(cx, cy, 0.75 * R, marks.k, 38, Math.max(8, 0.16 * R), c.ink, 0.4, null);
    arcBand(cx, cy, 0.92 * R, marks.r, 24, 2.5, c.ink, 0.9, [5, 4]);

    /* the answer, in the accent */
    if (phase === 'reveal') {
      var occ = trueOcclusionCenter(cx, S.groundY, R, S.light);
      drawTerminator(cx, cy, R, trueTerminatorAxis(S.light), S.light, c.accent, 3, 0.35);
      arcBand(cx, cy, 0.75 * R, trueCoreAngle(S.light), 38, Math.max(8, 0.16 * R), c.accent, 0.4, null);
      arcBand(cx, cy, 0.92 * R, trueReflectedAngle(S.light), 24, 2.5, c.accent, 1, [5, 4]);
      drawOcclusionEllipse(occ.x, occ.y, R, c.accent, 1, false, 2.5);
      drawValuePlan(c);
    }

    /* handles on top */
    var hp = handlePoints();
    var letters = ['t', 'c', 'b', 'o'];
    var i;
    ctx.save();
    ctx.font = monoFont(10, 700);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.arc(hp[i].x, hp[i].y, 10, 0, Math.PI * 2);
      ctx.fillStyle = c.card;
      ctx.fill();
      ctx.strokeStyle = c.ink;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (kbActive && i === kbSel && phase === 'place') {
        ctx.save();
        ctx.strokeStyle = c.accent;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(hp[i].x, hp[i].y, 15, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.fillStyle = c.ink;
      ctx.fillText(letters[i], hp[i].x, hp[i].y + 0.5);
    }
    ctx.restore();

    if (phase === 'reveal' && parts) drawTicks(c);
  }

  /* ---- input ---- */
  function pointerPos(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  var dragging = -1;

  function applyDrag(idx, p) {
    var deg = Math.atan2(p.y - S.cy, p.x - S.cx) / DEG;
    if (idx === 0) marks.t = norm180(deg);
    else if (idx === 1) marks.k = norm180(deg);
    else if (idx === 2) marks.r = norm180(deg);
    else {
      marks.odx = Math.max(-1.9, Math.min(1.9, (p.x - S.cx) / S.R));
      marks.ody = Math.max(-0.12, Math.min(0.55, (p.y - S.groundY) / S.R));
    }
  }

  canvas.addEventListener('pointerdown', function (ev) {
    if (phase !== 'place') return;
    ev.preventDefault();
    var p = pointerPos(ev);
    var hp = handlePoints();
    var bestIdx = -1, bestD = 28, i, d; /* 28px reach = a 56px touch target */
    for (i = 0; i < 4; i++) {
      d = Math.hypot(p.x - hp[i].x, p.y - hp[i].y);
      if (d < bestD) { bestD = d; bestIdx = i; }
    }
    if (bestIdx < 0) return;
    dragging = bestIdx;
    kbSel = bestIdx;
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    applyDrag(dragging, p);
    draw();
  });

  canvas.addEventListener('pointermove', function (ev) {
    if (dragging < 0 || phase !== 'place') return;
    ev.preventDefault();
    applyDrag(dragging, pointerPos(ev));
    draw();
  });

  function endDrag() { dragging = -1; }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  /* keyboard: 1–4 picks a mark, arrows nudge it, enter = done */
  canvas.addEventListener('keydown', function (ev) {
    var k = ev.key;
    if (k === 'Enter') { ev.preventDefault(); doneAction(); return; }
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
    if (kbSel === 3) {
      marks.odx = Math.max(-1.9, Math.min(1.9, marks.odx + dx * 0.04));
      marks.ody = Math.max(-0.12, Math.min(0.55, marks.ody + dy * 0.04));
    } else {
      var step = (dx + dy) * 2; /* right/down = clockwise in canvas space */
      if (kbSel === 0) marks.t = norm180(marks.t + step);
      else if (kbSel === 1) marks.k = norm180(marks.k + step);
      else marks.r = norm180(marks.r + step);
    }
    draw();
  });

  /* ---- done / next / finish ---- */
  function doneAction() {
    if (phase === 'place') {
      var t = scoreTerminator(marks.t, S.light);
      var cc = scoreCore(marks.k, S.light);
      var b = scoreReflected(marks.r, S.light);
      var occ = trueOcclusionCenter(S.cx, S.groundY, S.R, S.light);
      var o = scoreOcclusion(S.cx + marks.odx * S.R, S.groundY + marks.ody * S.R, occ.x, occ.y, S.R);
      var item = itemScore(t, cc, b, o);
      items.push(item);
      parts = { t: Math.round(t), c: Math.round(cc), b: Math.round(b), o: Math.round(o) };
      phase = 'reveal';
      if (sphereIdx < SPHERES_PER_ROUND - 1) {
        setDoneLabel('next sphere →');
        hint.textContent = 'sphere 1: ' + Math.round(item) + '/100 — lilac is the answer. next light is trickier.';
      } else {
        finishRound();
      }
      draw();
      return;
    }
    if (phase === 'reveal' && sphereIdx < SPHERES_PER_ROUND - 1) {
      sphereIdx += 1;
      newSphere(sphereIdx);
      setDoneLabel('done ✓');
      hint.textContent = 'sphere 2 of 2 — higher light now. terminator first, then hang the rest off it.';
      draw();
    }
  }

  function finishRound() {
    var res = ArtDaily.report(roundScore(items));
    hudScore.textContent = String(res.score);
    hudBest.textContent = res.best === null ? '–' : String(res.best);
    hint.textContent = 'round done — lilac is the answer. press "new round" to go again.';
    setDoneLabel('done ✓');
    btnDone.disabled = true;
    showToast((res.isNewBest ? 'new best! ' : 'score ') + res.score + ' / 100', res.isNewBest);
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
  document.getElementById('btnRound').addEventListener('click', newRound);

  var btnHow = document.getElementById('btnHow');
  var howTo = document.getElementById('howTo');
  btnHow.addEventListener('click', function () {
    howTo.hidden = !howTo.hidden;
    btnHow.setAttribute('aria-expanded', String(!howTo.hidden));
  });

  ArtDaily.onTheme(draw);
  window.addEventListener('resize', function () { fitCanvas(); relayout(); draw(); });

  /* ---- boot ---- */
  fitCanvas();
  var best = ArtDaily.best();
  hudBest.textContent = best === null ? '–' : String(best);
  newRound();
})();
