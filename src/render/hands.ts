import type { Timeline } from '../timeline';
import { SCREEN_W, keyCenter } from './scene';
import type { Ctx2D, Pt } from './types';

/**
 * Drawn hands. Finger paths are deterministic: they are built from timeline events
 * (a finger lands on a key exactly at the press time), so a frame depends only on t.
 */

interface Waypoint extends Pt {
  arrive: number;
  leave: number;
  press: boolean;
}

interface Finger {
  kind: 'thumb' | 'index';
  /** Where the finger starts (its base, inside the palm). */
  base: Pt;
  /** Resting position. */
  home: Pt;
  /** Palm/fist centre and radii. */
  palm: { x: number; y: number; rx: number; ry: number };
  width: number;
  /** Travel time between keys, s. */
  travel: number;
  /** If the pause is longer than this, the finger returns home. */
  idle: number;
  /** Which way the knuckle bends (±1). */
  bend: number;
  waypoints: Waypoint[];
}

const DWELL = 0.06;
const PRESS_WINDOW = 0.08;

const SKIN = { fill: '#efc3a0', edge: '#c98e6b', nail: '#f9e2d6', nailEdge: '#ddb19c' };

function createFingers(mode: Timeline['mode']): Finger[] {
  if (mode === 'grandpa') {
    return [
      {
        kind: 'index',
        base: { x: 300, y: 960 },
        home: { x: 285, y: 790 },
        palm: { x: 330, y: 1010, rx: 110, ry: 95 },
        width: 26,
        travel: 0.35,
        idle: 4,
        bend: 1,
        waypoints: [],
      },
    ];
  }
  const thumb = (side: -1 | 1): Finger => ({
    kind: 'thumb',
    base: { x: SCREEN_W / 2 + side * 200, y: 890 },
    home: { x: SCREEN_W / 2 + side * 125, y: 805 },
    palm: { x: SCREEN_W / 2 + side * 245, y: 930, rx: 85, ry: 130 },
    width: 34,
    travel: 0.14,
    idle: 1.2,
    bend: side,
    waypoints: [],
  });
  return [thumb(-1), thumb(1)];
}

const planCache = new WeakMap<Timeline, Finger[]>();

function plan(tl: Timeline): Finger[] {
  const cached = planCache.get(tl);
  if (cached) return cached;

  const fingers = createFingers(tl.mode);
  const targets: { t: number; pos: Pt; press: boolean }[][] = fingers.map(() => []);
  let lastThumb = 1;

  for (const e of tl.events) {
    const pos = keyCenter(e.kb, e.type === 'send' ? 'send' : e.key);
    let fi = 0;
    if (fingers.length === 2) {
      if (e.type === 'send') fi = 1;
      else if (e.type === 'press' && e.key === 'space') fi = 1 - lastThumb; // space: alternate thumbs
      else fi = pos.x < SCREEN_W / 2 ? 0 : 1;
      if (e.type !== 'hover') lastThumb = fi;
    }
    targets[fi]!.push({ t: e.t, pos, press: e.type !== 'hover' });
  }

  fingers.forEach((f, i) => {
    const wps: Waypoint[] = [{ ...f.home, arrive: -Infinity, leave: -Infinity, press: false }];
    for (const tg of targets[i]!) {
      const prev = wps[wps.length - 1]!;
      if (prev.leave !== -Infinity && tg.t - prev.leave > f.idle + f.travel * 2) {
        wps.push({ ...f.home, arrive: prev.leave + f.travel, leave: tg.t - f.travel, press: false });
      } else if (prev.leave === -Infinity) {
        prev.leave = tg.t - f.travel;
      }
      wps.push({ ...tg.pos, arrive: tg.t, leave: tg.t + DWELL, press: tg.press });
    }
    const last = wps[wps.length - 1]!;
    if (last.leave === -Infinity) last.leave = Infinity;
    else wps.push({ ...f.home, arrive: last.leave + f.travel * 2, leave: Infinity, press: false });
    f.waypoints = wps;
  });

  planCache.set(tl, fingers);
  return fingers;
}

const ease = (p: number) => (p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function fingerAt(f: Finger, t: number): { tip: Pt; press: number } {
  const w = f.waypoints;
  let i = 0;
  while (i + 1 < w.length && w[i + 1]!.arrive <= t) i++;
  const a = w[i]!;
  const b = w[i + 1];

  let tip: Pt = a;
  if (b && t > a.leave) {
    const start = Math.max(a.leave, b.arrive - f.travel);
    const p = ease(clamp01((t - start) / Math.max(1e-6, b.arrive - start)));
    tip = { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
  }

  let press = 0;
  for (const wp of [a, b]) {
    if (wp?.press) press = Math.max(press, 1 - Math.abs(t - wp.arrive) / PRESS_WINDOW);
  }

  if (f.kind === 'index') {
    // Grandpa's tremor.
    tip = { x: tip.x + 1.6 * Math.sin(t * 13.1) + 1.1 * Math.sin(t * 7.3), y: tip.y + 1.4 * Math.sin(t * 11.7 + 1) };
  }
  return { tip, press: clamp01(press) };
}

/** pxPerPt — frame pixels per scene point (shadow sizes are in pixels). */
export function drawHands(ctx: Ctx2D, tl: Timeline, t: number, pxPerPt: number): void {
  for (const f of plan(tl)) {
    const { tip, press } = fingerAt(f, t);
    drawFinger(ctx, f, tip, press, pxPerPt);
  }
}

function drawFinger(ctx: Ctx2D, f: Finger, touch: Pt, press: number, pxPerPt: number): void {
  const lift = 1 - press;
  const w = f.width * (1 + 0.08 * lift);

  const dx = touch.x - f.base.x;
  const dy = touch.y - f.base.y;
  const len = Math.hypot(dx, dy) || 1;
  const dir = { x: dx / len, y: dy / len };
  const perp = { x: -dir.y, y: dir.x };

  // Fingertip sits slightly below the touch point so the key and its popup stay visible.
  const tip = { x: touch.x - dir.x * w * 0.3, y: touch.y - dir.y * w * 0.3 };
  const bend = len * 0.12 * f.bend * (perp.x < 0 ? -1 : 1);
  const knuckle = {
    x: (f.base.x + tip.x) / 2 + perp.x * bend,
    y: (f.base.y + tip.y) / 2 + perp.y * bend,
  };

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.28)';
  ctx.shadowBlur = (6 + 12 * lift) * pxPerPt;
  ctx.shadowOffsetX = (3 + 7 * lift) * pxPerPt;
  ctx.shadowOffsetY = (5 + 9 * lift) * pxPerPt;

  // Palm
  ctx.fillStyle = SKIN.fill;
  ctx.beginPath();
  ctx.ellipse(f.palm.x, f.palm.y, f.palm.rx, f.palm.ry, 0, 0, Math.PI * 2);
  ctx.fill();

  // Finger: outline, then fill
  const stroke = (color: string, width: number) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(f.base.x, f.base.y);
    ctx.quadraticCurveTo(knuckle.x, knuckle.y, tip.x, tip.y);
    ctx.stroke();
  };
  stroke(SKIN.edge, w + 3);
  ctx.shadowColor = 'transparent';
  stroke(SKIN.fill, w);

  // Palm outline on top of the finger's shadow
  ctx.strokeStyle = SKIN.edge;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(f.palm.x, f.palm.y, f.palm.rx, f.palm.ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = SKIN.fill;
  ctx.fill();
  stroke(SKIN.fill, w);

  // Nail, aligned with the last finger segment
  const angle = Math.atan2(tip.y - knuckle.y, tip.x - knuckle.x);
  ctx.translate(tip.x, tip.y);
  ctx.rotate(angle);
  ctx.fillStyle = SKIN.nail;
  ctx.strokeStyle = SKIN.nailEdge;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.roundRect(-w * 0.42, -w * 0.29, w * 0.58, w * 0.58, w * 0.22);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
