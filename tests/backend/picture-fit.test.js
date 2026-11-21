import test from 'node:test';
import assert from 'node:assert/strict';
import { FIT_VERSION, analyzeMask, computeFit, fitPicture, validateFitRecipe } from '../../packages/catalog/picture-fit.js';
import { PICTURE_TEMPLATES } from '../../packages/catalog/picture-templates.js';

// Minimal template-shaped fixture (the real template module is built separately).
const template = (over = {}) => ({
  id: 'test-template', revision: 3, label: 'Test',
  canvas: { width: 1200, height: 1600 },
  box: { x: 0.06, y: 0.3, w: 0.88, h: 0.46 },
  anchor: { x: 0.5, y: 1 },
  scale: { mode: 'contain', maxUpscale: 1.5 },
  orientation: { axis: 'horizontal', maxCorrectionDeg: 20, minElongation: 1.15 },
  multipleObjects: 'allow',
  ...over
});
const vertical = (over = {}) => template({
  box: { x: 0.18, y: 0.05, w: 0.64, h: 0.9 }, anchor: { x: 0.5, y: 0 }, scale: { mode: 'height', maxUpscale: 3 },
  orientation: { axis: 'vertical', maxCorrectionDeg: 15, minElongation: 1.15 }, ...over
});

// Synthetic masks: polygons in local coordinates, rotated clockwise by angleDeg about (cx, cy).
function mask(width, height, shapes, { channels = 1 } = {}) {
  const data = new Uint8Array(width * height * channels);
  for (const { polygon, angleDeg = 0, cx, cy, alpha = 255 } of shapes) {
    const a = angleDeg * Math.PI / 180, cos = Math.cos(a), sin = Math.sin(a);
    const xs = polygon.map((p) => p[0]), ys = polygon.map((p) => p[1]);
    const mx = (Math.min(...xs) + Math.max(...xs)) / 2, my = (Math.min(...ys) + Math.max(...ys)) / 2;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      // Inverse rotation of the pixel centre into local coordinates.
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const lx = dx * cos + dy * sin + mx, ly = -dx * sin + dy * cos + my;
      let inside = false;
      for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
        if ((yi > ly) !== (yj > ly) && lx < (xj - xi) * (ly - yi) / (yj - yi) + xi) inside = !inside;
      }
      if (inside) {
        const o = (y * width + x) * channels + (channels === 4 ? 3 : 0);
        data[o] = alpha;
        if (channels === 4) { data[o - 3] = 200; data[o - 2] = 100; data[o - 1] = 50; }
      }
    }
  }
  return { width, height, data, channels };
}
const rect = (w, h) => [[0, 0], [w, 0], [w, h], [0, h]];
const shoe = [[0, 130], [250, 0], [480, 60], [800, 200], [800, 280], [0, 280]];
const W = 1400, H = 1400, C = 700;
const rectMask = (w, h, angle) => mask(W, H, [{ polygon: rect(w, h), angleDeg: angle, cx: C, cy: C }]);
const shoeMask = (angle) => mask(W, H, [{ polygon: shoe, angleDeg: angle, cx: C, cy: C }]);

// Angle of the long side after the recipe rotation: should equal the template axis.
const residual = (trueAngleDeg, fit) => trueAngleDeg + fit.transform.rotateDeg;

test('exports and version', () => {
  assert.equal(FIT_VERSION, 1);
  for (const fn of [analyzeMask, computeFit, fitPicture, validateFitRecipe]) assert.equal(typeof fn, 'function');
});

test('rectangle and shoe masks at -20..20 degrees are corrected to the horizontal axis within 0.25 degrees', () => {
  for (const angle of [-20, -17.3, -12, -7, -3, 0, 3.4, 7, 12, 19.5, 20]) {
    for (const [name, source] of [['rect', rectMask(800, 300, angle)], ['shoe', shoeMask(angle)]]) {
      const fit = fitPicture(source, template());
      assert.ok(Math.abs(residual(angle, fit)) <= 0.25, `${name} ${angle}: residual ${residual(angle, fit)}`);
      assert.equal(fit.quality.level, 'ok', `${name} ${angle}: ${fit.quality.flags}`);
    }
  }
});

test('tall rectangles are corrected to the vertical axis within 0.25 degrees', () => {
  for (const angle of [-15, -8, 5, 11, 15]) {
    const fit = fitPicture(rectMask(300, 800, angle), vertical());
    assert.ok(Math.abs(angle + fit.transform.rotateDeg) <= 0.25, `${angle}: ${fit.transform.rotateDeg}`);
  }
  const upright = fitPicture(rectMask(300, 800, 0), vertical());
  assert.equal(upright.transform.rotateDeg, 0);
  assert.deepEqual(upright.quality.flags, []);
});

test('sub-half-degree corrections are skipped and the none axis never rotates', () => {
  assert.equal(fitPicture(rectMask(800, 300, 0.3), template()).transform.rotateDeg, 0);
  const none = fitPicture(rectMask(800, 300, 12), template({ orientation: { axis: 'none', maxCorrectionDeg: 0, minElongation: 1.15 } }));
  assert.equal(none.transform.rotateDeg, 0);
  assert.deepEqual(none.quality.flags, []);
});

test('near-square shape is rotation-ambiguous with rotation 0', () => {
  const fit = fitPicture(rectMask(540, 500, 10), template());
  assert.equal(fit.transform.rotateDeg, 0);
  assert.ok(fit.quality.flags.includes('rotation-ambiguous'));
  assert.equal(fit.quality.level, 'review');
});

test('35 degrees on a 20 degree limit gives rotation-over-limit with rotation 0', () => {
  const fit = fitPicture(rectMask(800, 300, 35), template());
  assert.equal(fit.transform.rotateDeg, 0);
  assert.ok(fit.quality.flags.includes('rotation-over-limit'));
  // A horizontal object on a vertical template is a 90 degree shot.
  const ninety = fitPicture(rectMask(800, 300, 0), vertical());
  assert.equal(ninety.transform.rotateDeg, 0);
  assert.ok(ninety.quality.flags.includes('rotation-over-limit'));
});

test('stray blob and speckles are dropped at 5 percent and the angle is unchanged', () => {
  const source = mask(W, H, [
    { polygon: shoe, angleDeg: 7, cx: C, cy: C },
    { polygon: rect(40, 40), cx: 120, cy: 120 }, // 1600 px vs ~130k shoe: about 1.2%
    { polygon: rect(3, 3), cx: 1300, cy: 200 }, { polygon: rect(3, 3), cx: 1300, cy: 1300 }
  ]);
  const analysis = analyzeMask(source);
  assert.equal(analysis.componentCount, 4);
  assert.equal(analysis.keptComponents, 1);
  assert.ok(analysis.droppedFraction > 0 && analysis.droppedFraction < 0.05);
  const fit = computeFit(analysis, template());
  assert.ok(Math.abs(residual(7, fit)) <= 0.25);
  const clean = analyzeMask(shoeMask(7));
  assert.deepEqual(analysis.bbox, clean.bbox);
  assert.ok(!fit.quality.flags.includes('fragmented'));
});

test('a large dropped share raises fragmented', () => {
  const source = mask(W, H, [
    { polygon: rect(800, 300), cx: C, cy: 900 },
    { polygon: rect(180, 80), cx: 250, cy: 200 } // 6% of the main area would be kept, so use 3%.
  ]);
  const near = analyzeMask(source, { minComponentFraction: 0.05 });
  assert.equal(near.keptComponents, 2);
  const dropped = analyzeMask(source, { minComponentFraction: 0.1 });
  assert.equal(dropped.keptComponents, 1);
  assert.ok(dropped.droppedFraction > 0.02);
  assert.ok(computeFit(dropped, template()).quality.flags.includes('fragmented'));
});

test('two equal components give multiple-objects only when the template says flag', () => {
  const pair = mask(W, H, [
    { polygon: rect(500, 200), cx: 400, cy: 400 },
    { polygon: rect(500, 200), cx: 900, cy: 1000 }
  ]);
  const analysis = analyzeMask(pair);
  assert.equal(analysis.keptComponents, 2);
  assert.equal(analysis.mainShare.toFixed(2), '0.50');
  assert.ok(!computeFit(analysis, template({ multipleObjects: 'allow' })).quality.flags.includes('multiple-objects'));
  const flagged = computeFit(analysis, template({ multipleObjects: 'flag' }));
  assert.ok(flagged.quality.flags.includes('multiple-objects'));
  assert.equal(flagged.quality.level, 'review');
  // bbox spans both kept components
  assert.ok(analysis.bbox.w >= 1000 && analysis.bbox.h >= 800);
});

test('edge contact gives edge-clipped and an empty mask is unsupported', () => {
  const clipped = mask(W, H, [{ polygon: rect(800, 300), cx: 400, cy: 150 }]);
  const analysis = analyzeMask(clipped);
  assert.ok(analysis.edgeContact.top > 0.5 && analysis.edgeContact.left > 0.1);
  assert.ok(computeFit(analysis, template()).quality.flags.includes('edge-clipped'));
  assert.ok(!fitPicture(rectMask(800, 300, 0), template()).quality.flags.includes('edge-clipped'));

  const empty = fitPicture({ width: 100, height: 100, data: new Uint8Array(10000), channels: 1 }, template());
  assert.equal(empty.quality.level, 'unsupported');
  assert.deepEqual(empty.quality.flags, ['empty-mask']);
  assert.equal(empty.quality.score, 0);
  assert.deepEqual(empty.transform, { rotateDeg: 0, scale: 1, translateX: 0, translateY: 0 });
  // Under 0.5 percent foreground is also empty.
  const faint = mask(1000, 1000, [{ polygon: rect(60, 60), cx: 500, cy: 500 }]);
  assert.equal(fitPicture(faint, template()).quality.level, 'unsupported');
});

test('bottom-centre anchor lands on the box bottom and centre within 1 px', () => {
  const t = template();
  const box = { x: t.box.x * 1200, y: t.box.y * 1600, w: t.box.w * 1200, h: t.box.h * 1600 };
  for (const angle of [-14, 0, 9]) {
    const { placedBox: p } = fitPicture(shoeMask(angle), t);
    assert.ok(Math.abs(p.y + p.h - (box.y + box.h)) <= 1, `bottom ${angle}`);
    assert.ok(Math.abs(p.x + p.w / 2 - (box.x + box.w / 2)) <= 1, `centre ${angle}`);
  }
  // Top-centre anchor on the vertical template.
  const v = vertical();
  const { placedBox: p } = fitPicture(rectMask(300, 800, 6), v);
  assert.ok(Math.abs(p.y - v.box.y * 1600) <= 1);
});

test('placedBox matches the transform applied to the foreground hull', () => {
  const source = shoeMask(-9);
  const analysis = analyzeMask(source);
  const fit = computeFit(analysis, template());
  const [a, b, c, d, e, f] = fit.matrix;
  const xs = [], ys = [];
  for (const [x, y] of analysis.hull) {
    xs.push(a * x + c * y + e); ys.push(b * x + d * y + f);
  }
  assert.ok(Math.abs(Math.min(...xs) - fit.placedBox.x) < 0.1);
  assert.ok(Math.abs(Math.max(...xs) - Math.min(...xs) - fit.placedBox.w) < 0.1);
  assert.ok(Math.abs(Math.min(...ys) - fit.placedBox.y) < 0.1);
  assert.ok(Math.abs(Math.max(...ys) - fit.placedBox.y - fit.placedBox.h) < 0.1);
  // The matrix is consistent with the transform.
  const t = fit.transform.rotateDeg * Math.PI / 180;
  assert.ok(Math.abs(a - fit.transform.scale * Math.cos(t)) < 2e-4);
  assert.ok(Math.abs(b - fit.transform.scale * Math.sin(t)) < 2e-4);
  assert.equal(e, fit.transform.translateX);
  assert.equal(f, fit.transform.translateY);
});

test('contain keeps placedBox inside the box and maxUpscale is honoured', () => {
  const t = template({ anchor: { x: 0.3, y: 0.7 } });
  const box = { x: 72, y: 480, w: 1056, h: 736 };
  for (const angle of [0, 15]) {
    const p = fitPicture(shoeMask(angle), t).placedBox;
    assert.ok(p.x >= box.x - 0.01 && p.y >= box.y - 0.01 && p.x + p.w <= box.x + box.w + 0.01 && p.y + p.h <= box.y + box.h + 0.01);
  }
  // Small source: wanted scale far above maxUpscale.
  const small = mask(400, 400, [{ polygon: rect(160, 60), cx: 200, cy: 200 }]);
  const fit = fitPicture(small, template());
  assert.equal(fit.transform.scale, 1.5);
  assert.ok(fit.quality.flags.includes('upscaled'));
  assert.ok(fit.placedBox.w < 1056);
  const loose = fitPicture(small, template({ scale: { mode: 'contain', maxUpscale: 10 } }));
  assert.ok(!loose.quality.flags.includes('upscaled'));
  assert.ok(Math.abs(loose.placedBox.w - 1056) < 1 || Math.abs(loose.placedBox.h - 736) < 1);
});

test('scale modes width, height and area are capped by contain', () => {
  const rectSource = rectMask(800, 300, 0);
  const wide = fitPicture(rectSource, template({ scale: { mode: 'width', maxUpscale: 5 } }));
  assert.ok(Math.abs(wide.placedBox.w - 1056) < 1);
  // height mode on a wide object is capped by contain (width fills first)
  const tall = fitPicture(rectSource, template({ scale: { mode: 'height', maxUpscale: 5 } }));
  assert.ok(tall.placedBox.w <= 1056.01 && tall.placedBox.h <= 736.01);
  const area = fitPicture(rectSource, template({ scale: { mode: 'area', areaFraction: 0.2, maxUpscale: 5 } }));
  const fg = 800 * 300 * area.transform.scale ** 2;
  assert.ok(Math.abs(fg / (1056 * 736) - 0.2) < 0.01, String(fg / (1056 * 736)));
  assert.throws(() => computeFit(analyzeMask(rectSource), template({ scale: { mode: 'area', maxUpscale: 1 } })), TypeError);
});

test('manual nudges are applied last and bounded', () => {
  const analysis = analyzeMask(shoeMask(5));
  const auto = computeFit(analysis, template());
  assert.equal(auto.manual, null);
  const moved = computeFit(analysis, template(), { offsetX: 0.1, offsetY: -0.05 });
  assert.deepEqual(moved.manual, { rotateDeg: 0, scale: 1, offsetX: 0.1, offsetY: -0.05 });
  assert.ok(Math.abs(moved.placedBox.x - auto.placedBox.x - 120) < 0.01);
  assert.ok(Math.abs(moved.placedBox.y - auto.placedBox.y + 80) < 0.01);
  assert.equal(moved.transform.scale, auto.transform.scale);
  const scaled = computeFit(analysis, template(), { scale: 1.1 });
  assert.ok(Math.abs(scaled.transform.scale / auto.transform.scale - 1.1) < 1e-3);
  assert.ok(Math.abs(scaled.placedBox.y + scaled.placedBox.h - (auto.placedBox.y + auto.placedBox.h)) < 0.01, 'anchor stays aligned');
  const turned = computeFit(analysis, template(), { rotateDeg: 3 });
  assert.ok(Math.abs(turned.transform.rotateDeg - auto.transform.rotateDeg - 3) < 1e-3);
  for (const bad of [{ rotateDeg: 45.1 }, { rotateDeg: -46 }, { scale: 0.49 }, { scale: 2.01 }, { offsetX: 0.26 }, { offsetY: -0.3 }, { scale: NaN }, { offsetX: Infinity }, { rotateDeg: '3' }]) {
    assert.throws(() => computeFit(analysis, template(), bad), RangeError, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => computeFit(analysis, template(), { rotateDeg: 45, scale: 2, offsetX: 0.25, offsetY: -0.25 }));
  assert.doesNotThrow(() => computeFit(analysis, template(), { rotateDeg: -45, scale: 0.5 }));
  assert.throws(() => computeFit(analysis, template(), 5), TypeError);
});

test('RGBA and bare-mask input give identical results', () => {
  const gray = shoeMask(11);
  const rgba = mask(W, H, [{ polygon: shoe, angleDeg: 11, cx: C, cy: C }], { channels: 4 });
  assert.deepEqual(analyzeMask(rgba), analyzeMask(gray));
  assert.equal(JSON.stringify(fitPicture(rgba, template())), JSON.stringify(fitPicture(gray, template())));
  // Uint8ClampedArray (ImageData) is accepted too.
  const clamped = { ...rgba, data: new Uint8ClampedArray(rgba.data) };
  assert.deepEqual(analyzeMask(clamped), analyzeMask(gray));
});

test('output is deterministic and byte-equal with 4-decimal numbers', () => {
  const source = shoeMask(-13.37);
  const a = JSON.stringify(fitPicture(source, template()));
  const b = JSON.stringify(fitPicture(source, template()));
  assert.equal(a, b);
  assert.ok(a.length < 1024, `recipe is ${a.length} bytes`);
  const fit = JSON.parse(a);
  assert.equal(fit.fitVersion, FIT_VERSION);
  assert.equal(fit.templateId, 'test-template');
  assert.equal(fit.templateRevision, 3);
  assert.deepEqual(fit.canvas, { width: 1200, height: 1600 });
  for (const value of [...Object.values(fit.transform), ...fit.matrix, ...Object.values(fit.placedBox), fit.quality.score]) {
    assert.equal(Math.round(value * 1e4) / 1e4, value);
  }
  assert.equal(fit.quality.score, 1);
  assert.ok(!Object.is(fitPicture(rectMask(800, 300, 0), template()).transform.rotateDeg, -0));
});

test('soft masks and deterministic downsampling', () => {
  const soft = mask(W, H, [{ polygon: rect(800, 300), cx: C, cy: C, alpha: 200 }]);
  const softAnalysis = analyzeMask(soft);
  assert.ok(softAnalysis.softFraction > 0.9);
  assert.ok(computeFit(softAnalysis, template()).quality.flags.includes('soft-mask'));
  // Soft halo just outside the hard mask is part of the bbox but not the angle estimate.
  const halo = mask(300, 200, [{ polygon: rect(120, 40), cx: 150, cy: 100 }]);
  const clean = analyzeMask(halo);
  const ring = new Uint8Array(halo.data);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 300; x++) {
    const i = y * 300 + x;
    if (!ring[i] && x >= 89 && x < 211 && y >= 79 && y < 121) ring[i] = 40;
  }
  const withHalo = analyzeMask({ ...halo, data: ring });
  assert.ok(withHalo.bbox.w > clean.bbox.w && withHalo.bbox.h > clean.bbox.h);
  assert.equal(withHalo.minRect.angleDeg, clean.minRect.angleDeg);

  const big = rectMask(800, 300, 8);
  const reduced = analyzeMask(big, { maxAnalysisPixels: 250_000 });
  assert.ok(reduced.analysisScale >= 2);
  assert.deepEqual(reduced, analyzeMask(big, { maxAnalysisPixels: 250_000 }));
  const full = analyzeMask(big);
  assert.equal(full.analysisScale, 1);
  assert.ok(Math.abs(reduced.minRect.angleDeg - 8) <= 0.5);
  assert.ok(Math.abs(reduced.bbox.w - full.bbox.w) <= reduced.analysisScale * 2);
  assert.ok(reduced.bbox.x + reduced.bbox.w <= W && reduced.bbox.y + reduced.bbox.h <= H);
});

test('analysis reports geometry in source pixels', () => {
  const analysis = analyzeMask(rectMask(800, 300, 0));
  assert.deepEqual(analysis.bbox, { x: 300, y: 550, w: 800, h: 300 });
  assert.ok(Math.abs(analysis.centroid.x - 700) < 1 && Math.abs(analysis.centroid.y - 700) < 1);
  assert.ok(Math.abs(analysis.minRect.long - 800) < 1.5 && Math.abs(analysis.minRect.short - 300) < 1.5);
  assert.ok(Math.abs(analysis.minRect.elongation - 800 / 300) < 0.02);
  assert.ok(analysis.pca.eccentricity < 0.2 && Math.abs(analysis.pca.angleDeg) < 0.1);
  assert.equal(analysis.mainShare, 1);
  assert.equal(analysis.droppedFraction, 0);
  assert.equal(analysis.componentCount, 1);
  assert.deepEqual(analysis.edgeContact, { top: 0, right: 0, bottom: 0, left: 0 });
});

test('input validation', () => {
  assert.throws(() => analyzeMask(null), TypeError);
  assert.throws(() => analyzeMask({ width: 0, height: 4, data: new Uint8Array(0), channels: 1 }), RangeError);
  assert.throws(() => analyzeMask({ width: 4, height: 4, data: new Uint8Array(15), channels: 1 }), RangeError);
  assert.throws(() => analyzeMask({ width: 4, height: 4, data: new Uint8Array(64), channels: 3 }), RangeError);
  assert.throws(() => analyzeMask({ width: 4, height: 4, data: [], channels: 1 }), TypeError);
  assert.throws(() => analyzeMask(rectMask(10, 10, 0), { alphaThreshold: 0 }), RangeError);
  assert.throws(() => analyzeMask(rectMask(10, 10, 0), { softThreshold: 200 }), RangeError);
  assert.throws(() => computeFit(analyzeMask(rectMask(100, 40, 0)), { id: 'x' }), TypeError);
});

test('validateFitRecipe accepts real recipes and rejects out-of-bounds ones', () => {
  const t = template();
  const good = fitPicture(shoeMask(8), t, { manual: { rotateDeg: 2, offsetX: 0.1 } });
  assert.equal(validateFitRecipe(JSON.parse(JSON.stringify(good)), t).templateId, 'test-template');
  assert.doesNotThrow(() => validateFitRecipe(fitPicture(shoeMask(8), t), t));
  assert.doesNotThrow(() => validateFitRecipe(fitPicture(rectMask(800, 300, 35), t), t));
  const bad = (mutate, error = RangeError) => {
    const r = JSON.parse(JSON.stringify(good));
    mutate(r);
    assert.throws(() => validateFitRecipe(r, t), error);
  };
  bad((r) => { r.fitVersion = 2; });
  bad((r) => { r.templateId = 'other'; });
  bad((r) => { r.templateRevision = 2; });
  bad((r) => { r.canvas.width = 1201; });
  bad((r) => { r.transform.rotateDeg = 80; });
  bad((r) => { r.transform.scale = 0; });
  bad((r) => { r.transform.scale = 50; });
  bad((r) => { r.transform.translateX = 1e6; });
  bad((r) => { r.transform.scale = NaN; }, TypeError);
  bad((r) => { r.matrix = [1, 0, 0, 1, 0]; }, TypeError);
  bad((r) => { r.matrix[0] += 0.5; });
  bad((r) => { r.manual.scale = 3; });
  bad((r) => { r.manual = 'x'; }, TypeError);
  bad((r) => { r.placedBox.w = -1; }, TypeError);
  bad((r) => { r.placedBox.x = 1e5; });
  bad((r) => { r.quality.level = 'great'; }, TypeError);
  bad((r) => { r.quality.flags = ['made-up']; }, TypeError);
  bad((r) => { r.quality.score = 2; });
  bad((r) => { r.extra = 'x'.repeat(3000); });
  bad((r) => { r.extra = 1; }, TypeError);
  bad((r) => { r.transform.skew = 1; }, TypeError);
  bad((r) => { r.manual.extra = 1; }, TypeError);
  bad((r) => { r.manual = [0, 1, 0, 0]; }, TypeError);
  bad((r) => { r.placedBox = [1, 2, 3, 4]; }, TypeError);
  bad((r) => { r.quality.flags = ['upscaled', 'upscaled']; r.quality.level = 'review'; r.quality.score = 0.6; }, TypeError);
  bad((r) => { r.quality.level = 'ok'; r.quality.flags = ['upscaled']; }, TypeError);
  bad((r) => { r.quality.level = 'review'; }, TypeError);
  bad((r) => { r.quality.level = 'unsupported'; }, TypeError);
  bad((r) => { r.quality.score = 0.1; });
  bad((r) => { r.placedBox.x += 40; });
  bad((r) => { r.placedBox.w *= 3; });
  bad((r) => { r.transform.scale = 1.5 * 2 + 0.5; });
  // Canonical copy: byte-equal for genuine recipes, drops nothing valid, shares no references.
  const clean = validateFitRecipe(good, t);
  assert.equal(JSON.stringify(clean), JSON.stringify(good));
  assert.notEqual(clean, good);
  assert.notEqual(clean.quality.flags, good.quality.flags);
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => validateFitRecipe(cyclic, t), TypeError);
  assert.throws(() => validateFitRecipe(Object.assign(Object.create({ x: 1 }), good), t), TypeError);
  const empty = fitPicture({ width: 50, height: 50, data: new Uint8Array(2500), channels: 1 }, t);
  assert.equal(validateFitRecipe(empty, t).quality.level, 'unsupported');
  const flaggedEmpty = JSON.parse(JSON.stringify(empty)); flaggedEmpty.transform.scale = 2;
  assert.throws(() => validateFitRecipe(flaggedEmpty, t), RangeError);
  for (const junk of [null, 5, [], 'x']) assert.throws(() => validateFitRecipe(junk, t), TypeError);
});

test('module has no DOM or global access', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../packages/catalog/picture-fit.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(window|document|navigator|OffscreenCanvas|fetch|Date\.now|new Date|Math\.random|performance|process|require|import\s*\()\b/);
  assert.doesNotMatch(source, /^import /m);
});

test('analysis of a 1600x1600 mask stays under 250 ms', () => {
  const source = shoeMask(0); // warm up and prepare off the clock
  const big = mask(1600, 1600, [{ polygon: shoe, angleDeg: 6, cx: 800, cy: 800 }, { polygon: rect(30, 30), cx: 100, cy: 100 }]);
  analyzeMask(source);
  const start = process.hrtime.bigint();
  const analysis = analyzeMask(big);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(analysis.keptComponents, 1);
  assert.ok(ms < 250, `analysis took ${ms.toFixed(1)} ms`);
});

// Maps every true foreground pixel through the recipe matrix and returns the resulting extent.
function mappedExtent(source, fit) {
  const [a, b, c, d, e, f] = fit.matrix;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    if (source.data[y * source.width + x] < 128) continue;
    for (const [px, py] of [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]]) {
      const X = a * px + c * py + e, Y = b * px + d * py + f;
      if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
  }
  return { x0, y0, x1, y1 };
}

test('tilted objects are measured by their hull, not the loose bbox corners', () => {
  const contain = template();
  const box = { x: 72, y: 480, w: 1056, h: 736 };
  for (const [name, source] of [['rect', rectMask(800, 300, 20)], ['shoe', shoeMask(20)]]) {
    const fit = fitPicture(source, contain);
    const m = mappedExtent(source, fit);
    assert.ok(Math.abs(m.y1 - (box.y + box.h)) <= 1, `${name} bottom ${m.y1}`);
    assert.ok(Math.abs((m.x0 + m.x1) / 2 - (box.x + box.w / 2)) <= 1, `${name} centre`);
    assert.ok(m.x0 >= box.x - 1 && m.x1 <= box.x + box.w + 1 && m.y0 >= box.y - 1, `${name} inside`);
    assert.ok(Math.abs(m.x1 - m.x0 - fit.placedBox.w) <= 1 && Math.abs(m.y1 - m.y0 - fit.placedBox.h) <= 1, `${name} placedBox`);
    // An upright 800x300 shape would fill the width; the rotated shape must be about as large.
    if (name === 'rect') assert.ok(fit.transform.scale > 1.2, `scale ${fit.transform.scale}`);
  }
  const height = template({ scale: { mode: 'height', maxUpscale: 5 } , box: { x: 0.06, y: 0.1, w: 0.88, h: 0.6 }, anchor: { x: 0.5, y: 1 } });
  for (const source of [rectMask(800, 300, -20), shoeMask(20)]) {
    const fit = fitPicture(source, height);
    const m = mappedExtent(source, fit);
    assert.ok(Math.abs(m.y1 - (0.7 * 1600)) <= 1, `bottom ${m.y1}`);
    assert.ok(m.x1 - m.x0 <= 1056 + 1, 'width capped by contain');
    assert.ok(Math.abs(m.y1 - m.y0 - Math.min(0.6 * 1600, fit.placedBox.h)) <= 1);
  }
  const tall = vertical({ scale: { mode: 'height', maxUpscale: 5 } });
  const tallSource = rectMask(300, 800, 12);
  const tallFit = fitPicture(tallSource, tall);
  const tm = mappedExtent(tallSource, tallFit);
  assert.ok(Math.abs(tm.y1 - tm.y0 - 0.9 * 1600) <= 1, `height ${tm.y1 - tm.y0}`);
  assert.ok(Math.abs(tm.y0 - 0.05 * 1600) <= 1);
  assert.ok(JSON.stringify(tallFit).length < 1024);
});

test('multi-pixel soft ramps are included in bbox and hull', () => {
  const width = 400, height = 300, data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    // 201x81 opaque core centred at (200,150) with a 5 px linear ramp around it.
    const dx = Math.max(100 - x, x - 300, 0), dy = Math.max(110 - y, y - 190, 0);
    const d = Math.max(dx, dy);
    if (d === 0) data[y * width + x] = 255;
    else if (d <= 5) data[y * width + x] = Math.round(255 * (6 - d) / 6);
  }
  const analysis = analyzeMask({ width, height, data, channels: 1 });
  assert.ok(analysis.bbox.w >= 210 && analysis.bbox.h >= 90, JSON.stringify(analysis.bbox));
  const xs = analysis.hull.map((p) => p[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) >= 210);
  assert.ok(analysis.softFraction > 0.05);
});

test('manual scale is contained by the canvas, exempt from maxUpscale, and empty masks drop manual', () => {
  const t = template();
  const wide = mask(2000, 600, [{ polygon: rect(1500, 300), cx: 1000, cy: 300 }]);
  const analysis = analyzeMask(wide);
  const fit = computeFit(analysis, t, { scale: 2, offsetX: 0.1 });
  assert.ok(fit.placedBox.w <= 1200.01 && fit.placedBox.h <= 1600.01, JSON.stringify(fit.placedBox));
  assert.ok(Math.abs(fit.placedBox.w - 1200) < 0.01, 'clamped to the canvas width');
  assert.doesNotThrow(() => validateFitRecipe(fit, t));
  const tooBig = JSON.parse(JSON.stringify(fit)); tooBig.placedBox.w = 1300;
  assert.throws(() => validateFitRecipe(tooBig, t), RangeError);
  // Exempt from maxUpscale: a small source at the 1.5 cap can still be nudged up.
  const small = analyzeMask(mask(400, 400, [{ polygon: rect(160, 60), cx: 200, cy: 200 }]));
  assert.ok(computeFit(small, t, { scale: 1.4 }).transform.scale > 1.5 * 1.39);
  const empty = computeFit(analyzeMask({ width: 50, height: 50, data: new Uint8Array(2500), channels: 1 }), t, { scale: 1.5, offsetX: 0.1 });
  assert.equal(empty.manual, null);
  assert.equal(validateFitRecipe(empty, t).quality.level, 'unsupported');
});

test('validateFitRecipe: byte-size, axis none, plausibility and canonical rounding', () => {
  const t = template();
  const good = fitPicture(shoeMask(8), t);
  const padded = JSON.parse(JSON.stringify(good)); padded.templateId = 'test-template';
  // Multi-byte characters count as bytes, not characters.
  const wide = { ...padded, extra: 'я'.repeat(400) };
  assert.throws(() => validateFitRecipe(wide, t), RangeError);
  const none = template({ orientation: { axis: 'none', maxCorrectionDeg: 0, minElongation: 1.15 } });
  const noneFit = fitPicture(rectMask(800, 300, 12), none);
  assert.doesNotThrow(() => validateFitRecipe(noneFit, none));
  const rotated = JSON.parse(JSON.stringify(noneFit)); rotated.transform.rotateDeg = 3;
  const tt = rotated.transform.rotateDeg * Math.PI / 180, s = rotated.transform.scale;
  rotated.matrix = [s * Math.cos(tt), s * Math.sin(tt), -s * Math.sin(tt), s * Math.cos(tt), rotated.transform.translateX, rotated.transform.translateY];
  assert.throws(() => validateFitRecipe(rotated, none), RangeError);
  const off = JSON.parse(JSON.stringify(good)); off.placedBox.x = 5000; off.placedBox.w = 10;
  assert.throws(() => validateFitRecipe(off, t), RangeError);
  const unrounded = JSON.parse(JSON.stringify(good)); unrounded.transform.translateX += 0.00004;
  unrounded.matrix[4] = unrounded.transform.translateX;
  assert.equal(validateFitRecipe(unrounded, t).transform.translateX, good.transform.translateX);
});

test('every computeFit result for valid input validates: large sources, off-centre objects, extreme manual', () => {
  const bags = template({ id: 'bags', box: { x: 0.12, y: 0.2, w: 0.76, h: 0.62 }, anchor: { x: 0.5, y: 1 }, scale: { mode: 'contain', maxUpscale: 1.5 }, orientation: { axis: 'none', maxCorrectionDeg: 0, minElongation: 1.15 } });
  const templates = [template(), vertical(), bags, template({ scale: { mode: 'area', areaFraction: 0.3, maxUpscale: 2 }, anchor: { x: 0, y: 0 } }), template({ anchor: { x: 1, y: 1 }, canvas: { width: 512, height: 512 } })];
  const sources = [
    { w: 4000, h: 3000, shape: rect(300, 300), cx: 2000, cy: 1500 },
    { w: 8000, h: 6000, shape: rect(600, 400), cx: 4000, cy: 3000 },
    { w: 4000, h: 3000, shape: rect(200, 200), cx: 3700, cy: 2700 },
    { w: 4000, h: 3000, shape: rect(200, 200), cx: 3600, cy: 2700 },
    { w: 1600, h: 1600, shape: shoe, cx: 800, cy: 800, angle: 12 },
    { w: 900, h: 900, shape: rect(100, 300), cx: 120, cy: 700 }
  ];
  for (const sc of sources) {
    // Large sources are analysed at reduced resolution to keep the sweep fast.
    const analysis = analyzeMask(mask(sc.w, sc.h, [{ polygon: sc.shape, angleDeg: sc.angle ?? 0, cx: sc.cx, cy: sc.cy }]), { maxAnalysisPixels: 500_000 });
    for (const t of templates) for (const manual of [null, { scale: 1.5 }, { scale: 2 }, { scale: 0.5, offsetX: -0.25, offsetY: 0.25 }, { scale: 2, offsetX: 0.25, offsetY: -0.25, rotateDeg: -45 }, { scale: 0.5, offsetX: 0.25, offsetY: -0.25, rotateDeg: 45 }]) {
      const fit = computeFit(analysis, t, manual);
      assert.doesNotThrow(() => validateFitRecipe(JSON.parse(JSON.stringify(fit)), t), `${t.id} ${sc.w}x${sc.h} ${JSON.stringify(manual)} ${JSON.stringify(fit.placedBox)}`);
    }
  }
  // Named probes from review.
  const probe = analyzeMask(mask(4000, 3000, [{ polygon: rect(300, 300), cx: 2000, cy: 1500 }]), { maxAnalysisPixels: 500_000 });
  const f = computeFit(probe, template(), { scale: 2 });
  assert.ok(Math.abs(f.transform.translateX) > 4 * 1200 / 2);
  assert.doesNotThrow(() => validateFitRecipe(f, template()));
  // Clamp keeps at least 1 px visible.
  const clamped = computeFit(probe, bags, { scale: 0.5, offsetX: -0.25, offsetY: 0.25 });
  assert.ok(clamped.placedBox.x + clamped.placedBox.w > 0 && clamped.placedBox.y < 1600 && clamped.placedBox.y + clamped.placedBox.h > 0);
});

test('validateFitRecipe recomputes the clamped position: forged clamp-line recipes are rejected', () => {
  const t = template();
  const probe = analyzeMask(mask(900, 900, [{ polygon: rect(300, 200), cx: 450, cy: 450 }]));
  const identity = { rotateDeg: 0, scale: 1, offsetX: 0, offsetY: 0 };
  const good = JSON.parse(JSON.stringify(computeFit(probe, t, identity)));
  assert.doesNotThrow(() => validateFitRecipe(JSON.parse(JSON.stringify(good)), t));
  const { width: cw, height: ch } = t.canvas;
  const forge = (patch) => ({ ...JSON.parse(JSON.stringify(good)), placedBox: { ...good.placedBox, ...patch } });
  const w = good.placedBox.w, h = good.placedBox.h;
  for (const [name, patch] of [
    ['x = 1 - w', { x: 1 - w }],
    ['x = cw - 1', { x: cw - 1 }],
    ['y = 1 - h', { y: 1 - h }],
    ['y = ch - 1', { y: ch - 1 }],
    ['corner (cw-1, ch-1)', { x: cw - 1, y: ch - 1 }],
    ['tiny box at origin', { x: 0, y: 0, w: 0.01, h: 0.01 }]
  ]) {
    assert.throws(() => validateFitRecipe(forge(patch), t), RangeError, name);
    const manual = forge(patch); manual.manual = identity;
    assert.throws(() => validateFitRecipe(manual, t), RangeError, `${name} (manual)`);
  }
  assert.ok(w > 1 && h > 1 && cw > 0 && ch > 0);
});

test('sweep: every computeFit output validates for bundled templates and manual bounds', () => {
  const sources = [
    { w: 4000, h: 3000, shape: rect(300, 300), cx: 2000, cy: 1500 },
    { w: 4000, h: 3000, shape: rect(200, 200), cx: 3700, cy: 2700 },
    { w: 900, h: 900, shape: rect(100, 300), cx: 120, cy: 700 },
    { w: 1600, h: 1600, shape: shoe, cx: 800, cy: 800, angle: 12 }
  ];
  const manuals = [null, { scale: 2 }, { scale: 0.5, offsetX: -0.25, offsetY: 0.25 }, { scale: 2, offsetX: 0.25, offsetY: -0.25, rotateDeg: -45 }, { scale: 0.5, offsetX: 0.25, offsetY: 0.25, rotateDeg: 45 }, { scale: 0.5, offsetX: -0.25, offsetY: -0.25 }];
  const templates = Object.values(PICTURE_TEMPLATES);
  assert.ok(templates.length > 0);
  for (const sc of sources) {
    const analysis = analyzeMask(mask(sc.w, sc.h, [{ polygon: sc.shape, angleDeg: sc.angle ?? 0, cx: sc.cx, cy: sc.cy }]), { maxAnalysisPixels: 500_000 });
    for (const t of templates) for (const manual of manuals) {
      const fit = computeFit(analysis, t, manual);
      assert.doesNotThrow(() => validateFitRecipe(JSON.parse(JSON.stringify(fit)), t), `${t.id} ${sc.w}x${sc.h} ${JSON.stringify(manual)} ${JSON.stringify(fit.placedBox)}`);
    }
  }
});

test('checkTemplate rejects boxes outside the canvas', () => {
  const probe = analyzeMask(rectMask(300, 200, 0));
  for (const box of [{ x: -0.1, y: 0.3, w: 0.5, h: 0.4 }, { x: 0.6, y: 0.3, w: 0.5, h: 0.4 }, { x: 0.1, y: 0.7, w: 0.5, h: 0.4 }, { x: 0.1, y: -0.2, w: 0.5, h: 0.4 }]) {
    assert.throws(() => computeFit(probe, template({ box }), null), TypeError, JSON.stringify(box));
  }
  assert.doesNotThrow(() => computeFit(probe, template({ box: { x: 0, y: 0, w: 1, h: 1 } }), null));
});
