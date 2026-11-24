// 扉の開閉。扉は閉じた状態('D')で作られ、立っているユニットが上下左右に隣接する(か上に立つ)と開く('+')。
// 開いた扉は、最後に誰かが隣・上にいたターンから RULES_DOOR.openTurns ターンたつと自動で閉まる。
// 閉じた扉は視線を遮る(map.ts の isOpaque)が、通ることはできる(近づけば必ず開くため、経路探索は変えない)。
import { DIR_LIST, step, tileAt } from './map';
import type { FloorMap, Pos, Unit } from './types';

export const DOOR = {
  /** 開いた扉が自動で閉まるまでのターン数 */
  openTurns: 5,
};

const key = (p: Pos) => `${p.x},${p.y}`;

function setTile(map: FloorMap, p: Pos, c: string): void {
  const row = map.tiles[p.y];
  map.tiles[p.y] = row.slice(0, p.x) + c + row.slice(p.x + 1);
}

/** u が扉 p の上か、上下左右の隣にいるか */
function touches(u: Pos, p: Pos): boolean {
  return Math.abs(u.x - p.x) + Math.abs(u.y - p.y) <= 1;
}

/** 立っているユニットの上と上下左右の閉じた扉を開ける。開けたら true */
export function openDoorsNear(map: FloorMap, units: Unit[]): boolean {
  let opened = false;
  for (const u of units) {
    if (u.down) continue;
    for (const p of [{ x: u.x, y: u.y }, ...DIR_LIST.map((d) => step(u, d))]) {
      if (tileAt(map, p.x, p.y) !== 'D') continue;
      setTile(map, p, '+');
      (map.doors ??= {})[key(p)] = DOOR.openTurns;
      opened = true;
    }
  }
  return opened;
}

/**
 * ターンの終わりの扉の時間経過。隣・上に立っているユニットがいれば残りターンを戻し、
 * いなければ 1 減らし、0 になったら閉める(誰か(気絶者を含む)が扉の上にいる間は閉めない)。
 * 閉めたら true
 */
export function tickDoors(map: FloorMap, units: Unit[]): boolean {
  let closed = false;
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (map.tiles[y][x] !== '+') continue;
      const p = { x, y };
      const doors = (map.doors ??= {});
      const k = key(p);
      if (units.some((u) => !u.down && touches(u, p))) {
        doors[k] = DOOR.openTurns;
        continue;
      }
      const left = (doors[k] ?? DOOR.openTurns) - 1;
      if (left > 0 || units.some((u) => u.x === x && u.y === y)) {
        doors[k] = Math.max(0, left);
        continue;
      }
      delete doors[k];
      setTile(map, p, 'D');
      closed = true;
    }
  }
  return closed;
}
