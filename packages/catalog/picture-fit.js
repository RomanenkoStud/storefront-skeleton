/**
 * Pure picture-fit module (docs/MEDIA.md "Picture normalization (fit)").
 *
 * No DOM, I/O, randomness, clock or globals. Runs in Node, browser workers and the Worker.
 *
 * Conventions (interpretations of the spec where it was silent or ambiguous):
 * - Pixel (x, y) occupies the square [x, x+1) x [y, y+1). Canvas axes: x right, y down.
 * - Angles are in degrees, positive = clockwise on screen (y down). A direction at angle a
 *   rotated by theta ends up at a + theta.
 * - `minRect.angleDeg` is the angle of the long side of the minimum-area rectangle, in (-90, 90].
 * - `analysisScale` is the integer box-downsample factor used for analysis (1 = full size).
 *   All MaskAnalysis coordinates are already in source pixels. MaskAnalysis numbers are not rounded;
 *   only FitResult numbers are rounded to 4 decimals.
 * - `mainShare` and `droppedFraction` are shares of the total hard-foreground pixel count.
 * - The extent set is the kept components grown through every connected pixel with alpha >= softThreshold
 *   (so multi-pixel soft ramps are included). `bbox` and `hull` (convex hull in source pixels, built from
 *   pixel corners of per-row extremes, so its size is bounded by the image height) describe that set;
 *   `computeFit` measures rotated extent from `hull`, never from bbox corners.
 * - `softFraction` = share of semi-transparent pixels (alpha below SEMI_OPAQUE) in the extent set.
 * - `edgeContact.*` = fraction (0..1) of that border's length where a kept component touches it.
 * - `LIMIT_TOLERANCE_DEG`: rotation-over-limit only triggers beyond maxCorrectionDeg + 0.25 deg (estimate noise).
 * - Manual rotate/scale are folded into the transform before anchor alignment, so the anchor stays aligned
 *   (the net pivot is the anchor point of the placed extent). Manual offsets are added last, then the
 *   translation is clamped so at least 1 px of the placed extent stays on the canvas (validateFitRecipe requires
 *   overlap; the anchor alignment check allows for this clamp). Manual scale
 *   multiplies the automatic (capped) scale, is exempt from maxUpscale, and is clamped so the rotated extent fits the canvas. `placedBox` is the bounding box of the transformed hull.
 * - Transform: x' = tx + s*(x*cos(t) - y*sin(t)), y' = ty + s*(x*sin(t) + y*cos(t)), where t is the total
 *   rotation (auto correction + manual). Matrix = [s cos t, s sin t, -s sin t, s cos t, tx, ty].
 */

export const FIT_VERSION = 1;

const ANALYSIS_DEFAULTS = Object.freeze({
  alphaThreshold: 128,
  softThreshold: 16,
  minComponentFraction: 0.05,
  maxAnalysisPixels: 4_194_304
});
const MANUAL_LIMITS = Object.freeze({ rotate: 45, scaleMin: 0.5, scaleMax: 2, offset: 0.25 });
const EMPTY_FRACTION = 0.005;
const FRAGMENTED_FRACTION = 0.02;
const EDGE_CONTACT_FRACTION = 0.02;
const SOFT_MASK_FRACTION = 0.15;
const MULTIPLE_MAIN_SHARE = 0.9;
const ASPECT_MISMATCH_RATIO = 2.5;
const SKIP_CORRECTION_DEG = 0.5;
const LIMIT_TOLERANCE_DEG = 0.25; // estimate noise allowance so a true 20 degree tilt is not rejected by a 20 degree limit
const SEMI_OPAQUE = 240;
const FLAG_WEIGHTS = Object.freeze({
  'empty-mask': 1,
  'multiple-objects': 0.3,
  fragmented: 0.2,
  'edge-clipped': 0.3,
  'rotation-ambiguous': 0.15,
  'rotation-over-limit': 0.3,
  'aspect-mismatch': 0.2,
  upscaled: 0.2,
  'soft-mask': 0.15
});
const MAX_RECIPE_JSON = 1024; // R2 customMetadata must also hold other keys within 2 KB

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round4 = (value) => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return rounded === 0 ? 0 : rounded;
};
const RAD = Math.PI / 180;

/** Normalizes an axis-less line angle to (-90, 90]. */
function normalizeLineAngle(degrees) {
  let a = degrees;
  while (a <= -90) a += 180;
  while (a > 90) a -= 180;
  return a;
}

function resolveOptions(options) {
  if (options === null || typeof options !== 'object') throw new TypeError('options must be an object');
  const o = { ...ANALYSIS_DEFAULTS };
  for (const key of Object.keys(ANALYSIS_DEFAULTS)) if (options[key] !== undefined) o[key] = options[key];
  if (!Number.isInteger(o.alphaThreshold) || o.alphaThreshold < 1 || o.alphaThreshold > 255) throw new RangeError('alphaThreshold must be an integer 1..255');
  if (!Number.isInteger(o.softThreshold) || o.softThreshold < 1 || o.softThreshold > o.alphaThreshold) throw new RangeError('softThreshold must be an integer 1..alphaThreshold');
  if (!finite(o.minComponentFraction) || o.minComponentFraction < 0 || o.minComponentFraction > 1) throw new RangeError('minComponentFraction must be 0..1');
  if (!Number.isInteger(o.maxAnalysisPixels) || o.maxAnalysisPixels < 1) throw new RangeError('maxAnalysisPixels must be a positive integer');
  return o;
}

function checkSource(source) {
  if (!source || typeof source !== 'object') throw new TypeError('source must be an object');
  const { width, height, data, channels } = source;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new RangeError('source width/height must be positive integers');
  if (channels !== 1 && channels !== 4) throw new RangeError('source channels must be 1 or 4');
  if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray)) throw new TypeError('source data must be a Uint8Array or Uint8ClampedArray');
  if (data.length < width * height * channels) throw new RangeError('source data is shorter than width*height*channels');
  return { width, height, data, channels };
}

/** Deterministic integer box downsample of the alpha channel to at most maxPixels. */
function extractAlpha({ width, height, data, channels }, maxPixels) {
  let k = 1;
  while (Math.ceil(width / k) * Math.ceil(height / k) > maxPixels) k++;
  const w = Math.ceil(width / k);
  const h = Math.ceil(height / k);
  const alpha = new Uint8Array(w * h);
  if (k === 1) {
    if (channels === 1) alpha.set(data.subarray(0, w * h));
    else for (let i = 0, n = w * h; i < n; i++) alpha[i] = data[i * 4 + 3];
    return { alpha, w, h, k };
  }
  for (let y = 0; y < h; y++) {
    const y0 = y * k;
    const y1 = Math.min(y0 + k, height);
    for (let x = 0; x < w; x++) {
      const x0 = x * k;
      const x1 = Math.min(x0 + k, width);
      let sum = 0;
      for (let yy = y0; yy < y1; yy++) {
        let index = (yy * width + x0) * channels + (channels === 4 ? 3 : 0);
        for (let xx = x0; xx < x1; xx++, index += channels) sum += data[index];
      }
      alpha[y * w + x] = Math.floor(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return { alpha, w, h, k };
}

function emptyAnalysis(width, height, k, foregroundFraction, componentCount) {
  return {
    width, height, analysisScale: k, foregroundFraction, componentCount, keptComponents: 0,
    mainShare: 0, droppedFraction: 0, softFraction: 0,
    bbox: { x: 0, y: 0, w: 0, h: 0 }, hull: [], centroid: { x: 0, y: 0 },
    minRect: { angleDeg: 0, long: 0, short: 0, elongation: 1 },
    pca: { angleDeg: 0, eccentricity: 0 },
    edgeContact: { top: 0, right: 0, bottom: 0, left: 0 }
  };
}

function convexHull(points) {
  const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const unique = [];
  for (const p of pts) if (!unique.length || unique.at(-1)[0] !== p[0] || unique.at(-1)[1] !== p[1]) unique.push(p);
  if (unique.length < 3) return unique;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Minimum-area enclosing rectangle by testing every hull edge direction. */
function minAreaRect(hull) {
  if (hull.length < 3) return null;
  let best = null;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const ux = dx / length;
    const uy = dy / length;
    let minS = Infinity, maxS = -Infinity, minT = Infinity, maxT = -Infinity;
    for (const p of hull) {
      const s = p[0] * ux + p[1] * uy;
      const t = -p[0] * uy + p[1] * ux;
      if (s < minS) minS = s;
      if (s > maxS) maxS = s;
      if (t < minT) minT = t;
      if (t > maxT) maxT = t;
    }
    const lenU = maxS - minS;
    const lenN = maxT - minT;
    const area = lenU * lenN;
    if (!best || area < best.area - 1e-9) {
      const phi = Math.atan2(uy, ux) / RAD;
      best = lenU >= lenN
        ? { area, angle: normalizeLineAngle(phi), long: lenU, short: lenN }
        : { area, angle: normalizeLineAngle(phi + 90), long: lenN, short: lenU };
    }
  }
  return best;
}

/**
 * Analyses an alpha mask. See the file header for conventions.
 * @param {{width:number,height:number,data:Uint8Array|Uint8ClampedArray,channels:1|4}} source
 * @param {{alphaThreshold?:number,softThreshold?:number,minComponentFraction?:number,maxAnalysisPixels?:number}} [options]
 */
export function analyzeMask(source, options = {}) {
  const src = checkSource(source);
  const opt = resolveOptions(options);
  const { alpha, w, h, k } = extractAlpha(src, opt.maxAnalysisPixels);
  const n = w * h;
  const T = opt.alphaThreshold;

  // 8-connected components via iterative flood fill.
  const labels = new Int32Array(n);
  const stack = new Int32Array(n);
  const areas = [0];
  let totalFg = 0;
  for (let i = 0; i < n; i++) {
    if (alpha[i] < T || labels[i]) continue;
    const label = areas.length;
    let area = 0;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = label;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (alpha[q] >= T && !labels[q]) { labels[q] = label; stack[sp++] = q; }
        }
      }
    }
    areas.push(area);
    totalFg += area;
  }
  const componentCount = areas.length - 1;
  const foregroundFraction = totalFg / n;
  if (componentCount === 0) return emptyAnalysis(src.width, src.height, k, 0, 0);

  let largest = 1;
  for (let l = 2; l < areas.length; l++) if (areas[l] > areas[largest]) largest = l;
  const largestArea = areas[largest];
  const kept = new Uint8Array(areas.length);
  let keptComponents = 0;
  let keptArea = 0;
  for (let l = 1; l < areas.length; l++) {
    if (areas[l] >= opt.minComponentFraction * largestArea) { kept[l] = 1; keptComponents++; keptArea += areas[l]; }
  }

  // Grow the kept set through soft-threshold pixels (multi-pixel alpha ramps).
  const S = opt.softThreshold;
  const grown = new Uint8Array(n);
  let sp0 = 0;
  for (let i = 0; i < n; i++) if (labels[i] !== 0 && kept[labels[i]]) stack[sp0++] = i;
  while (sp0 > 0) {
    const p = stack[--sp0];
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const q = yy * w + xx;
        if (labels[q] === 0 && !grown[q] && alpha[q] >= S) { grown[q] = 1; stack[sp0++] = q; }
      }
    }
  }

  let minX = w, minY = h, maxX = -1, maxY = -1;
  let sumX = 0, sumY = 0;
  let top = 0, bottom = 0, left = 0, right = 0;
  let mx = 0, my = 0, mxx = 0, myy = 0, mxy = 0;
  const rowMin = new Int32Array(h).fill(-1);
  const rowMax = new Int32Array(h).fill(-1);
  const allMin = new Int32Array(h).fill(w);
  const allMax = new Int32Array(h).fill(-1);
  let softSet = 0, semi = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const l = labels[p];
      if (l !== 0) {
        if (!kept[l]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        sumX += x + 0.5;
        sumY += y + 0.5;
        if (y === 0) top++;
        if (y === h - 1) bottom++;
        if (x === 0) left++;
        if (x === w - 1) right++;
        if (x < allMin[y]) allMin[y] = x;
        if (x > allMax[y]) allMax[y] = x;
        softSet++;
        if (alpha[p] < SEMI_OPAQUE) semi++;
        if (l === largest) {
          if (rowMin[y] < 0) rowMin[y] = x;
          rowMax[y] = x;
          const cx = x + 0.5, cy = y + 0.5;
          mx += cx; my += cy; mxx += cx * cx; myy += cy * cy; mxy += cx * cy;
        }
      } else if (grown[p]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x < allMin[y]) allMin[y] = x;
        if (x > allMax[y]) allMax[y] = x;
        softSet++;
        if (alpha[p] < SEMI_OPAQUE) semi++;
      }
    }
  }

  // PCA (confidence signal only) on the largest component.
  const meanX = mx / largestArea, meanY = my / largestArea;
  const u20 = mxx / largestArea - meanX * meanX;
  const u02 = myy / largestArea - meanY * meanY;
  const u11 = mxy / largestArea - meanX * meanY;
  const half = (u20 + u02) / 2;
  const root = Math.sqrt(((u20 - u02) / 2) ** 2 + u11 ** 2);
  const l1 = half + root;
  const l2 = Math.max(0, half - root);
  const pca = {
    angleDeg: l1 > 1e-12 ? normalizeLineAngle(0.5 * Math.atan2(2 * u11, u20 - u02) / RAD) : 0,
    eccentricity: l1 > 1e-12 ? l2 / l1 : 0
  };

  // Hull from per-row extremes (pixel corners) of the largest component, then min-area rectangle.
  const points = [];
  for (let y = 0; y < h; y++) {
    if (rowMin[y] < 0) continue;
    const a = rowMin[y], b = rowMax[y] + 1;
    points.push([a, y], [a, y + 1], [b, y], [b, y + 1]);
  }
  const rect = minAreaRect(convexHull(points));
  const minRect = rect
    ? { angleDeg: rect.angle, long: rect.long * k, short: rect.short * k, elongation: rect.long / rect.short }
    : { angleDeg: 0, long: 0, short: 0, elongation: 1 };

  // Hull of the kept-component union at softThreshold (pixel corners of per-row extremes), source pixels.
  const unionPoints = [];
  for (let y = 0; y < h; y++) {
    if (allMax[y] < 0) continue;
    const a = allMin[y] * k, b = Math.min((allMax[y] + 1) * k, src.width);
    const ya = y * k, yb = Math.min((y + 1) * k, src.height);
    unionPoints.push([a, ya], [a, yb], [b, ya], [b, yb]);
  }
  const hull = convexHull(unionPoints);

  const x0 = minX * k, y0 = minY * k;
  return {
    width: src.width, height: src.height, analysisScale: k,
    foregroundFraction, componentCount, keptComponents,
    mainShare: largestArea / totalFg,
    droppedFraction: (totalFg - keptArea) / totalFg,
    softFraction: softSet ? semi / softSet : 0,
    bbox: { x: x0, y: y0, w: Math.min((maxX + 1) * k, src.width) - x0, h: Math.min((maxY + 1) * k, src.height) - y0 },
    hull,
    centroid: { x: (sumX / keptArea) * k, y: (sumY / keptArea) * k },
    minRect,
    pca,
    edgeContact: { top: top / w, right: right / h, bottom: bottom / w, left: left / h }
  };
}

function resolveManual(manual) {
  if (manual === null || manual === undefined) return null;
  if (typeof manual !== 'object') throw new TypeError('manual must be an object or null');
  const m = {
    rotateDeg: manual.rotateDeg ?? 0,
    scale: manual.scale ?? 1,
    offsetX: manual.offsetX ?? 0,
    offsetY: manual.offsetY ?? 0
  };
  for (const [key, value] of Object.entries(m)) if (!finite(value)) throw new RangeError(`manual.${key} must be a finite number`);
  if (Math.abs(m.rotateDeg) > MANUAL_LIMITS.rotate) throw new RangeError('manual.rotateDeg must be within +-45');
  if (m.scale < MANUAL_LIMITS.scaleMin || m.scale > MANUAL_LIMITS.scaleMax) throw new RangeError('manual.scale must be within 0.5..2');
  if (Math.abs(m.offsetX) > MANUAL_LIMITS.offset || Math.abs(m.offsetY) > MANUAL_LIMITS.offset) throw new RangeError('manual offsets must be within +-0.25');
  return m;
}

function checkTemplate(t) {
  const ok = t && typeof t === 'object' && typeof t.id === 'string' && Number.isInteger(t.revision) && t.revision > 0
    && t.canvas && finite(t.canvas.width) && finite(t.canvas.height) && t.canvas.width > 0 && t.canvas.height > 0
    && t.box && ['x', 'y', 'w', 'h'].every((key) => finite(t.box[key])) && t.box.w > 0 && t.box.h > 0
    && t.box.x >= 0 && t.box.y >= 0 && t.box.x + t.box.w <= 1 + 1e-9 && t.box.y + t.box.h <= 1 + 1e-9
    && t.anchor && finite(t.anchor.x) && finite(t.anchor.y)
    && t.scale && ['contain', 'width', 'height', 'area'].includes(t.scale.mode) && finite(t.scale.maxUpscale) && t.scale.maxUpscale > 0
    && t.orientation && ['horizontal', 'vertical', 'none'].includes(t.orientation.axis);
  if (!ok) throw new TypeError('template is not a valid picture template');
  if (t.scale.mode === 'area' && !(finite(t.scale.areaFraction) && t.scale.areaFraction > 0)) throw new TypeError('area scale mode needs areaFraction');
  return t;
}

/**
 * Computes the placement recipe from an analysis and a template.
 * @returns {object} FitResult (JSON-serializable, 4-decimal numbers)
 */
export function computeFit(analysis, template, manual = null) {
  checkTemplate(template);
  if (!analysis || !analysis.bbox || !analysis.minRect) throw new TypeError('analysis must come from analyzeMask');
  let man = resolveManual(manual);
  const cw = template.canvas.width, ch = template.canvas.height;
  const flags = [];
  const result = (transform, placedBox) => {
    const t = transform.rotateDeg * RAD;
    const cos = Math.cos(t), sin = Math.sin(t), s = transform.scale;
    const score = Math.max(0, 1 - flags.reduce((sum, flag) => sum + FLAG_WEIGHTS[flag], 0));
    return {
      fitVersion: FIT_VERSION,
      templateId: template.id,
      templateRevision: template.revision,
      canvas: { width: cw, height: ch },
      transform: {
        rotateDeg: round4(transform.rotateDeg), scale: round4(s),
        translateX: round4(transform.translateX), translateY: round4(transform.translateY)
      },
      matrix: [s * cos, s * sin, -s * sin, s * cos, transform.translateX, transform.translateY].map(round4),
      manual: man ? { rotateDeg: round4(man.rotateDeg), scale: round4(man.scale), offsetX: round4(man.offsetX), offsetY: round4(man.offsetY) } : null,
      placedBox: { x: round4(placedBox.x), y: round4(placedBox.y), w: round4(placedBox.w), h: round4(placedBox.h) },
      quality: {
        level: flags.includes('empty-mask') ? 'unsupported' : flags.length ? 'review' : 'ok',
        flags: [...flags],
        score: round4(score)
      }
    };
  };

  if (analysis.foregroundFraction < EMPTY_FRACTION || analysis.bbox.w <= 0 || analysis.bbox.h <= 0) {
    flags.push('empty-mask');
    man = null; // an unsupported recipe is always the identity placement
    return result({ rotateDeg: 0, scale: 1, translateX: 0, translateY: 0 }, { x: 0, y: 0, w: 0, h: 0 });
  }

  // Rotation correction.
  const { axis, maxCorrectionDeg = 0, minElongation = 1.15 } = template.orientation;
  const { angleDeg, elongation } = analysis.minRect;
  let correction = 0;
  if (axis !== 'none') {
    if (elongation < minElongation) flags.push('rotation-ambiguous');
    else {
      const wanted = axis === 'horizontal' ? -angleDeg : (angleDeg < 0 ? -90 : 90) - angleDeg;
      if (Math.abs(wanted) > maxCorrectionDeg + LIMIT_TOLERANCE_DEG) flags.push('rotation-over-limit');
      else if (Math.abs(wanted) >= SKIP_CORRECTION_DEG) correction = wanted;
    }
  }
  const rotateDeg = correction + (man ? man.rotateDeg : 0);

  // Rotated extent (unit scale) of the kept-component hull, not of the axis-aligned bbox (which
  // overestimates tilted objects).
  const t = rotateDeg * RAD;
  const cos = Math.cos(t), sin = Math.sin(t);
  const { x: bx0, y: by0, w: bw0, h: bh0 } = analysis.bbox;
  let rx0 = Infinity, ry0 = Infinity, rx1 = -Infinity, ry1 = -Infinity;
  const extentPoints = Array.isArray(analysis.hull) && analysis.hull.length >= 3
    ? analysis.hull
    : [[bx0, by0], [bx0 + bw0, by0], [bx0, by0 + bh0], [bx0 + bw0, by0 + bh0]];
  for (const [px, py] of extentPoints) {
    const x = px * cos - py * sin;
    const y = px * sin + py * cos;
    if (x < rx0) rx0 = x;
    if (x > rx1) rx1 = x;
    if (y < ry0) ry0 = y;
    if (y > ry1) ry1 = y;
  }
  const rw = rx1 - rx0, rh = ry1 - ry0;

  // Scale.
  const box = { x: template.box.x * cw, y: template.box.y * ch, w: template.box.w * cw, h: template.box.h * ch };
  const contain = Math.min(box.w / rw, box.h / rh);
  let scale;
  switch (template.scale.mode) {
    case 'width': scale = Math.min(box.w / rw, contain); break;
    case 'height': scale = Math.min(box.h / rh, contain); break;
    case 'area': {
      const keptPixels = analysis.foregroundFraction * (1 - analysis.droppedFraction) * analysis.width * analysis.height;
      scale = Math.min(Math.sqrt(template.scale.areaFraction * box.w * box.h / keptPixels), contain);
      break;
    }
    default: scale = contain;
  }
  if (scale > template.scale.maxUpscale) { scale = template.scale.maxUpscale; flags.push('upscaled'); }
  // Manual scale multiplies the automatic scale (exempt from maxUpscale) but stays contained by the canvas.
  if (man) scale = Math.min(scale * man.scale, cw / rw, ch / rh);

  // Anchor placement, manual offsets last.
  const pw = rw * scale, ph = rh * scale;
  const ax = template.anchor.x, ay = template.anchor.y;
  const targetX = box.x + ax * box.w, targetY = box.y + ay * box.h;
  let translateX = targetX - (rx0 * scale + ax * pw) + (man ? man.offsetX * cw : 0);
  let translateY = targetY - (ry0 * scale + ay * ph) + (man ? man.offsetY * ch : 0);
  // Keep at least 1 px of the placed extent on the canvas, so every valid manual input yields a valid recipe.
  const visible = Math.min(1, pw, ph);
  const px0 = rx0 * scale + translateX, py0 = ry0 * scale + translateY;
  if (px0 + pw < visible) translateX += visible - (px0 + pw);
  else if (px0 > cw - visible) translateX -= px0 - (cw - visible);
  if (py0 + ph < visible) translateY += visible - (py0 + ph);
  else if (py0 > ch - visible) translateY -= py0 - (ch - visible);
  const placedBox = { x: rx0 * scale + translateX, y: ry0 * scale + translateY, w: pw, h: ph };

  // Remaining flags.
  if (template.multipleObjects === 'flag' && analysis.keptComponents >= 2 && analysis.mainShare < MULTIPLE_MAIN_SHARE) flags.push('multiple-objects');
  if (analysis.droppedFraction > FRAGMENTED_FRACTION) flags.push('fragmented');
  if (Object.values(analysis.edgeContact).some((v) => v > EDGE_CONTACT_FRACTION)) flags.push('edge-clipped');
  const aspectRatio = (rw / rh) / (box.w / box.h);
  if (aspectRatio > ASPECT_MISMATCH_RATIO || aspectRatio < 1 / ASPECT_MISMATCH_RATIO) flags.push('aspect-mismatch');
  if (analysis.softFraction > SOFT_MASK_FRACTION) flags.push('soft-mask');
  const order = Object.keys(FLAG_WEIGHTS);
  flags.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  return result({ rotateDeg, scale, translateX, translateY }, placedBox);
}

/** analyzeMask + computeFit. Options other than `manual` go to analyzeMask. */
export function fitPicture(source, template, { manual = null, ...analysisOptions } = {}) {
  return computeFit(analyzeMask(source, analysisOptions), template, manual);
}

/** UTF-8 byte length without TextEncoder (keeps the module free of globals). */
function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) { bytes += 4; i++; }
    else bytes += 3;
  }
  return bytes;
}
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function exactKeys(value, keys, what) {
  if (!isPlain(value)) throw new TypeError(`${what} must be a plain object`);
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw new TypeError(`${what} must have exactly the keys ${keys.join(', ')}`);
}
const numbers = (value, keys, what) => {
  for (const key of keys) if (!finite(value[key])) throw new TypeError(`${what}.${key} must be a finite number`);
};

/**
 * Worker-side strict check of a persisted recipe against the current template. The recipe must be exactly
 * the shape `computeFit` produces for this template id and revision: no unknown keys at any level, no
 * arrays where objects are expected, unique whitelisted flags, a level consistent with the flags, a score
 * consistent with the flags, and a placedBox whose anchor point matches the template anchor (plus manual
 * offsets) and whose size respects contain and the manual scale. The serialized size is checked first
 * (max 1024 UTF-8 bytes). Throws TypeError (structure) or RangeError (bounds). Returns a canonical copy
 * built only from validated fields (numbers rounded to 4 decimals, score recomputed); store that, not the input.
 * Limitation: the recipe has no mask or hull, so the transform cannot be verified against the real foreground.
 * Only consistency with the template (anchor, size, rotation, scale), the matrix and plausibility bounds
 * (placedBox overlaps the canvas; there is no absolute translation bound because translation scales with the source size) are checked.
 */
export function validateFitRecipe(recipe, template) {
  checkTemplate(template);
  let json;
  try { json = JSON.stringify(recipe); } catch { throw new TypeError('recipe is not serializable'); }
  if (typeof json !== 'string') throw new TypeError('recipe must be a JSON object');
  if (utf8Length(json) > MAX_RECIPE_JSON) throw new RangeError('recipe is too large');
  exactKeys(recipe, ['fitVersion', 'templateId', 'templateRevision', 'canvas', 'transform', 'matrix', 'manual', 'placedBox', 'quality'], 'recipe');
  if (recipe.fitVersion !== FIT_VERSION) throw new RangeError('unsupported fitVersion');
  if (recipe.templateId !== template.id) throw new RangeError('recipe templateId does not match the template');
  if (recipe.templateRevision !== template.revision) throw new RangeError('recipe templateRevision does not match the template');
  const { canvas, transform, matrix, manual, placedBox, quality } = recipe;
  exactKeys(canvas, ['width', 'height'], 'canvas');
  if (canvas.width !== template.canvas.width || canvas.height !== template.canvas.height) throw new RangeError('recipe canvas does not match the template');
  exactKeys(transform, ['rotateDeg', 'scale', 'translateX', 'translateY'], 'transform');
  numbers(transform, ['rotateDeg', 'scale', 'translateX', 'translateY'], 'transform');
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(finite)) throw new TypeError('recipe matrix is malformed');
  let man = null;
  if (manual !== null) {
    exactKeys(manual, ['rotateDeg', 'scale', 'offsetX', 'offsetY'], 'manual');
    numbers(manual, ['rotateDeg', 'scale', 'offsetX', 'offsetY'], 'manual');
    man = resolveManual(manual);
  }
  exactKeys(placedBox, ['x', 'y', 'w', 'h'], 'placedBox');
  numbers(placedBox, ['x', 'y', 'w', 'h'], 'placedBox');
  if (placedBox.w < 0 || placedBox.h < 0) throw new TypeError('recipe placedBox has a negative size');
  exactKeys(quality, ['level', 'flags', 'score'], 'quality');
  if (!Array.isArray(quality.flags) || !quality.flags.every((flag) => typeof flag === 'string' && Object.hasOwn(FLAG_WEIGHTS, flag))) throw new TypeError('recipe quality flags are malformed');
  if (new Set(quality.flags).size !== quality.flags.length) throw new TypeError('recipe quality flags must be unique');
  if (!finite(quality.score)) throw new TypeError('recipe quality score is malformed');
  const empty = quality.flags.includes('empty-mask');
  const level = empty ? 'unsupported' : quality.flags.length ? 'review' : 'ok';
  if (quality.level !== level) throw new TypeError('recipe quality level is inconsistent with its flags');
  const flags = Object.keys(FLAG_WEIGHTS).filter((flag) => quality.flags.includes(flag));
  const score = round4(Math.max(0, 1 - flags.reduce((sum, flag) => sum + FLAG_WEIGHTS[flag], 0)));
  if (Math.abs(quality.score - score) > 1e-3) throw new RangeError('recipe quality score is inconsistent with its flags');

  const { width: cw, height: ch } = template.canvas;
  if (empty) {
    if (flags.length !== 1 || transform.rotateDeg !== 0 || transform.scale !== 1 || transform.translateX !== 0 || transform.translateY !== 0
      || placedBox.x !== 0 || placedBox.y !== 0 || placedBox.w !== 0 || placedBox.h !== 0 || manual !== null) throw new RangeError('an unsupported recipe must be the identity placement');
  } else {
    const slack = template.orientation.axis === 'none' ? 1e-4 : (template.orientation.maxCorrectionDeg ?? 0) + LIMIT_TOLERANCE_DEG + 0.01;
    const auto = transform.rotateDeg - (man ? man.rotateDeg : 0);
    if (Math.abs(auto) > slack) throw new RangeError('recipe rotation is out of bounds');
    const manualScale = man ? man.scale : 1;
    if (!(transform.scale > 0) || transform.scale > template.scale.maxUpscale * manualScale + 1e-3) throw new RangeError('recipe scale is out of bounds');
    const box = { x: template.box.x * cw, y: template.box.y * ch, w: template.box.w * cw, h: template.box.h * ch };
    if (placedBox.w > cw + 1 || placedBox.h > ch + 1) throw new RangeError('recipe placedBox is larger than the canvas');
    if (placedBox.x >= cw || placedBox.y >= ch || placedBox.x + placedBox.w <= 0 || placedBox.y + placedBox.h <= 0) throw new RangeError('recipe placedBox does not overlap the canvas');
    if (placedBox.w > box.w * manualScale + 1 || placedBox.h > box.h * manualScale + 1) throw new RangeError('recipe placedBox is larger than the template box allows');
    // Recompute the expected position exactly as computeFit places and clamps it (visible = min(1, w, h)).
    const visible = Math.min(1, placedBox.w, placedBox.h);
    const expected = (anchor, boxPos, boxSize, size, offset, canvasSize) => {
      const unclamped = boxPos + anchor * boxSize - anchor * size + offset * canvasSize;
      return Math.min(Math.max(unclamped, visible - size), canvasSize - visible);
    };
    const expectedX = expected(template.anchor.x, box.x, box.w, placedBox.w, man ? man.offsetX : 0, cw);
    const expectedY = expected(template.anchor.y, box.y, box.h, placedBox.h, man ? man.offsetY : 0, ch);
    if (Math.abs(placedBox.x - expectedX) > 1 || Math.abs(placedBox.y - expectedY) > 1) throw new RangeError('recipe placedBox is not aligned to the template anchor');
  }
  const t = transform.rotateDeg * RAD;
  const expected = [transform.scale * Math.cos(t), transform.scale * Math.sin(t), -transform.scale * Math.sin(t), transform.scale * Math.cos(t), transform.translateX, transform.translateY];
  if (expected.some((value, i) => Math.abs(value - matrix[i]) > 2e-3)) throw new RangeError('recipe matrix does not match its transform');

  return {
    fitVersion: FIT_VERSION,
    templateId: template.id,
    templateRevision: template.revision,
    canvas: { width: cw, height: ch },
    transform: { rotateDeg: round4(transform.rotateDeg), scale: round4(transform.scale), translateX: round4(transform.translateX), translateY: round4(transform.translateY) },
    matrix: matrix.map(round4),
    manual: man ? { rotateDeg: round4(man.rotateDeg), scale: round4(man.scale), offsetX: round4(man.offsetX), offsetY: round4(man.offsetY) } : null,
    placedBox: { x: round4(placedBox.x), y: round4(placedBox.y), w: round4(placedBox.w), h: round4(placedBox.h) },
    quality: { level, flags, score }
  };
}
