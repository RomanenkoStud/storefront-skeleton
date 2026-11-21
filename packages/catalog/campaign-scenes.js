// Campaign band scene presets (ADR-0015 Decisions 1 and 2). Pure ESM, no DOM; imported by the Worker and the web app.
// Every box is in percent of the band's art box (.campaign-art). Slot order is rank (slot 1 is the hero).
// Slot = { x, y, w, h, z, r }: top-left, size, paint order, rotation in degrees (CSS rotate, clockwise).
// Layouts are keyed by picture count; the band uses the largest key <= pictures (sceneLayout).

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};
const s = (x, y, w, h, z = 1, r = 0) => ({ x, y, w, h, z, r });
const wall = { src: '/editorial/campaign-wall.webp', srcSet: '/editorial/campaign-wall-800.webp 800w, /editorial/campaign-wall.webp 1600w', width: 1600, height: 900, position: { desktop: 'right center', mobile: '72% center' } };
const floorBg = { src: '/editorial/campaign-floor.webp', srcSet: '/editorial/campaign-floor-800.webp 800w, /editorial/campaign-floor.webp 1600w', width: 1600, height: 900, position: { desktop: 'right center', mobile: '72% center' } };

export const DEFAULT_SCENE_ID = 'fan';
export const SCENE_ALIASES = deepFreeze({}); // renamed scene id -> current id

export const SCENES = deepFreeze([
  {
    id: 'fan', label: 'Віяло', anchor: 'bottom', background: wall, available: true, props: [],
    layouts: {
      3: {
        desktop: [s(26, 0, 48, 106, 3), s(1, 12, 36, 92, 1, -8), s(64, 16, 31, 86, 2, 8)],
        mobile: [s(27, 0, 46, 104, 3), s(0, 12, 36, 90, 1, -8), s(64, 14, 36, 88, 2, 8)],
      },
      2: { desktop: [s(38, 0, 50, 106, 2), s(6, 12, 38, 92, 1, -7)], mobile: [s(40, 0, 52, 104, 2), s(2, 12, 40, 90, 1, -7)] },
      1: { desktop: [s(22, 0, 56, 106, 1)], mobile: [s(22, 0, 56, 104, 1)] },
    },
  },
  {
    id: 'rail', label: 'Рейл', anchor: 'top', background: wall, available: true,
    props: [{ kind: 'rail', desktop: { x: 0.5, y: 8, w: 95 }, mobile: { x: 0.5, y: 9.5, w: 99 } }],
    layouts: {
      3: {
        desktop: [s(33, 6.5, 34, 96, 1), s(1.5, 6.5, 30, 84, 1), s(67, 6.5, 28, 84, 1)],
        mobile: [s(33, 8, 34, 92, 1), s(0.5, 8, 31, 80, 1), s(68.5, 8, 31, 80, 1)],
      },
      2: { desktop: [s(50, 7, 32, 88, 1), s(14, 7, 32, 80, 1)], mobile: [s(51, 8, 40, 88, 1), s(8, 8, 40, 80, 1)] },
      1: { desktop: [s(32, 7, 36, 90, 1)], mobile: [s(28, 8, 44, 90, 1)] },
    },
  },
  {
    id: 'hooks', label: 'Гачки', anchor: 'top', background: wall, available: true, props: [{ kind: 'hooks' }],
    layouts: {
      4: {
        desktop: [s(26, 18, 26, 84, 1), s(1, 6, 24, 76, 1), s(52, 2, 22, 74, 1), s(74, 16, 21, 72, 1)],
        mobile: [s(33.5, 22, 33, 82, 1), s(0.5, 6, 32, 74, 1), s(67.5, 2, 32, 72, 1)],
      },
      3: {
        desktop: [s(33, 18, 34, 90, 1), s(2, 6, 30, 80, 1), s(68, 2, 27, 78, 1)],
        mobile: [s(33.5, 22, 33, 82, 1), s(0.5, 6, 32, 74, 1), s(67.5, 2, 32, 72, 1)],
      },
      2: { desktop: [s(50, 18, 32, 78, 1), s(14, 6, 32, 76, 1)], mobile: [s(51, 18, 40, 78, 1), s(8, 4, 40, 76, 1)] },
      1: { desktop: [s(32, 8, 36, 88, 1)], mobile: [s(28, 6, 44, 88, 1)] },
    },
  },
  {
    id: 'floor', label: 'Флет-лей', anchor: 'center', background: floorBg, available: false, props: [],
    layouts: {
      3: {
        desktop: [s(30, 2, 40, 100, 2, 4), s(2, 8, 34, 88, 1, -14), s(64, 10, 32, 84, 1, 16)],
        mobile: [s(30, 0, 40, 100, 2, 4), s(0, 6, 36, 90, 1, -14), s(64, 8, 36, 88, 1, 16)],
      },
      2: { desktop: [s(46, 4, 38, 92, 2, 6), s(10, 8, 36, 84, 1, -12)], mobile: [s(48, 2, 44, 96, 2, 6), s(6, 6, 42, 88, 1, -12)] },
      1: { desktop: [s(28, 4, 44, 92, 1, -6)], mobile: [s(24, 2, 52, 96, 1, -6)] },
    },
  },
]);

export const SCENE_IDS = Object.freeze(SCENES.map(scene => scene.id));

export function getScene(id) {
  if (typeof id !== 'string') return null;
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const resolved = own(SCENE_ALIASES, id) ? SCENE_ALIASES[id] : id;
  return SCENES.find(scene => scene.id === resolved) || null;
}

// Largest layout whose key is <= count; null when count < 1 or the scene has no such layout.
export function sceneLayout(scene, count) {
  if (!scene || !scene.layouts || typeof count !== 'number' || Number.isNaN(count)) return null;
  const n = Math.floor(count);
  const key = Object.keys(scene.layouts).map(Number).filter(k => k <= n).sort((a, b) => b - a)[0];
  return key === undefined ? null : scene.layouts[key];
}

const REFERENCE_ART = { desktop: [[756, 496], [580, 496]], mobile: [[390, 270]] };

// Bounding box of the slot after CSS rotate(r) about the anchor origin: top centre (top), bottom centre (bottom),
// box centre (center). Screen coordinates, y down, positive r clockwise.
function rotatedBox(slot, anchor, W, H) {
  const x = slot.x / 100 * W, y = slot.y / 100 * H, w = slot.w / 100 * W, h = slot.h / 100 * H;
  const ox = x + w / 2, oy = anchor === 'top' ? y : anchor === 'bottom' ? y + h : y + h / 2;
  const a = slot.r * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
  const xs = [], ys = [];
  for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
    const dx = px - ox, dy = py - oy;
    xs.push(ox + dx * cos - dy * sin); ys.push(oy + dx * sin + dy * cos);
  }
  return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
}

// Protected core: centred third of the (unrotated) width over the 70% of the height nearest the anchor.
function core(slot, anchor, W, H) {
  const x = slot.x / 100 * W, y = slot.y / 100 * H, w = slot.w / 100 * W, h = slot.h / 100 * H;
  const t = anchor === 'bottom' ? y + h * 0.3 : anchor === 'top' ? y : y + h * 0.15;
  return { l: x + w / 3, r: x + 2 * w / 3, t, b: t + h * 0.7 };
}
const hit = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;

export function sceneViolations(scene) {
  const out = [];
  for (const [count, layout] of Object.entries(scene.layouts)) for (const mode of ['desktop', 'mobile']) {
    const slots = layout[mode];
    slots.forEach((t, i) => {
      if (t.x < 0 || t.x + t.w > 100 || t.y < 0 || t.y + t.h > 112 || Math.abs(t.r) > 18) out.push(`${scene.id} ${count} ${mode}: slot ${i + 1} out of bounds`);
    });
    for (const [W, H] of REFERENCE_ART[mode]) slots.forEach((low, i) => slots.forEach((high, j) => {
      if (i === j || high.z < low.z || (high.z === low.z && j < i)) return;
      if (hit(rotatedBox(high, scene.anchor, W, H), core(low, scene.anchor, W, H))) out.push(`${scene.id} ${count} ${mode} ${W}x${H}: slot ${j + 1} covers the core of slot ${i + 1}`);
    }));
  }
  return out;
}
