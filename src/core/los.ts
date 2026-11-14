import { dist2, isOpaque } from './map';
import type { FloorMap, Pos } from './types';

/** a から b への直線上のマス(a を除き b を含む)。Bresenham */
export function linePoints(a: Pos, b: Pos): Pos[] {
  const pts: Pos[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  while (x !== b.x || y !== b.y) {
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
    pts.push({ x, y });
  }
  return pts;
}

/** 壁に遮られずに a から b が見えるか(端点の壁は問わない) */
export function hasLos(map: FloorMap, a: Pos, b: Pos): boolean {
  const pts = linePoints(a, b);
  for (let i = 0; i < pts.length - 1; i++) {
    if (isOpaque(map, pts[i].x, pts[i].y)) return false;
  }
  return true;
}

export function inSight(map: FloorMap, from: Pos, to: Pos, radius: number): boolean {
  return dist2(from, to) <= radius * radius && hasLos(map, from, to);
}

/** 視点から見えるマスを mask に 1 として書き込む */
export function markVisible(map: FloorMap, from: Pos, radius: number, mask: Uint8Array | number[]): void {
  const r2 = radius * radius;
  for (let y = Math.max(0, from.y - radius); y <= Math.min(map.h - 1, from.y + radius); y++) {
    for (let x = Math.max(0, from.x - radius); x <= Math.min(map.w - 1, from.x + radius); x++) {
      const dx = x - from.x;
      const dy = y - from.y;
      if (dx * dx + dy * dy > r2) continue;
      if (hasLos(map, from, { x, y })) mask[y * map.w + x] = 1;
    }
  }
}
