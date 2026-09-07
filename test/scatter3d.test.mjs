/**
 * Tests for the 3D scatter engine.
 *
 *     node test/scatter3d.test.mjs
 *
 * The engine is loaded by EVALUATING assets/scatter3d.js the way a browser
 * does, so the tests run the bytes that ship rather than a parallel copy.
 *
 * Only the maths is covered here — rotation, projection, scales, hit testing.
 * Canvas painting is checked by looking at it; arithmetic that is wrong by a
 * sign or an axis is not, because a plot with the depth inverted still looks
 * like a plot.
 */

import assert from 'node:assert';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../assets/scatter3d.js', import.meta.url), 'utf8');
const S = new Function(`${src}; return globalThis.Scatter3D;`)();

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    console.log('  PASS  ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
};

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const near = (a, b, eps = 1e-9) => assert.ok(close(a, b, eps), `${a} !== ${b}`);

/* ---------------------------------------------------------- rotation ----- */
console.log('\nRotation');

t('no rotation leaves a point where it was', () =>
  assert.deepEqual(S.rotate({ x: 1, y: 2, z: 3 }, 0, 0), { x: 1, y: 2, z: 3 }));

t('a quarter turn of yaw swaps x into z', () => {
  const r = S.rotate({ x: 1, y: 0, z: 0 }, Math.PI / 2, 0);
  near(r.x, 0);
  near(r.z, 1);
});

t('a quarter turn of pitch swaps y into z', () => {
  const r = S.rotate({ x: 0, y: 1, z: 0 }, 0, Math.PI / 2);
  near(r.y, 0);
  near(r.z, 1);
});

t('yaw alone never moves y — it is the turntable axis', () => {
  for (const yaw of [0.3, 1.1, -2.4]) {
    near(S.rotate({ x: 3, y: 7, z: -2 }, yaw, 0).y, 7);
  }
});

t('rotation preserves length, so nothing stretches as it turns', () => {
  const p = { x: 3, y: -4, z: 12 };
  const len = (q) => Math.hypot(q.x, q.y, q.z);
  near(len(S.rotate(p, 0.7, -0.3)), len(p), 1e-9);
});

t('yaw is applied before pitch', () => {
  // THE BUG THIS GUARDS: compose them the other way and the horizontal drag
  // axis changes meaning with how far you have already tilted — the model
  // fights the hand holding it.
  const p = { x: 1, y: 0, z: 0 };
  const both = S.rotate(p, 0.5, 0.5);
  const manual = (() => {
    const a = S.rotate(p, 0.5, 0);      // yaw first
    return S.rotate({ x: a.x, y: a.y, z: a.z }, 0, 0.5);
  })();
  near(both.x, manual.x);
  near(both.y, manual.y);
  near(both.z, manual.z);
});

/* -------------------------------------------------------- projection ----- */
console.log('\nProjection');

const CAM = { distance: 100, fov: 100, cx: 200, cy: 150, yaw: 0, pitch: 0 };

t('a point at the origin lands at the centre of the canvas', () => {
  const q = S.project({ x: 0, y: 0, z: 0 }, CAM);
  near(q.x, 200);
  near(q.y, 150);
});

t('screen y is inverted, so a higher value draws higher up', () => {
  const up = S.project({ x: 0, y: 10, z: 0 }, CAM);
  const down = S.project({ x: 0, y: -10, z: 0 }, CAM);
  assert.ok(up.y < down.y, 'a larger y must draw nearer the top');
});

t('further away is smaller', () => {
  const near_ = S.project({ x: 10, y: 0, z: -50 }, CAM);
  const far = S.project({ x: 10, y: 0, z: 50 }, CAM);
  assert.ok(near_.scale > far.scale);
  assert.ok(Math.abs(near_.x - CAM.cx) > Math.abs(far.x - CAM.cx));
});

t('depth is reported so callers can sort without re-deriving it', () =>
  assert.equal(S.project({ x: 0, y: 0, z: 42 }, CAM).depth, 42));

t('a point behind the camera is clamped, not flipped through the origin', () => {
  // Without the clamp the denominator goes negative and the point mirrors to
  // the far side of the canvas — a point that vanishes and reappears mid-drag.
  const q = S.project({ x: 10, y: 0, z: -500 }, CAM);
  assert.ok(isFinite(q.x) && isFinite(q.y));
  assert.ok(q.scale > 0, 'scale must stay positive');
});

t('place() rotates before it projects', () => {
  const cam = { ...CAM, yaw: Math.PI / 2 };
  const viaPlace = S.place({ x: 1, y: 0, z: 0 }, cam);
  const manual = S.project(S.rotate({ x: 1, y: 0, z: 0 }, Math.PI / 2, 0), cam);
  near(viaPlace.x, manual.x);
  near(viaPlace.y, manual.y);
});

/* ------------------------------------------------------------ scales ----- */
console.log('\nAxis scales');

t('ticks land on values a person would have chosen', () => {
  assert.deepEqual(S.niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(S.niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
});
t('ticks on a fractional range come back clean, not 0.6000000000000001', () =>
  assert.deepEqual(S.niceTicks(0, 1, 5), [0, 0.2, 0.4, 0.6, 0.8, 1]));
t('a sub-unit range keeps its precision', () =>
  assert.deepEqual(S.niceTicks(0, 0.35, 4), [0, 0.1, 0.2, 0.3]));
t('a tick that lands exactly on the maximum is kept', () => {
  // Floating point drift used to drop it, and the top of an axis is the one
  // you most want named.
  const ticks = S.niceTicks(0, 50, 5);
  assert.equal(ticks[ticks.length - 1], 50);
});
t('a range that does not start at zero still gets round ticks', () => {
  const ticks = S.niceTicks(37, 92, 4);
  assert.ok(ticks.every((v) => Math.abs(v / 20 - Math.round(v / 20)) < 1e-9), JSON.stringify(ticks));
});
t('a degenerate range does not hang or divide by zero', () => {
  assert.deepEqual(S.niceTicks(5, 5, 5), [5]);
  assert.deepEqual(S.niceTicks(NaN, 10, 5), []);
});

t('a value maps into the cube centred on zero', () => {
  near(S.norm(0, 0, 10), -0.5);
  near(S.norm(10, 0, 10), 0.5);
  near(S.norm(5, 0, 10), 0);
});
t('a flat axis centres instead of dividing by zero', () =>
  assert.equal(S.norm(7, 7, 7), 0));
t('a non-finite value maps to nothing rather than to the middle', () => {
  // Returning 0 would silently plant a missing reading at the centre of the
  // cube, where it looks like a real, average day.
  assert.equal(S.norm(NaN, 0, 10), null);
  assert.equal(S.norm(Infinity, 0, 10), null);
});

/* ------------------------------------------------------------ extent ----- */
console.log('\nExtents');

const SERIES = [
  { points: [{ v: 10 }, { v: 30 }, { v: null }] },
  { points: [{ v: 5 }, { v: 20 }] },
];

t('the extent spans every series, not just the first', () => {
  const e = S.extent(SERIES, 'v');
  assert.ok(e.min < 5 && e.max > 30);
});
t('it is padded, so no point sits welded to the wall of the box', () => {
  const e = S.extent(SERIES, 'v');
  assert.ok(e.min < 5, 'padded below');
  assert.ok(e.max > 30, 'padded above');
});
t('missing values are skipped rather than read as zero', () => {
  const e = S.extent([{ points: [{ v: 10 }, { v: null }, { v: undefined }] }], 'v');
  assert.ok(e.min > 0, 'a null must not drag the floor to zero: ' + e.min);
});
t('a single distinct value still produces a usable box', () => {
  const e = S.extent([{ points: [{ v: 7 }, { v: 7 }] }], 'v');
  assert.ok(e.max > e.min, 'a flat axis needs width to draw in');
  assert.equal(e.flat, true);
});
t('no data at all is reported rather than guessed at', () => {
  const e = S.extent([{ points: [] }], 'v');
  assert.equal(e.empty, true);
});

/* ------------------------------------------------------------ easing ----- */
console.log('\nEasing');

t('approach moves toward the target and never past it', () => {
  let v = 0;
  for (let i = 0; i < 200; i++) v = S.approach(v, 10, 0.12);
  assert.ok(v > 9.99 && v <= 10, v);
});
t('approach is stable when it is already there', () =>
  assert.equal(S.approach(5, 5, 0.12), 5));

/* --------------------------------------------------------- the cube ------ */
console.log('\nThe wireframe box');

t('the box has eight corners and twelve edges', () => {
  assert.equal(S.CORNERS.length, 8);
  assert.equal(S.EDGES.length, 12);
});
t('every edge joins two real corners', () =>
  assert.ok(S.EDGES.every(([a, b]) => S.CORNERS[a] && S.CORNERS[b] && a !== b)));
t('every edge is a cube edge, not a diagonal', () => {
  // Two corners of a unit cube are an edge only if they differ on exactly one
  // axis. A diagonal in this list would draw a box that is subtly not a box.
  for (const [a, b] of S.EDGES) {
    const diff = S.CORNERS[a].filter((v, i) => v !== S.CORNERS[b][i]).length;
    assert.equal(diff, 1, `corners ${a},${b} differ on ${diff} axes`);
  }
});
t('every corner is used by exactly three edges', () => {
  const seen = new Map();
  for (const [a, b] of S.EDGES) {
    seen.set(a, (seen.get(a) || 0) + 1);
    seen.set(b, (seen.get(b) || 0) + 1);
  }
  for (let i = 0; i < 8; i++) assert.equal(seen.get(i), 3, `corner ${i}`);
});

/* -------------------------------------------------------- hit testing ---- */
console.log('\nHit testing');

/** A Plot needs a canvas; this is the smallest one that satisfies it. */
function fakeCanvas(width = 400, height = 300) {
  const noop = () => {};
  return {
    width, height,
    style: {},
    getContext: () => new Proxy({}, { get: () => noop }),
    getBoundingClientRect: () => ({ width, height, left: 0, top: 0 }),
    addEventListener: noop,
    removeEventListener: noop,
  };
}

{
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};

  const plot = new S.Plot(fakeCanvas());
  plot.setData([
    { colour: '#f00', point: 'circle', points: [
      { px: -0.4, py: -0.4, pz: 0, label: 'A' },
      { px: 0.4, py: 0.4, pz: 0, label: 'B' },
    ] },
  ], { x: { label: 'Spend', min: 0, max: 10 } });
  plot.cam.yaw = 0;
  plot.cam.pitch = 0;

  const a = plot.pointAt(plot.series[0].points[0]);

  t('a click on a point finds it', () => {
    const hit = plot.hitTest(a.x, a.y, 14);
    assert.ok(hit, 'nothing hit');
    assert.equal(hit.point.label, 'A');
  });
  t('a click in empty space finds nothing rather than the nearest thing', () =>
    assert.equal(plot.hitTest(a.x + 200, a.y + 200, 14), null));
  t('a hidden series cannot be hit', () => {
    plot.series[0].hidden = true;
    assert.equal(plot.hitTest(a.x, a.y, 14), null);
    plot.series[0].hidden = false;
  });
  t('a point with no position is skipped', () => {
    plot.series[0].points.push({ px: null, py: null, pz: null, label: 'gap' });
    assert.ok(plot.hitTest(a.x, a.y, 14).point.label === 'A');
    plot.series[0].points.pop();
  });

  t('pitch is clamped short of straight down', () => {
    // Past vertical the world flips and the drag direction inverts under the
    // hand holding it, which reads as the control breaking.
    plot.setAngles(0, 99);
    assert.ok(plot.cam.targetPitch <= 1.45, plot.cam.targetPitch);
    plot.setAngles(0, -99);
    assert.ok(plot.cam.targetPitch >= -1.45, plot.cam.targetPitch);
  });

  t('the entrance runs once and settles at fully shown', () => {
    plot.reveal = 0;
    plot.spin = false;
    for (let i = 0; i < 200; i++) plot.step();
    assert.equal(plot.reveal, 1);
  });

  t('a drag target is eased toward, not snapped to', () => {
    plot.spin = false;
    plot.cam.yaw = 0;
    plot.cam.targetYaw = 1;
    plot.step();
    assert.ok(plot.cam.yaw > 0 && plot.cam.yaw < 1, plot.cam.yaw);
  });
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
