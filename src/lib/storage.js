const APP_KEY = 'truchet-fidget:v1';

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (_) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (_) {
    // Private mode or quota failures should not break the app.
  }
}

export function storageKeyForEdits(tilesetId) {
  return `${APP_KEY}:tileset:${tilesetId}:edits`;
}

export function loadEdits(tilesetId, tileCount) {
  const entries = readJson(storageKeyForEdits(tilesetId), []);
  const map = new Map();

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [key, delta] = entry;
    const cleanDelta = Number(delta) % tileCount;
    if (typeof key === 'string' && cleanDelta > 0) map.set(key, cleanDelta);
  }

  return map;
}

export function saveEdits(tilesetId, edits) {
  writeJson(storageKeyForEdits(tilesetId), [...edits]);
}
