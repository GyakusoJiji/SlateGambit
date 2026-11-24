import type { Dir, FloorMap, Pos } from './types';

export const DIRS: Record<Dir, Pos> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export const DIR_LIST: Dir[] = ['N', 'E', 'S', 'W'];

export function parseMap(rows: string[]): FloorMap {
  const w = Math.max(...rows.map((r) => r.length));
  const tiles = rows.map((r) => r.padEnd(w, '#'));
  return { w, h: rows.length, tiles };
}

export function tileAt(map: FloorMap, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return '#';
  return map.tiles[y][x];
}

export function isWalkable(map: FloorMap, x: number, y: number): boolean {
  return tileAt(map, x, y) !== '#';
}

/** 視線を遮るか(壁と閉じた扉) */
export function isOpaque(map: FloorMap, x: number, y: number): boolean {
  const t = tileAt(map, x, y);
  return t === '#' || t === 'D';
}

export function step(p: Pos, dir: Dir): Pos {
  const d = DIRS[dir];
  return { x: p.x + d.x, y: p.y + d.y };
}

export function dirBetween(a: Pos, b: Pos): Dir | null {
  for (const d of DIR_LIST) {
    if (a.x + DIRS[d].x === b.x && a.y + DIRS[d].y === b.y) return d;
  }
  return null;
}

export function samePos(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * 近接攻撃などが届く「隣接」: 上下左右と斜めの 8 マス。
 * ただし斜めは、間の 2 マス(上下と左右)がどちらも壁なら隣接とみなさない(壁の角の隙間越しには届かない)。
 * 移動は上下左右だけで、斜めには動けない
 */
export function adjacent(map: FloorMap, a: Pos, b: Pos): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return false;
  if (dx === 0 || dy === 0) return true;
  return isWalkable(map, a.x + dx, a.y) || isWalkable(map, a.x, a.y + dy);
}

/** 隣接しているか、同じマスにいる(担ぐ・蘇生の届く範囲) */
export function nearOrSame(map: FloorMap, a: Pos, b: Pos): boolean {
  return samePos(a, b) || adjacent(map, a, b);
}

export function dist2(a: Pos, b: Pos): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function idx(map: FloorMap, x: number, y: number): number {
  return y * map.w + x;
}
