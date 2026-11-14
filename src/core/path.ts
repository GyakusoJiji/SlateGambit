import { DIR_LIST, DIRS, isWalkable } from './map';
import type { Dir, FloorMap, Pos } from './types';

/**
 * 幅優先探索で start から goal 条件を満たすマスまでの経路(方向の列)を返す。
 * blocked で通行不可のマスを追加できる。見つからなければ null。
 */
export function findPath(
  map: FloorMap,
  start: Pos,
  isGoal: (p: Pos) => boolean,
  blocked?: (p: Pos) => boolean,
  maxNodes = 4000,
): Dir[] | null {
  if (isGoal(start)) return [];
  const w = map.w;
  const prev = new Int32Array(map.w * map.h).fill(-1);
  const prevDir = new Int8Array(map.w * map.h);
  const startI = start.y * w + start.x;
  prev[startI] = startI;
  const queue: number[] = [startI];
  let head = 0;
  while (head < queue.length && head < maxNodes) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let d = 0; d < 4; d++) {
      const dv = DIRS[DIR_LIST[d]];
      const nx = cx + dv.x;
      const ny = cy + dv.y;
      if (!isWalkable(map, nx, ny)) continue;
      const ni = ny * w + nx;
      if (prev[ni] !== -1) continue;
      const np = { x: nx, y: ny };
      const goal = isGoal(np);
      if (!goal && blocked && blocked(np)) continue;
      prev[ni] = cur;
      prevDir[ni] = d;
      if (goal) {
        const dirs: Dir[] = [];
        let i = ni;
        while (i !== startI) {
          dirs.push(DIR_LIST[prevDir[i]]);
          i = prev[i];
        }
        return dirs.reverse();
      }
      queue.push(ni);
    }
  }
  return null;
}

export function pathTo(map: FloorMap, start: Pos, goal: Pos, blocked?: (p: Pos) => boolean): Dir[] | null {
  return findPath(map, start, (p) => p.x === goal.x && p.y === goal.y, blocked);
}

/** goal に(上下左右で)隣接するマスまでの経路 */
export function pathAdjacent(map: FloorMap, start: Pos, goal: Pos, blocked?: (p: Pos) => boolean): Dir[] | null {
  return findPath(map, start, (p) => Math.abs(p.x - goal.x) + Math.abs(p.y - goal.y) === 1, blocked);
}
