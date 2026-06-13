import { hexToRgb, mixRgb, rgbCss } from './lib/color.js';
import { loadEdits, saveEdits } from './lib/storage.js';

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

const TILE_SIZE = 92;
const STROKE = TILE_SIZE * 0.125;
const RADIUS = TILE_SIZE / 2;
const TRANSITION_DURATION = 180;
const QUARTER_TURN = Math.PI / 2;
const SEED = 0x6d2b79f5;
const STORAGE_KEY = 'classic-12';
const BG = '#f3f0e8';
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 3.2;
const SHAKE_THRESHOLD = 16;
const SHAKE_DELTA_THRESHOLD = 18;
const SHAKE_COOLDOWN = 1100;

const COLOR = {
  R: '#d33a2c',
  Y: '#e7bd2c',
  B: '#2457a6'
};

const TILE_TYPES = [
  { a: COLOR.B, b: COLOR.Y, orientation: 0 },
  { a: COLOR.B, b: COLOR.Y, orientation: 1 },
  { a: COLOR.Y, b: COLOR.B, orientation: 0 },
  { a: COLOR.Y, b: COLOR.B, orientation: 1 },
  { a: COLOR.Y, b: COLOR.R, orientation: 0 },
  { a: COLOR.Y, b: COLOR.R, orientation: 1 },
  { a: COLOR.R, b: COLOR.Y, orientation: 0 },
  { a: COLOR.R, b: COLOR.Y, orientation: 1 },
  { a: COLOR.R, b: COLOR.B, orientation: 0 },
  { a: COLOR.R, b: COLOR.B, orientation: 1 },
  { a: COLOR.B, b: COLOR.R, orientation: 0 },
  { a: COLOR.B, b: COLOR.R, orientation: 1 }
].map((tile) => ({ ...tile, ar: hexToRgb(tile.a), br: hexToRgb(tile.b) }));

let width = 0;
let height = 0;
let dpr = 1;
let raf = 0;
let inertiaRaf = 0;
let saveTimer = 0;
let zoom = 1;
let lastShakeTime = 0;
let lastMotion = null;
let motionPermissionRequested = false;

const camera = { x: 0, y: 0 };
const velocity = { x: 0, y: 0 };
const edits = loadEdits(STORAGE_KEY, TILE_TYPES.length);
const animations = new Map();
const spriteCache = new Map();
const activePointers = new Map();

let activeTapKey = null;
let activeTapDirection = 1;

const pointer = {
  id: null,
  down: false,
  moved: false,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  lastT: 0
};

const pinch = {
  active: false,
  startDistance: 0,
  startZoom: 1,
  anchorX: 0,
  anchorY: 0,
  anchorWorldX: 0,
  anchorWorldY: 0
};

function keyOf(ix, iy) {
  return `${ix},${iy}`;
}

function hash2(ix, iy) {
  let h = SEED ^ 0x9e3779b9;
  h = Math.imul(h ^ ix, 0x85ebca6b);
  h = Math.imul(h ^ iy, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

function defaultTileIndex(ix, iy) {
  return hash2(ix | 0, iy | 0) % TILE_TYPES.length;
}

function tileIndex(ix, iy) {
  const delta = edits.get(keyOf(ix, iy)) || 0;
  return (defaultTileIndex(ix, iy) + delta) % TILE_TYPES.length;
}

function angleForTile(index) {
  return TILE_TYPES[index].orientation * QUARTER_TURN;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function representationFor(index, angle) {
  const tile = TILE_TYPES[index];
  const halfTurns = Math.round((angle - angleForTile(index)) / Math.PI);
  const swap = Math.abs(halfTurns % 2) === 1;
  return {
    angle,
    a: swap ? tile.br : tile.ar,
    b: swap ? tile.ar : tile.br
  };
}

function nextDirectionalRepresentation(index, afterAngle, direction) {
  const base = angleForTile(index);
  const epsilon = 0.0001;
  let halfTurns;
  let angle;

  if (direction > 0) {
    halfTurns = Math.ceil((afterAngle - base + epsilon) / Math.PI);
    angle = base + halfTurns * Math.PI;
    if (angle <= afterAngle + epsilon) angle += Math.PI;
  } else {
    halfTurns = Math.floor((afterAngle - base - epsilon) / Math.PI);
    angle = base + halfTurns * Math.PI;
    if (angle >= afterAngle - epsilon) angle -= Math.PI;
  }

  return representationFor(index, angle);
}

function directionForTap(key) {
  if (key !== activeTapKey) {
    activeTapKey = key;
    activeTapDirection = Math.random() < 0.5 ? -1 : 1;
  }
  return activeTapDirection;
}

function visualStateFor(key, index, now = performance.now()) {
  const anim = animations.get(key);
  if (!anim) return representationFor(index, angleForTile(index));

  const t = Math.min(1, Math.max(0, (now - anim.start) / anim.duration));
  const eased = easeOutCubic(t);
  return {
    angle: anim.fromAngle + (anim.toAngle - anim.fromAngle) * eased,
    a: mixRgb(anim.fromA, anim.toA, eased),
    b: mixRgb(anim.fromB, anim.toB, eased)
  };
}

function pruneAnimations(now) {
  for (const [key, anim] of animations) {
    if (now - anim.start >= anim.duration) animations.delete(key);
  }
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveEdits(STORAGE_KEY, edits);
  }, 120);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function setZoomAround(clientX, clientY, nextZoom) {
  const before = worldFromScreen(clientX, clientY);
  zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  camera.x = before.x - (clientX - width / 2) / zoom;
  camera.y = before.y - (clientY - height / 2) / zoom;
  requestDraw();
}

function drawCanonicalTile(targetCtx, colorA, colorB) {
  targetCtx.lineWidth = STROKE;
  targetCtx.lineCap = 'butt';
  targetCtx.lineJoin = 'round';

  targetCtx.strokeStyle = colorA;
  targetCtx.beginPath();
  targetCtx.arc(0, 0, RADIUS, 0, QUARTER_TURN, false);
  targetCtx.stroke();

  targetCtx.strokeStyle = colorB;
  targetCtx.beginPath();
  targetCtx.arc(TILE_SIZE, TILE_SIZE, RADIUS, Math.PI, Math.PI + QUARTER_TURN, false);
  targetCtx.stroke();
}

function drawTileDef(targetCtx, tile, angle) {
  targetCtx.save();
  targetCtx.beginPath();
  targetCtx.rect(0, 0, TILE_SIZE, TILE_SIZE);
  targetCtx.clip();
  targetCtx.translate(TILE_SIZE / 2, TILE_SIZE / 2);
  targetCtx.rotate(angle);
  targetCtx.translate(-TILE_SIZE / 2, -TILE_SIZE / 2);
  drawCanonicalTile(targetCtx, tile.a, tile.b);
  targetCtx.restore();
}

function spriteFor(tileIndexValue) {
  const cacheKey = `${tileIndexValue}:${dpr}`;
  let sprite = spriteCache.get(cacheKey);
  if (sprite) return sprite;

  sprite = document.createElement('canvas');
  sprite.width = Math.ceil(TILE_SIZE * dpr);
  sprite.height = Math.ceil(TILE_SIZE * dpr);

  const sctx = sprite.getContext('2d');
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
  sctx.imageSmoothingEnabled = true;
  sctx.imageSmoothingQuality = 'high';
  drawTileDef(sctx, TILE_TYPES[tileIndexValue], angleForTile(tileIndexValue));

  spriteCache.set(cacheKey, sprite);
  return sprite;
}

function drawAnimatedTile(x, y, anim, now) {
  const t = Math.min(1, Math.max(0, (now - anim.start) / anim.duration));
  const eased = easeOutCubic(t);
  const angle = anim.fromAngle + (anim.toAngle - anim.fromAngle) * eased;
  const colorA = rgbCss(mixRgb(anim.fromA, anim.toA, eased));
  const colorB = rgbCss(mixRgb(anim.fromB, anim.toB, eased));

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, TILE_SIZE, TILE_SIZE);
  ctx.clip();
  ctx.translate(x + TILE_SIZE / 2, y + TILE_SIZE / 2);
  ctx.rotate(angle);
  ctx.translate(-TILE_SIZE / 2, -TILE_SIZE / 2);
  drawCanonicalTile(ctx, colorA, colorB);
  ctx.restore();
}

function resize() {
  width = window.innerWidth;
  height = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);

  canvas.width = Math.ceil(width * dpr);
  canvas.height = Math.ceil(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  spriteCache.clear();
  requestDraw();
}

function requestDraw() {
  if (!raf) raf = requestAnimationFrame(draw);
}

function draw() {
  raf = 0;
  const now = performance.now();
  pruneAnimations(now);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  const viewWidth = width / zoom;
  const viewHeight = height / zoom;
  const bufferX = viewWidth;
  const bufferY = viewHeight;
  const worldLeft = camera.x - viewWidth / 2 - bufferX;
  const worldRight = camera.x + viewWidth / 2 + bufferX;
  const worldTop = camera.y - viewHeight / 2 - bufferY;
  const worldBottom = camera.y + viewHeight / 2 + bufferY;

  const ix0 = Math.floor(worldLeft / TILE_SIZE);
  const ix1 = Math.floor(worldRight / TILE_SIZE);
  const iy0 = Math.floor(worldTop / TILE_SIZE);
  const iy1 = Math.floor(worldBottom / TILE_SIZE);

  for (let iy = iy0; iy <= iy1; iy++) {
    const y = (iy * TILE_SIZE - camera.y) * zoom + height / 2;
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = (ix * TILE_SIZE - camera.x) * zoom + width / 2;
      const key = keyOf(ix, iy);
      const anim = animations.get(key);

      if (anim) {
        ctx.save();
        ctx.translate(x, y);
        ctx.scale(zoom, zoom);
        drawAnimatedTile(0, 0, anim, now);
        ctx.restore();
      } else {
        ctx.drawImage(spriteFor(tileIndex(ix, iy)), x, y, TILE_SIZE * zoom, TILE_SIZE * zoom);
      }
    }
  }

  if (animations.size) requestDraw();
}

function worldFromScreen(clientX, clientY) {
  return {
    x: (clientX - width / 2) / zoom + camera.x,
    y: (clientY - height / 2) / zoom + camera.y
  };
}

function tileFromScreen(clientX, clientY) {
  const world = worldFromScreen(clientX, clientY);
  return {
    ix: Math.floor(world.x / TILE_SIZE),
    iy: Math.floor(world.y / TILE_SIZE)
  };
}

function advanceTile(ix, iy) {
  const key = keyOf(ix, iy);
  const direction = directionForTap(key);
  const now = performance.now();
  const fromIndex = tileIndex(ix, iy);
  const from = visualStateFor(key, fromIndex, now);
  const defaultIndex = defaultTileIndex(ix, iy);
  const nextIndex = (fromIndex + direction + TILE_TYPES.length) % TILE_TYPES.length;
  const nextDelta = (nextIndex - defaultIndex + TILE_TYPES.length) % TILE_TYPES.length;
  const to = nextDirectionalRepresentation(nextIndex, from.angle, direction);

  if (nextDelta === 0) edits.delete(key);
  else edits.set(key, nextDelta);

  animations.set(key, {
    fromAngle: from.angle,
    toAngle: to.angle,
    fromA: from.a,
    fromB: from.b,
    toA: to.a,
    toB: to.b,
    start: now,
    duration: TRANSITION_DURATION
  });

  queueSave();
  requestDraw();
}

function stopInertia() {
  if (inertiaRaf) cancelAnimationFrame(inertiaRaf);
  inertiaRaf = 0;
  velocity.x = 0;
  velocity.y = 0;
}

function resetFidget() {
  stopInertia();
  edits.clear();
  animations.clear();
  spriteCache.clear();
  activeTapKey = null;
  activeTapDirection = 1;
  camera.x = 0;
  camera.y = 0;
  zoom = 1;
  lastMotion = null;
  queueSave();
  requestDraw();
}

function startInertia() {
  let last = performance.now();
  const decayPerFrame = 0.92;

  const step = () => {
    const now = performance.now();
    const dt = Math.min(32, now - last);
    last = now;

    camera.x += (velocity.x * dt) / zoom;
    camera.y += (velocity.y * dt) / zoom;

    const decay = Math.pow(decayPerFrame, dt / 16.6667);
    velocity.x *= decay;
    velocity.y *= decay;

    requestDraw();

    if (Math.hypot(velocity.x, velocity.y) > 0.01) {
      inertiaRaf = requestAnimationFrame(step);
    } else {
      inertiaRaf = 0;
      velocity.x = 0;
      velocity.y = 0;
    }
  };

  inertiaRaf = requestAnimationFrame(step);
}

canvas.addEventListener('pointerdown', (event) => {
  stopInertia();
  requestMotionPermission();
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('dragging');

  if (activePointers.size === 2) {
    startPinch();
    pointer.down = false;
    pointer.id = null;
    return;
  }

  if (pointer.down) return;

  pointer.id = event.pointerId;
  pointer.down = true;
  pointer.moved = false;
  pointer.startX = pointer.lastX = event.clientX;
  pointer.startY = pointer.lastY = event.clientY;
  pointer.lastT = performance.now();
  velocity.x = 0;
  velocity.y = 0;
});

canvas.addEventListener('pointermove', (event) => {
  if (!activePointers.has(event.pointerId)) return;
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pinch.active && activePointers.size >= 2) {
    updatePinch();
    return;
  }

  if (!pointer.down || event.pointerId !== pointer.id) return;

  const now = performance.now();
  const dx = event.clientX - pointer.lastX;
  const dy = event.clientY - pointer.lastY;
  const dt = Math.max(1, now - pointer.lastT);

  if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) > 7) {
    pointer.moved = true;
  }

  camera.x -= dx / zoom;
  camera.y -= dy / zoom;
  velocity.x = -dx / dt;
  velocity.y = -dy / dt;

  pointer.lastX = event.clientX;
  pointer.lastY = event.clientY;
  pointer.lastT = now;

  requestDraw();
});

function endPointer(event) {
  activePointers.delete(event.pointerId);

  if (pinch.active) {
    if (activePointers.size < 2) endPinch();
    return;
  }

  if (!pointer.down || event.pointerId !== pointer.id) return;
  pointer.down = false;
  pointer.id = null;
  canvas.classList.remove('dragging');

  if (!pointer.moved) {
    const tile = tileFromScreen(event.clientX, event.clientY);
    advanceTile(tile.ix, tile.iy);
    return;
  }

  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed > 0.06) startInertia();
}

function pinchPoints() {
  const points = [...activePointers.values()];
  return [points[0], points[1]];
}

function pinchDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pinchCenter(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  };
}

function startPinch() {
  const [a, b] = pinchPoints();
  const center = pinchCenter(a, b);
  const world = worldFromScreen(center.x, center.y);
  pinch.active = true;
  pinch.startDistance = pinchDistance(a, b);
  pinch.startZoom = zoom;
  pinch.anchorX = center.x;
  pinch.anchorY = center.y;
  pinch.anchorWorldX = world.x;
  pinch.anchorWorldY = world.y;
  canvas.classList.add('dragging');
}

function updatePinch() {
  const [a, b] = pinchPoints();
  const center = pinchCenter(a, b);
  const distance = pinchDistance(a, b);
  if (pinch.startDistance <= 0) return;

  zoom = clamp(pinch.startZoom * (distance / pinch.startDistance), MIN_ZOOM, MAX_ZOOM);
  camera.x = pinch.anchorWorldX - (center.x - width / 2) / zoom;
  camera.y = pinch.anchorWorldY - (center.y - height / 2) / zoom;
  requestDraw();
}

function endPinch() {
  pinch.active = false;
  pointer.down = false;
  pointer.id = null;
  canvas.classList.toggle('dragging', activePointers.size > 0);
}

function requestMotionPermission() {
  if (motionPermissionRequested) return;
  motionPermissionRequested = true;

  if (
    typeof DeviceMotionEvent === 'undefined' ||
    typeof DeviceMotionEvent.requestPermission !== 'function'
  ) {
    return;
  }

  DeviceMotionEvent.requestPermission().catch(() => {
    motionPermissionRequested = false;
    // Shake reset is optional; browsers may deny motion access without affecting canvas input.
  });
}

function handleDeviceMotion(event) {
  const acceleration = event.acceleration;
  const accelerationWithGravity = event.accelerationIncludingGravity;
  const now = performance.now();
  let force = 0;
  let threshold = SHAKE_THRESHOLD;

  if (
    acceleration &&
    (acceleration.x !== null || acceleration.y !== null || acceleration.z !== null)
  ) {
    force = Math.hypot(acceleration.x || 0, acceleration.y || 0, acceleration.z || 0);
  } else if (accelerationWithGravity) {
    threshold = SHAKE_DELTA_THRESHOLD;
    const current = {
      x: accelerationWithGravity.x || 0,
      y: accelerationWithGravity.y || 0,
      z: accelerationWithGravity.z || 0
    };

    if (lastMotion) {
      force = Math.hypot(
        current.x - lastMotion.x,
        current.y - lastMotion.y,
        current.z - lastMotion.z
      );
    }

    lastMotion = current;
  }

  if (force > threshold && now - lastShakeTime > SHAKE_COOLDOWN) {
    lastShakeTime = now;
    resetFidget();
  }
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

window.addEventListener('resize', resize, { passive: true });
window.addEventListener('orientationchange', resize, { passive: true });

window.addEventListener('keydown', (event) => {
  if (event.key === '0') {
    resetFidget();
  }
});

window.addEventListener('devicemotion', handleDeviceMotion, { passive: true });

resize();
