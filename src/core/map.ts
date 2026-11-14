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

/** 視線を遮るか */
export function isOpaque(map: FloorMap, x: number, y: number): boolean {
  return tileAt(map, x, y) === '#';
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

export function dist2(a: Pos, b: Pos): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function idx(map: FloorMap, x: number, y: number): number {
  return y * map.w + x;
}
