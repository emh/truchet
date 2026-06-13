if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}

(() => {
  "use strict";

  const STORAGE_KEY = "mondrian-infinite-canvas-v1";
  const WORLD_HALF = 1048576;

  const COLORS = {
    white: "#fbfaf6",
    yellow: "#f6d318",
    blue: "#1559b7",
    red: "#d6281f"
  };

  const canvas = document.getElementById("stage");
  const ctx = canvas.getContext("2d", { alpha: false });
  const toolbar = document.getElementById("toolbar");
  const toolButtons = [...toolbar.querySelectorAll("button[data-tool]")];

  let activeTool = "split-v";
  let undoStack = [];
  let redoStack = [];

  let dpr = 1;
  let cssW = 1;
  let cssH = 1;

  // Camera: world coordinate at screen center + zoom in px/world-unit.
  let camera = {
    x: 0,
    y: 0,
    z: 1
  };

  const defaultRoot = () => ({
    x: -WORLD_HALF,
    y: -WORLD_HALF,
    w: WORLD_HALF * 2,
    h: WORLD_HALF * 2,
    color: "white",
    children: null
  });

  let root = defaultRoot();

  function cloneRoot(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || !saved.root || !saved.camera) return;
      root = saved.root;
      camera = saved.camera;
    } catch {
      root = defaultRoot();
      camera = { x: 0, y: 0, z: 1 };
    }
  }

  let saveTimer = 0;
  function saveSoon() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ root, camera }));
      } catch {
        // Ignore storage quota/private mode failures.
      }
    }, 120);
  }

  function resize() {
    dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(1, rect.width);
    cssH = Math.max(1, rect.height);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    requestDraw();
  }

  function worldToScreenX(x) { return (x - camera.x) * camera.z + cssW / 2; }
  function worldToScreenY(y) { return (y - camera.y) * camera.z + cssH / 2; }
  function screenToWorldX(x) { return (x - cssW / 2) / camera.z + camera.x; }
  function screenToWorldY(y) { return (y - cssH / 2) / camera.z + camera.y; }

  function visibleWorldRect() {
    return {
      x: screenToWorldX(0),
      y: screenToWorldY(0),
      w: cssW / camera.z,
      h: cssH / camera.z
    };
  }

  function intersects(a, b) {
    return !(
      a.x + a.w < b.x ||
      b.x + b.w < a.x ||
      a.y + a.h < b.y ||
      b.y + b.h < a.y
    );
  }

  function findLeaf(node, x, y) {
    if (
      x < node.x ||
      x > node.x + node.w ||
      y < node.y ||
      y > node.y + node.h
    ) return null;

    if (!node.children) return node;

    for (const child of node.children) {
      const hit = findLeaf(child, x, y);
      if (hit) return hit;
    }

    return node;
  }

  function splitNode(node, dir, x, y) {
    if (node.children) return false;

    // Avoid pathological splits that become visually impossible to tap.
    const minWorldSize = 18 / camera.z;
    if (dir === "v" && node.w < minWorldSize * 2) return false;
    if (dir === "h" && node.h < minWorldSize * 2) return false;

    if (dir === "v") {
      const splitX = Math.max(node.x + minWorldSize, Math.min(node.x + node.w - minWorldSize, x));
      const w = splitX - node.x;
      node.children = [
        { x: node.x,     y: node.y, w, h: node.h, color: node.color, children: null },
        { x: splitX,     y: node.y, w: node.w - w, h: node.h, color: node.color, children: null }
      ];
    } else {
      const splitY = Math.max(node.y + minWorldSize, Math.min(node.y + node.h - minWorldSize, y));
      const h = splitY - node.y;
      node.children = [
        { x: node.x, y: node.y,     w: node.w, h, color: node.color, children: null },
        { x: node.x, y: splitY,     w: node.w, h: node.h - h, color: node.color, children: null }
      ];
    }

    return true;
  }

  function pushUndoSnapshot(snapshot) {
    undoStack.push(snapshot);
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
  }

  function restoreFromHistory(fromStack, toStack) {
    if (!fromStack.length) return;
    toStack.push(cloneRoot(root));
    root = fromStack.pop();
    saveSoon();
    requestDraw();
  }

  function clearCanvas() {
    if (!root.children && root.color === "white") return;
    pushUndoSnapshot(cloneRoot(root));
    root = defaultRoot();
    saveSoon();
    requestDraw();
  }

  function applyTool(x, y) {
    const leaf = findLeaf(root, x, y);
    if (!leaf) return;

    const before = cloneRoot(root);
    let changed = false;

    if (activeTool === "split-v") changed = splitNode(leaf, "v", x, y);
    else if (activeTool === "split-h") changed = splitNode(leaf, "h", x, y);
    else if (activeTool.startsWith("paint-")) {
      const color = activeTool.replace("paint-", "");
      if (leaf.color !== color) {
        leaf.color = color;
        changed = true;
      }
    }

    if (!changed) return;

    pushUndoSnapshot(before);
    saveSoon();
    requestDraw();
  }

  function collectLeaves(node, view, out) {
    if (!intersects(node, view)) return;

    if (!node.children) {
      out.push(node);
      return;
    }

    for (const child of node.children) collectLeaves(child, view, out);
  }

  function drawRectWorld(node) {
    const x = worldToScreenX(node.x);
    const y = worldToScreenY(node.y);
    const w = node.w * camera.z;
    const h = node.h * camera.z;

    // Pad a little to avoid hairline gaps during fractional transforms.
    ctx.fillStyle = COLORS[node.color] || COLORS.white;
    ctx.fillRect(x - 0.5, y - 0.5, w + 1, h + 1);
  }

  function drawLeafBorders(leaves) {
    ctx.strokeStyle = "#111";
    ctx.lineWidth = Math.max(3, Math.min(9, 5.5));
    ctx.lineJoin = "miter";
    ctx.lineCap = "butt";

    for (const node of leaves) {
      // Do not draw the giant outer border of the initial canvas.
      if (node === root && !root.children) continue;

      const x = worldToScreenX(node.x);
      const y = worldToScreenY(node.y);
      const w = node.w * camera.z;
      const h = node.h * camera.z;

      // Avoid wasting time stroking enormous offscreen rectangles when mostly invisible.
      const sx = Math.max(-20, x);
      const sy = Math.max(-20, y);
      const ex = Math.min(cssW + 20, x + w);
      const ey = Math.min(cssH + 20, y + h);

      if (ex <= -20 || ey <= -20 || sx >= cssW + 20 || sy >= cssH + 20) continue;

      ctx.strokeRect(x, y, w, h);
    }
  }

  function drawGridHint() {
    // Subtle world-origin crosshair/grid for orientation while still looking blank.
    const grid = 256;
    const view = visibleWorldRect();
    const startX = Math.floor(view.x / grid) * grid;
    const startY = Math.floor(view.y / grid) * grid;

    ctx.save();
    ctx.strokeStyle = "rgba(0,0,0,0.035)";
    ctx.lineWidth = 1;

    for (let x = startX; x < view.x + view.w; x += grid) {
      const sx = worldToScreenX(x);
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, cssH);
      ctx.stroke();
    }

    for (let y = startY; y < view.y + view.h; y += grid) {
      const sy = worldToScreenY(y);
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(cssW, sy);
      ctx.stroke();
    }

    ctx.restore();
  }

  let drawPending = false;
  function requestDraw() {
    if (drawPending) return;
    drawPending = true;
    requestAnimationFrame(draw);
  }

  function draw() {
    drawPending = false;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#fbfaf6";
    ctx.fillRect(0, 0, cssW, cssH);

    drawGridHint();

    const view = visibleWorldRect();
    const leaves = [];
    collectLeaves(root, view, leaves);

    for (const leaf of leaves) drawRectWorld(leaf);
    drawLeafBorders(leaves);
  }

  toolbar.addEventListener("click", (e) => {
    const actionBtn = e.target.closest("button[data-action]");
    if (actionBtn?.dataset.action === "undo") {
      restoreFromHistory(undoStack, redoStack);
      return;
    }
    if (actionBtn?.dataset.action === "redo") {
      restoreFromHistory(redoStack, undoStack);
      return;
    }
    if (actionBtn?.dataset.action === "clear") {
      clearCanvas();
      return;
    }

    const btn = e.target.closest("button[data-tool]");
    if (!btn) return;

    activeTool = btn.dataset.tool;
    for (const b of toolButtons) b.classList.toggle("active", b === btn);
  });

  const pointers = new Map();
  let gesture = null;

  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function zoomAt(screenX, screenY, factor) {
    const beforeX = screenToWorldX(screenX);
    const beforeY = screenToWorldY(screenY);

    camera.z = Math.max(0.03, Math.min(32, camera.z * factor));

    const afterX = screenToWorldX(screenX);
    const afterY = screenToWorldY(screenY);

    camera.x += beforeX - afterX;
    camera.y += beforeY - afterY;
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = canvasPoint(e);
    pointers.set(e.pointerId, { ...p, startX: p.x, startY: p.y });

    if (pointers.size === 1) {
      gesture = {
        kind: "pan",
        startCameraX: camera.x,
        startCameraY: camera.y,
        moved: false,
        pointerId: e.pointerId
      };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = {
        kind: "pinch",
        startDistance: Math.max(1, distance(a, b)),
        startZoom: camera.z,
        startCameraX: camera.x,
        startCameraY: camera.y,
        startMid: midpoint(a, b)
      };
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;

    const p = canvasPoint(e);
    const old = pointers.get(e.pointerId);
    pointers.set(e.pointerId, { ...old, x: p.x, y: p.y });

    if (!gesture) return;

    if (gesture.kind === "pan" && pointers.size === 1) {
      const current = pointers.get(e.pointerId);
      const dx = current.x - current.startX;
      const dy = current.y - current.startY;

      if (Math.hypot(dx, dy) > 6) gesture.moved = true;

      camera.x = gesture.startCameraX - dx / camera.z;
      camera.y = gesture.startCameraY - dy / camera.z;

      saveSoon();
      requestDraw();
    }

    if (gesture.kind === "pinch" && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mid = midpoint(a, b);
      const dist = Math.max(1, distance(a, b));

      const worldAtStartMidX = (gesture.startMid.x - cssW / 2) / gesture.startZoom + gesture.startCameraX;
      const worldAtStartMidY = (gesture.startMid.y - cssH / 2) / gesture.startZoom + gesture.startCameraY;

      camera.z = Math.max(0.03, Math.min(32, gesture.startZoom * (dist / gesture.startDistance)));
      camera.x = worldAtStartMidX - (mid.x - cssW / 2) / camera.z;
      camera.y = worldAtStartMidY - (mid.y - cssH / 2) / camera.z;

      saveSoon();
      requestDraw();
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    const p = pointers.get(e.pointerId);
    const wasTap = gesture &&
      gesture.kind === "pan" &&
      gesture.pointerId === e.pointerId &&
      p &&
      !gesture.moved;

    pointers.delete(e.pointerId);

    if (wasTap) {
      const worldX = screenToWorldX(p.x);
      const worldY = screenToWorldY(p.y);
      applyTool(worldX, worldY);
    }

    if (pointers.size === 0) {
      gesture = null;
    } else if (pointers.size === 1) {
      const [remainingId, remaining] = [...pointers.entries()][0];
      pointers.set(remainingId, {
        ...remaining,
        startX: remaining.x,
        startY: remaining.y
      });
      gesture = {
        kind: "pan",
        startCameraX: camera.x,
        startCameraY: camera.y,
        moved: false,
        pointerId: remainingId
      };
    }
  });

  canvas.addEventListener("pointercancel", (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size === 0) gesture = null;
  });

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = canvasPoint(e);
    const factor = Math.exp(-e.deltaY * 0.001);
    zoomAt(p.x, p.y, factor);
    saveSoon();
    requestDraw();
  }, { passive: false });

  // Small keyboard affordances for desktop testing.
  window.addEventListener("keydown", (e) => {
    const map = {
      "1": "split-v",
      "2": "split-h",
      "3": "paint-white",
      "4": "paint-yellow",
      "5": "paint-blue",
      "6": "paint-red"
    };
    if (!map[e.key]) return;

    activeTool = map[e.key];
    for (const b of toolButtons) b.classList.toggle("active", b.dataset.tool === activeTool);
  });

  window.addEventListener("resize", resize);

  load();
  resize();
})();
