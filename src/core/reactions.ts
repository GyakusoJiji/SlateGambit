// 条件付き行動の発動判定。
// - 警戒射撃(overwatch): 射程・射線・視界に入った最も近い敵を撃つ
// - 迎撃(intercept): 上下左右に隣接した敵を近接攻撃する
// 追尾・護衛・敵を見たら停止は移動処理側(resolve.ts)で扱う。
import { unitDef } from '../data/units';
import { hasLos, linePoints } from './los';
import { dist2, manhattan } from './map';
import type { FloorMap, Unit } from './types';
import { unitSees } from './vision';

export function triggerReaction(
  map: FloorMap,
  u: Unit,
  mode: 'overwatch' | 'intercept',
  units: Unit[],
): Unit | undefined {
  const foes = units.filter((f) => f.side !== u.side && !f.down);
  if (mode === 'intercept') {
    const adj = foes.filter((f) => manhattan(u, f) === 1);
    adj.sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id));
    return adj[0];
  }
  const range = unitDef(u.defId).range;
  // 自動で撃つ条件付き行動は、射線上で最初に当たるのが狙う敵のとき(味方越しでないとき)だけ発動する
  const clearShot = (f: Unit) =>
    linePoints(u, f).every((p) => (p.x === f.x && p.y === f.y) || !units.some((o) => o !== u && !o.down && o.x === p.x && o.y === p.y));
  const cands = foes.filter((f) => dist2(u, f) <= range * range && hasLos(map, u, f) && unitSees(map, u, f) && clearShot(f));
  cands.sort((a, b) => dist2(u, a) - dist2(u, b) || a.id.localeCompare(b.id));
  return cands[0];
}
