import assert from 'node:assert/strict';
import { SCENES, SCENE_IDS, SCENE_ALIASES, DEFAULT_SCENE_ID, getScene, sceneLayout, sceneViolations } from '../../packages/catalog/campaign-scenes.js';

assert.deepEqual(SCENE_IDS, ['fan', 'rail', 'hooks', 'floor']);
assert.equal(DEFAULT_SCENE_ID, 'fan');
assert.ok(Object.isFrozen(SCENES) && Object.isFrozen(SCENES[0]) && Object.isFrozen(SCENES[0].layouts[1].desktop[0]) && Object.isFrozen(SCENE_ALIASES));
assert.equal(getScene('rail').id, 'rail');
assert.equal(getScene('nope'), null);
assert.equal(getScene(undefined), null);
assert.equal(getScene('__proto__'), null);
assert.equal(getScene('toString'), null);
assert.equal(getScene('floor').available, false);
for (const id of ['fan', 'rail', 'hooks']) assert.equal(getScene(id).available, true);

for (const scene of SCENES) {
  assert.deepEqual(Object.keys(scene).sort(), ['anchor', 'available', 'background', 'id', 'label', 'layouts', 'props'].sort());
  assert.ok(['top', 'bottom', 'center'].includes(scene.anchor));
  const bg = scene.background;
  assert.ok(bg.src && bg.srcSet && bg.width > 0 && bg.height > 0 && bg.position.desktop && bg.position.mobile, `${scene.id} background`);
  for (const n of [1, 2]) assert.ok(scene.layouts[n], `${scene.id} layout ${n}`);
  for (const [n, layout] of Object.entries(scene.layouts)) for (const mode of ['desktop', 'mobile']) {
    assert.ok(layout[mode].length >= 1 && layout[mode].length <= Number(n), `${scene.id} ${n} ${mode} slot count`);
    for (const slot of layout[mode]) assert.deepEqual(Object.keys(slot).sort(), ['h', 'r', 'w', 'x', 'y', 'z']);
  }
  assert.deepEqual(sceneViolations(scene), [], `${scene.id} violations`);
}
assert.equal(getScene('hooks').layouts[4].desktop.length, 4);
assert.equal(getScene('hooks').layouts[4].mobile.length, 3);

// sceneLayout: largest key <= n
const hooks = getScene('hooks'), fan = getScene('fan');
assert.equal(sceneLayout(hooks, 1), hooks.layouts[1]);
assert.equal(sceneLayout(hooks, 2), hooks.layouts[2]);
assert.equal(sceneLayout(hooks, 3), hooks.layouts[3]);
assert.equal(sceneLayout(hooks, 4), hooks.layouts[4]);
assert.equal(sceneLayout(hooks, 9), hooks.layouts[4]);
assert.equal(sceneLayout(fan, 4), fan.layouts[3]);
assert.equal(sceneLayout(fan, 0), null);
assert.equal(sceneLayout(fan, -1), null);
assert.equal(sceneLayout(fan, NaN), null);
assert.equal(sceneLayout(hooks, Infinity), hooks.layouts[4]);
assert.equal(sceneLayout(null, 2), null);

// negative fixtures
const slot = (x, y, w, h, z = 1, r = 0) => ({ x, y, w, h, z, r });
const fixture = (anchor, desktop, mobile = desktop) => ({ id: 'bad', anchor, layouts: { 1: { desktop: [desktop[0]], mobile: [mobile[0]] }, 2: { desktop, mobile } } });
const covered = sceneViolations(fixture('top', [slot(10, 5, 40, 80, 1), slot(20, 5, 40, 80, 2)]));
assert.ok(covered.some(v => /covers the core of slot 1/.test(v)), 'overlap on core reported');
// equal z: later in list paints above
assert.ok(sceneViolations(fixture('top', [slot(10, 5, 40, 80), slot(20, 5, 40, 80)])).some(v => /slot 2 covers the core of slot 1/.test(v)));
assert.ok(!sceneViolations(fixture('top', [slot(10, 5, 40, 80), slot(20, 5, 40, 80)])).some(v => /slot 1 covers the core of slot 2/.test(v)));
// side by side is clean
assert.deepEqual(sceneViolations(fixture('top', [slot(0, 5, 40, 80), slot(50, 5, 40, 80)])), []);
// bounds
for (const bad of [slot(-1, 0, 40, 80), slot(70, 0, 31, 80), slot(0, -1, 40, 80), slot(0, 20, 40, 93), slot(0, 0, 40, 80, 1, 19), slot(0, 0, 40, 80, 1, -19)])
  assert.ok(sceneViolations(fixture('top', [bad])).some(v => /out of bounds/.test(v)), JSON.stringify(bad));
// anchor origin: CSS rotates about top centre (top), bottom centre (bottom) or box centre (center)
// top: +r is clockwise, so the hanging piece's bottom swings left, towards slot 1; -r swings away
const swungLeft = fixture('top', [slot(0, 0, 30, 100, 1), slot(33, 0, 30, 100, 2, 18)]);
const swungRight = fixture('top', [slot(0, 0, 30, 100, 1), slot(33, 0, 30, 100, 2, -18)]);
assert.deepEqual(sceneViolations(fixture('top', [slot(0, 0, 30, 100, 1), slot(33, 0, 30, 100, 2, 0)])), []);
assert.ok(sceneViolations(swungLeft).some(v => /slot 2 covers the core of slot 1/.test(v)));
assert.deepEqual(sceneViolations(swungRight), []);
// bottom: the piece stands on its bottom centre, so +r swings its top to the right, towards the neighbour at the right
const standRight = [slot(70, 0, 30, 100, 1), slot(37, 0, 30, 100, 2, 18)];
assert.ok(sceneViolations(fixture('bottom', standRight)).some(v => /slot 2 covers the core of slot 1/.test(v)));
assert.deepEqual(sceneViolations(fixture('bottom', [standRight[0], { ...standRight[1], r: -18 }])), []);
assert.deepEqual(sceneViolations(fixture('bottom', [standRight[0], { ...standRight[1], r: 0 }])), []);
// center: rotation about the box centre widens the box symmetrically; unrotated it clears the neighbour
const flat = [slot(60, 0, 30, 100, 1), slot(35, 0, 30, 100, 2, 0)];
assert.deepEqual(sceneViolations(fixture('center', flat)), []);
assert.ok(sceneViolations(fixture('center', [flat[0], { ...flat[1], r: 18 }])).some(v => /slot 2 covers the core of slot 1/.test(v)));
assert.ok(sceneViolations(fixture('center', [flat[0], { ...flat[1], r: -18 }])).some(v => /slot 2 covers the core of slot 1/.test(v)));

// core offsets per anchor: a higher slot over the part of the box away from the anchor is allowed, over the core it is not
const over = (anchor, y, h) => sceneViolations(fixture(anchor, [slot(0, 0, 30, 100, 1), slot(10, y, 10, h, 2)])).some(v => /slot 2 covers the core of slot 1/.test(v));
// bottom anchor: core is the lower 70% (y 30..100)
assert.equal(over('bottom', 0, 29), false); assert.equal(over('bottom', 0, 31), true); assert.equal(over('bottom', 90, 10), true);
// top anchor: core is the upper 70% (y 0..70)
assert.equal(over('top', 71, 29), false); assert.equal(over('top', 69, 10), true); assert.equal(over('top', 0, 10), true);
// center: core is the middle 70% (y 15..85)
assert.equal(over('center', 0, 14), false); assert.equal(over('center', 86, 14), false);
assert.equal(over('center', 0, 16), true); assert.equal(over('center', 84, 16), true);

// reference sizes are pinned: each one is reported by its own string
const msgs = sceneViolations(fixture('top', [slot(10, 5, 40, 80, 1), slot(20, 5, 40, 80, 2)]));
for (const sz of ['desktop 756x496', 'desktop 580x496', 'mobile 390x270']) assert.ok(msgs.some(v => v.includes(sz)), sz);
assert.equal(msgs.length, 3);
// desktop and mobile slot lists are checked independently
const mobileOnly = sceneViolations(fixture('top', [slot(0, 5, 40, 80), slot(50, 5, 40, 80)], [slot(10, 5, 40, 80), slot(20, 5, 40, 80)]));
assert.ok(mobileOnly.length >= 1 && mobileOnly.every(v => v.includes('mobile 390x270')));
console.log('campaign-scenes tests passed');
