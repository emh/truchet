(() => {
  "use strict";

  const PAPER = "#f3ece0";
  const INK = "#17130f";
  const SELECT = "#1668ff";        // bright blue selection highlight

  const DEFAULT_THICKNESS = 2.6;
  const DEFAULT_FILL_DENSITY = 20; // px between hatch lines
  const FILL_LINE_WIDTH = 1.4;

  const FILL_PATTERNS = ["horiz", "vert", "diagf", "diagb", "radial"];
  const PATTERN_ANGLE = { horiz: 0, vert: Math.PI / 2, diagf: -Math.PI / 4, diagb: Math.PI / 4 };

  const config = {
    margin: 22,         // gap between screen edge and the frame
    frameWidth: 3.2,    // stroke weight of the frame border
    dragThreshold: 10,  // min drag distance (px) before a line is drawn
    hit: 14,            // px tolerance for tapping a line to select it
    handleHit: 20       // px tolerance for grabbing an endpoint control point
  };

  const app = document.getElementById("app");
  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d", { alpha: false });
  const lineToolbar = document.getElementById("toolbar");
  const fillToolbar = document.getElementById("fillToolbar");

  const view = { cssW: 1, cssH: 1, dpr: 1, frame: { x: 0, y: 0, w: 1, h: 1 } };

  // Lines span the full frame edge-to-edge; both endpoints live on the frame
  // perimeter in frame-relative coords (0..1). Fills are anchored to a seed
  // point (also frame-relative); the region they fill is recomputed from the
  // current lines each frame, so fills follow as lines move/appear/vanish.
  const state = {
    lines: [],          // [{ id, a:{nx,ny}, b:{nx,ny}, thickness }]
    fills: [],          // [{ id, seed:{nx,ny}, pattern, density, radial:{nx,ny} }]
    selection: null,    // null | { type:"line"|"fill", id }
    nextLineId: 1,
    nextFillId: 1,
    gesture: null
  };

  const lastLine = { thickness: DEFAULT_THICKNESS };
  // Remembered fill settings for new fills. pattern stays null (= pick a random
  // pattern per fill) until the user manually changes a fill's pattern.
  const lastFill = { pattern: null, density: DEFAULT_FILL_DENSITY };

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function pointerPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function lineById(id) { return state.lines.find(l => l.id === id) || null; }
  function fillById(id) { return state.fills.find(f => f.id === id) || null; }
  function selectedLine() { return state.selection && state.selection.type === "line" ? lineById(state.selection.id) : null; }
  function selectedFill() { return state.selection && state.selection.type === "fill" ? fillById(state.selection.id) : null; }

  // --- layout -------------------------------------------------------------

  function updateFrame() {
    const m = config.margin;
    view.frame = {
      x: m,
      y: m,
      w: Math.max(1, view.cssW - m * 2),
      h: Math.max(1, view.cssH - m * 2)
    };
  }

  function resize() {
    const rect = app.getBoundingClientRect();
    view.cssW = Math.max(1, Math.floor(rect.width));
    view.cssH = Math.max(1, Math.floor(rect.height));
    view.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));

    canvas.width = Math.floor(view.cssW * view.dpr);
    canvas.height = Math.floor(view.cssH * view.dpr);

    updateFrame();
    render();
  }

  // --- frame coordinate helpers -------------------------------------------

  function toNorm(p) {
    const f = view.frame;
    return { nx: (p.x - f.x) / f.w, ny: (p.y - f.y) / f.h };
  }

  function toScreen(n) {
    const f = view.frame;
    return { x: f.x + n.nx * f.w, y: f.y + n.ny * f.h };
  }

  function endpoints(line) {
    return { a: toScreen(line.a), b: toScreen(line.b) };
  }

  function nearestFramePoint(p) {
    const f = view.frame;
    const xmin = f.x, xmax = f.x + f.w, ymin = f.y, ymax = f.y + f.h;
    const cands = [
      { x: clamp(p.x, xmin, xmax), y: ymin },
      { x: clamp(p.x, xmin, xmax), y: ymax },
      { x: xmin, y: clamp(p.y, ymin, ymax) },
      { x: xmax, y: clamp(p.y, ymin, ymax) }
    ];
    return cands.reduce((a, b) => (dist(p, b) < dist(p, a) ? b : a));
  }

  // Clip the infinite line through p0 in direction d to the frame rectangle.
  function frameSpan(p0, d) {
    const f = view.frame;
    const xmin = f.x, xmax = f.x + f.w, ymin = f.y, ymax = f.y + f.h;
    let tmin = -Infinity, tmax = Infinity;

    const slab = (p, dd, lo, hi) => {
      if (Math.abs(dd) < 1e-9) return p >= lo && p <= hi;
      let t1 = (lo - p) / dd, t2 = (hi - p) / dd;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      return true;
    };

    if (!slab(p0.x, d.x, xmin, xmax)) return null;
    if (!slab(p0.y, d.y, ymin, ymax)) return null;
    if (tmin > tmax) return null;

    return {
      a: { x: p0.x + d.x * tmin, y: p0.y + d.y * tmin },
      b: { x: p0.x + d.x * tmax, y: p0.y + d.y * tmax }
    };
  }

  // --- convex region geometry ---------------------------------------------
  // Every line is a full chord across the rectangle, so the arrangement of
  // lines partitions the frame into convex polygons. The region containing a
  // point is the frame clipped by each line's half-plane on that point's side.

  function segLineIntersect(p1, p2, a, b) {
    const r = { x: p2.x - p1.x, y: p2.y - p1.y };
    const s = { x: b.x - a.x, y: b.y - a.y };
    const denom = r.x * s.y - r.y * s.x;
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((a.x - p1.x) * s.y - (a.y - p1.y) * s.x) / denom;
    return { x: p1.x + t * r.x, y: p1.y + t * r.y };
  }

  // Keep the part of poly on one side of the line L0->L1.
  function clipSide(poly, L0, L1, keepPositive) {
    const side = (pt) => (L1.x - L0.x) * (pt.y - L0.y) - (L1.y - L0.y) * (pt.x - L0.x);
    const inside = (pt) => (keepPositive ? side(pt) >= -1e-9 : side(pt) <= 1e-9);
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], nxt = poly[(i + 1) % poly.length];
      const cin = inside(cur), nin = inside(nxt);
      if (cin) out.push(cur);
      if (cin !== nin) {
        const ip = segLineIntersect(cur, nxt, L0, L1);
        if (ip) out.push(ip);
      }
    }
    return out;
  }

  function clipHalfPlane(poly, L0, L1, ref) {
    const sref = (L1.x - L0.x) * (ref.y - L0.y) - (L1.y - L0.y) * (ref.x - L0.x);
    if (Math.abs(sref) < 1e-9) return poly; // ref on the line; leave uncut
    return clipSide(poly, L0, L1, sref > 0);
  }

  function regionPolygon(seed) {
    const f = view.frame;
    if (seed.x < f.x - 1e-6 || seed.x > f.x + f.w + 1e-6 ||
        seed.y < f.y - 1e-6 || seed.y > f.y + f.h + 1e-6) return null;
    let poly = [
      { x: f.x, y: f.y },
      { x: f.x + f.w, y: f.y },
      { x: f.x + f.w, y: f.y + f.h },
      { x: f.x, y: f.y + f.h }
    ];
    for (const ln of state.lines) {
      const { a, b } = endpoints(ln);
      poly = clipHalfPlane(poly, a, b, seed);
      if (poly.length < 3) return null;
    }
    return poly;
  }

  function pointInPoly(p, poly) {
    let pos = false, neg = false;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      if (c > 1e-6) pos = true; else if (c < -1e-6) neg = true;
      if (pos && neg) return false;
    }
    return true;
  }

  // --- vector hatching ----------------------------------------------------

  // Intersect the infinite line (base + t*dir) with a convex polygon, returning
  // the chord segment {a, b} or null.
  function clipLineToPoly(base, dir, poly) {
    let tmin = Infinity, tmax = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const e = { x: p2.x - p1.x, y: p2.y - p1.y };
      const denom = dir.x * e.y - dir.y * e.x;
      if (Math.abs(denom) < 1e-12) continue;
      const dx = p1.x - base.x, dy = p1.y - base.y;
      const t = (dx * e.y - dy * e.x) / denom;
      const u = (dx * dir.y - dy * dir.x) / denom;
      if (u >= -1e-9 && u <= 1 + 1e-9) {
        if (t < tmin) tmin = t;
        if (t > tmax) tmax = t;
      }
    }
    if (tmax - tmin <= 1e-6) return null;
    return {
      a: { x: base.x + dir.x * tmin, y: base.y + dir.y * tmin },
      b: { x: base.x + dir.x * tmax, y: base.y + dir.y * tmax }
    };
  }

  function hatchSegments(poly, angle, spacing) {
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const nrm = { x: -dir.y, y: dir.x };
    let mn = Infinity, mx = -Infinity;
    for (const v of poly) {
      const d = v.x * nrm.x + v.y * nrm.y;
      if (d < mn) mn = d;
      if (d > mx) mx = d;
    }
    const segs = [];
    for (let off = Math.ceil(mn / spacing) * spacing; off < mx; off += spacing) {
      const base = { x: nrm.x * off, y: nrm.y * off };
      const seg = clipLineToPoly(base, dir, poly);
      if (seg) segs.push(seg);
    }
    return segs;
  }

  function radialSegments(poly, origin, spacing) {
    // Anchor to the polygon vertex nearest the stored origin.
    let k = 0, best = Infinity;
    for (let i = 0; i < poly.length; i++) {
      const d = dist(poly[i], origin);
      if (d < best) { best = d; k = i; }
    }
    const O = poly[k];
    let maxR = 1;
    const angles = [];
    for (let i = 0; i < poly.length; i++) {
      if (i === k) continue;
      maxR = Math.max(maxR, dist(poly[i], O));
      angles.push(Math.atan2(poly[i].y - O.y, poly[i].x - O.x));
    }
    if (!angles.length) return [];
    const ref = angles[0];
    const un = angles.map(a => {
      let d = a - ref;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return ref + d;
    });
    const amin = Math.min(...un), amax = Math.max(...un);
    const step = clamp(spacing / maxR, 0.04, 0.5);
    const segs = [];
    for (let a = amin; a <= amax + 1e-6; a += step) {
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const seg = clipLineToPoly(O, dir, poly);
      if (!seg) continue;
      const far = dist(seg.a, O) > dist(seg.b, O) ? seg.a : seg.b;
      segs.push({ a: O, b: far });
    }
    return segs;
  }

  function fillSegments(fill, poly) {
    if (fill.pattern === "radial") return radialSegments(poly, toScreen(fill.radial), fill.density);
    return hatchSegments(poly, PATTERN_ANGLE[fill.pattern], fill.density);
  }

  // --- hit testing --------------------------------------------------------

  function distanceToSegment(p, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-9) return dist(p, a);
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = clamp(t, 0, 1);
    return dist(p, { x: a.x + vx * t, y: a.y + vy * t });
  }

  function hitHandle(p) {
    const line = selectedLine();
    if (!line) return null;
    const { a, b } = endpoints(line);
    if (dist(p, a) <= config.handleHit) return "a";
    if (dist(p, b) <= config.handleHit) return "b";
    return null;
  }

  function findLineNear(p) {
    for (let i = state.lines.length - 1; i >= 0; i--) {
      const { a, b } = endpoints(state.lines[i]);
      if (distanceToSegment(p, a, b) <= config.hit) return state.lines[i];
    }
    return null;
  }

  function findFillAt(p) {
    for (let i = state.fills.length - 1; i >= 0; i--) {
      const poly = regionPolygon(toScreen(state.fills[i].seed));
      if (poly && pointInPoly(p, poly)) return state.fills[i];
    }
    return null;
  }

  function createFill(p) {
    const poly = regionPolygon(p);
    if (!poly) return null;
    const pattern = lastFill.pattern || FILL_PATTERNS[Math.floor(Math.random() * FILL_PATTERNS.length)];
    const vtx = poly[Math.floor(Math.random() * poly.length)];
    const fill = {
      id: state.nextFillId++,
      seed: toNorm(p),
      pattern,
      density: lastFill.density,
      radial: toNorm(vtx)
    };
    state.fills.push(fill);
    return fill;
  }

  // When a new line splits a filled region, the side that no longer holds the
  // original fill's seed becomes a new fill inheriting the parent's settings.
  // Call BEFORE the new line is added to state.lines (parents are the regions
  // as they exist without it).
  function inheritFillsAcrossLine(la, lb) {
    const side = (pt) => (lb.x - la.x) * (pt.y - la.y) - (lb.y - la.y) * (pt.x - la.x);
    const children = [];
    for (const fill of state.fills) {
      const seedPt = toScreen(fill.seed);
      const parent = regionPolygon(seedPt);
      if (!parent) continue;
      let pos = false, neg = false;
      for (const v of parent) { const s = side(v); if (s > 1e-6) pos = true; else if (s < -1e-6) neg = true; }
      if (!(pos && neg)) continue; // the line does not split this region
      const childPoly = clipSide(parent, la, lb, side(seedPt) < 0);
      if (childPoly.length < 3) continue;
      let cx = 0, cy = 0;
      for (const v of childPoly) { cx += v.x; cy += v.y; }
      cx /= childPoly.length; cy /= childPoly.length;
      const vtx = childPoly[Math.floor(Math.random() * childPoly.length)];
      children.push({
        id: state.nextFillId++,
        seed: toNorm({ x: cx, y: cy }),
        pattern: fill.pattern,
        density: fill.density,
        radial: toNorm(vtx)
      });
    }
    for (const c of children) state.fills.push(c);
  }

  // --- selection ----------------------------------------------------------

  function rememberLine(line) { lastLine.thickness = line.thickness; }

  function setSelection(sel) {
    state.selection = sel;
    const ln = selectedLine();
    if (ln) rememberLine(ln);
    refreshToolbars();
  }

  // --- gesture ------------------------------------------------------------

  function onPointerDown(e) {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = pointerPoint(e);

    const handle = hitHandle(p);
    if (handle) {
      state.gesture = { id: e.pointerId, kind: "move-end", lineId: state.selection.id, end: handle };
      return;
    }

    state.gesture = {
      id: e.pointerId,
      kind: "new-or-select",
      start: p,
      moved: false,
      preview: null,
      tapTarget: findLineNear(p)
    };
  }

  function onPointerMove(e) {
    const g = state.gesture;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();
    const p = pointerPoint(e);

    if (g.kind === "move-end") {
      const line = lineById(g.lineId);
      if (line) line[g.end] = toNorm(nearestFramePoint(p));
      render();
      return;
    }

    if (g.kind === "new-or-select") {
      if (dist(g.start, p) >= config.dragThreshold) {
        g.moved = true;
        const d = { x: p.x - g.start.x, y: p.y - g.start.y };
        g.preview = frameSpan(g.start, d);
      }
      render();
    }
  }

  function onPointerUp(e) {
    const g = state.gesture;
    if (!g || g.id !== e.pointerId) return;
    e.preventDefault();
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}

    if (g.kind === "move-end") {
      // selection unchanged
    } else if (g.kind === "new-or-select") {
      if (g.moved && g.preview) {
        inheritFillsAcrossLine(g.preview.a, g.preview.b);
        const line = {
          id: state.nextLineId++,
          a: toNorm(g.preview.a),
          b: toNorm(g.preview.b),
          thickness: lastLine.thickness
        };
        state.lines.push(line);
        setSelection({ type: "line", id: line.id });
      } else if (g.tapTarget) {
        const cur = state.selection;
        if (cur && cur.type === "line" && cur.id === g.tapTarget.id) setSelection(null);
        else setSelection({ type: "line", id: g.tapTarget.id });
      } else {
        const existing = findFillAt(g.start);
        if (existing) {
          const cur = state.selection;
          if (cur && cur.type === "fill" && cur.id === existing.id) setSelection(null);
          else setSelection({ type: "fill", id: existing.id });
        } else {
          const fill = createFill(g.start);
          setSelection(fill ? { type: "fill", id: fill.id } : null);
        }
      }
    }

    state.gesture = null;
    render();
  }

  // --- drawing ------------------------------------------------------------

  function strokeSpan(a, b, width, color) {
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineWidth = width;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  function drawFrame() {
    const f = view.frame;
    ctx.lineJoin = "miter";
    ctx.strokeStyle = INK;
    ctx.lineWidth = config.frameWidth;
    ctx.strokeRect(f.x, f.y, f.w, f.h);
  }

  function drawEndpointHandle(p) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 9, 0, Math.PI * 2);
    ctx.fillStyle = SELECT;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#fff";
    ctx.stroke();
    ctx.restore();
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);

    ctx.lineCap = "butt";

    // 1) fills (under the lines)
    for (const fill of state.fills) {
      const poly = regionPolygon(toScreen(fill.seed));
      if (!poly) continue;
      ctx.strokeStyle = INK;
      ctx.lineWidth = FILL_LINE_WIDTH;
      ctx.beginPath();
      for (const s of fillSegments(fill, poly)) {
        ctx.moveTo(s.a.x, s.a.y);
        ctx.lineTo(s.b.x, s.b.y);
      }
      ctx.stroke();
    }

    // 2) dividing lines
    for (const ln of state.lines) {
      const { a, b } = endpoints(ln);
      const selected = state.selection && state.selection.type === "line" && ln.id === state.selection.id;
      strokeSpan(a, b, ln.thickness, selected ? SELECT : INK);
    }

    // 3) live preview while drawing a new line
    const g = state.gesture;
    if (g && g.kind === "new-or-select" && g.preview) {
      strokeSpan(g.preview.a, g.preview.b, lastLine.thickness, SELECT);
    }

    // 4) frame
    drawFrame();

    // 5) selected fill: highlight its boundary in blue (on top)
    const sf = selectedFill();
    if (sf) {
      const poly = regionPolygon(toScreen(sf.seed));
      if (poly) {
        ctx.lineJoin = "round";
        ctx.strokeStyle = SELECT;
        ctx.lineWidth = 3.2;
        ctx.beginPath();
        ctx.moveTo(poly[0].x, poly[0].y);
        for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
        ctx.closePath();
        ctx.stroke();
      }
    }

    // 6) selected line: endpoint handles
    const sl = selectedLine();
    if (sl) {
      const { a, b } = endpoints(sl);
      drawEndpointHandle(a);
      drawEndpointHandle(b);
    }
  }

  // --- glyphs -------------------------------------------------------------

  const nearest = (arr, v) => arr.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

  function thicknessGlyph(value) {
    return `<line x1="8" y1="15" x2="40" y2="15" stroke="currentColor" stroke-width="${value}" stroke-linecap="round"/>`;
  }

  function densityGlyph(spacing) {
    const gap = clamp(spacing * 0.42, 4, 16);
    const cx = 24, x0 = 6, x1 = 42, xs = [];
    for (let x = cx; x <= x1; x += gap) xs.push(x);
    for (let x = cx - gap; x >= x0; x -= gap) xs.push(x);
    const lines = xs.map(x => `<line x1="${x.toFixed(1)}" y1="6" x2="${x.toFixed(1)}" y2="24"/>`).join("");
    return `<g stroke="currentColor" stroke-width="2" stroke-linecap="round">${lines}</g>`;
  }

  function patternGlyph(p) {
    const L = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
    let inner;
    if (p === "horiz") inner = L(7, 9, 41, 9) + L(7, 15, 41, 15) + L(7, 21, 41, 21);
    else if (p === "vert") inner = L(14, 5, 14, 25) + L(24, 5, 24, 25) + L(34, 5, 34, 25);
    else if (p === "diagf") inner = L(8, 24, 20, 6) + L(20, 24, 32, 6) + L(32, 24, 44, 6);
    else if (p === "diagb") inner = L(8, 6, 20, 24) + L(20, 6, 32, 24) + L(32, 6, 44, 24);
    else inner = L(8, 25, 44, 6) + L(8, 25, 44, 15) + L(8, 25, 44, 24) + L(8, 25, 30, 6) + L(8, 25, 18, 6);
    return `<g stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none">${inner}</g>`;
  }

  function svgWrap(inner, w, h) {
    return `<svg viewBox="0 0 48 30" width="${w}" height="${h}" aria-hidden="true">${inner}</svg>`;
  }

  // --- line toolbar -------------------------------------------------------

  const LINE_LEVELS = [2, 3.5, 5.5, 8, 12];
  const lineThicknessBtn = lineToolbar.querySelector('[data-toolbtn="thickness"]');
  const lineThicknessFlyout = lineToolbar.querySelector('[data-flyout="thickness"]');
  const lineDeleteBtn = document.getElementById("deleteBtn");

  for (const v of LINE_LEVELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.dataset.value = String(v);
    btn.innerHTML = svgWrap(thicknessGlyph(v), 46, 29);
    lineThicknessFlyout.appendChild(btn);
  }

  function markLineOptions() {
    const line = selectedLine();
    if (!line) return;
    lineThicknessBtn.innerHTML = svgWrap(thicknessGlyph(line.thickness), 40, 25);
    const nv = nearest(LINE_LEVELS, line.thickness);
    for (const opt of lineThicknessFlyout.children) opt.classList.toggle("active", Number(opt.dataset.value) === nv);
  }

  function closeLineFlyouts() {
    lineThicknessFlyout.hidden = true;
    lineThicknessBtn.classList.remove("active");
  }

  lineThicknessBtn.addEventListener("click", () => {
    const wasOpen = !lineThicknessFlyout.hidden;
    closeLineFlyouts();
    if (!wasOpen) {
      lineThicknessFlyout.hidden = false;
      lineThicknessBtn.classList.add("active");
      markLineOptions();
    }
  });

  lineThicknessFlyout.addEventListener("click", (e) => {
    const opt = e.target.closest(".opt");
    if (!opt) return;
    const line = selectedLine();
    if (line) {
      line.thickness = Number(opt.dataset.value);
      rememberLine(line);
      markLineOptions();
      render();
    }
    closeLineFlyouts();
  });

  lineDeleteBtn.addEventListener("click", () => {
    const line = selectedLine();
    if (!line) return;
    const idx = state.lines.findIndex(l => l.id === line.id);
    if (idx >= 0) state.lines.splice(idx, 1);
    setSelection(null);
    render();
  });

  // --- fill toolbar -------------------------------------------------------

  const FILL_DENSITY_LEVELS = [40, 28, 20, 13, 8];
  const fillPatternBtn = fillToolbar.querySelector('[data-filltoolbtn="pattern"]');
  const fillPatternFlyout = fillToolbar.querySelector('[data-fillflyout="pattern"]');
  const fillDensityBtn = fillToolbar.querySelector('[data-filltoolbtn="density"]');
  const fillDensityFlyout = fillToolbar.querySelector('[data-fillflyout="density"]');
  const fillDeleteBtn = document.getElementById("fillDeleteBtn");

  for (const p of FILL_PATTERNS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.dataset.value = p;
    btn.innerHTML = svgWrap(patternGlyph(p), 46, 29);
    fillPatternFlyout.appendChild(btn);
  }
  for (const v of FILL_DENSITY_LEVELS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "opt";
    btn.dataset.value = String(v);
    btn.innerHTML = svgWrap(densityGlyph(v), 46, 29);
    fillDensityFlyout.appendChild(btn);
  }

  function markFillOptions() {
    const fill = selectedFill();
    if (!fill) return;
    fillPatternBtn.innerHTML = svgWrap(patternGlyph(fill.pattern), 40, 25);
    fillDensityBtn.innerHTML = svgWrap(densityGlyph(fill.density), 40, 25);
    for (const opt of fillPatternFlyout.children) opt.classList.toggle("active", opt.dataset.value === fill.pattern);
    const nv = nearest(FILL_DENSITY_LEVELS, fill.density);
    for (const opt of fillDensityFlyout.children) opt.classList.toggle("active", Number(opt.dataset.value) === nv);
  }

  function closeFillFlyouts() {
    fillPatternFlyout.hidden = true;
    fillDensityFlyout.hidden = true;
    fillPatternBtn.classList.remove("active");
    fillDensityBtn.classList.remove("active");
  }

  function wireFillFlyout(btn, flyout, apply) {
    btn.addEventListener("click", () => {
      const wasOpen = !flyout.hidden;
      closeFillFlyouts();
      if (!wasOpen) {
        flyout.hidden = false;
        btn.classList.add("active");
        markFillOptions();
      }
    });
    flyout.addEventListener("click", (e) => {
      const opt = e.target.closest(".opt");
      if (!opt) return;
      const fill = selectedFill();
      if (fill) { apply(fill, opt.dataset.value); markFillOptions(); render(); }
      closeFillFlyouts();
    });
  }

  wireFillFlyout(fillPatternBtn, fillPatternFlyout, (fill, value) => {
    fill.pattern = value;
    if (value === "radial") {
      const poly = regionPolygon(toScreen(fill.seed));
      if (poly) fill.radial = toNorm(poly[Math.floor(Math.random() * poly.length)]);
    }
    lastFill.pattern = value;
  });
  wireFillFlyout(fillDensityBtn, fillDensityFlyout, (fill, value) => {
    fill.density = Number(value);
    lastFill.density = Number(value);
  });

  fillDeleteBtn.addEventListener("click", () => {
    const fill = selectedFill();
    if (!fill) return;
    const idx = state.fills.findIndex(f => f.id === fill.id);
    if (idx >= 0) state.fills.splice(idx, 1);
    setSelection(null);
    render();
  });

  // --- toolbar visibility -------------------------------------------------

  function refreshToolbars() {
    if (selectedLine()) { lineToolbar.hidden = false; markLineOptions(); }
    else { lineToolbar.hidden = true; closeLineFlyouts(); }

    if (selectedFill()) { fillToolbar.hidden = false; markFillOptions(); }
    else { fillToolbar.hidden = true; closeFillFlyouts(); }
  }

  document.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".toolbar")) { closeLineFlyouts(); closeFillFlyouts(); }
  });

  // --- listeners ----------------------------------------------------------

  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", onPointerUp, { passive: false });
  canvas.addEventListener("pointercancel", onPointerUp, { passive: false });

  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", () => requestAnimationFrame(resize));
  if (window.visualViewport) window.visualViewport.addEventListener("resize", resize);
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(app);

  resize();
})();
