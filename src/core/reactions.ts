// 条件付き行動の発動判定。どちらも「このティックに動いてきた敵」にだけ反応する
// (その場にとどまる敵には通常の攻撃を使う)。
// - 警戒射撃(overwatch): 動いて射程・射線・視界の中にいる最も近い敵を撃つ
// - 迎撃(intercept): 動いて隣接(斜めを含む)した敵を近接攻撃する
// 追尾・護衛・敵を見たら停止は移動処理側(resolve.ts)で扱う。
import { unitDef } from '../data/units';
import { hasLos, linePoints } from './los';
import { adjacent, dist2 } from './map';
import type { FloorMap, Pos, Unit } from './types';
import { unitSees } from './vision';

/** from から target を撃ったとき、射線上で最初に当たるのが target か(味方などが間にいないか) */
export function clearShot(units: Unit[], shooter: Unit, from: Pos, target: Unit): boolean {
  return linePoints(from, target).every(
    (p) => (p.x === target.x && p.y === target.y) || !units.some((o) => o !== shooter && !o.down && o.x === p.x && o.y === p.y),
  );
}

export function triggerReaction(
  map: FloorMap,
  u: Unit,
  mode: 'overwatch' | 'intercept',
  units: Unit[],
  moved: Set<string>,
): Unit | undefined {
  const foes = units.filter((f) => f.side !== u.side && !f.down && moved.has(f.id));
  if (mode === 'intercept') {
    const adj = foes.filter((f) => adjacent(map, u, f));
    adj.sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id));
    return adj[0];
  }
  const range = unitDef(u.defId).range;
  // 自動で撃つ条件付き行動は、射線上で最初に当たるのが狙う敵のとき(味方越しでないとき)だけ発動する
  const cands = foes.filter((f) => dist2(u, f) <= range * range && hasLos(map, u, f) && unitSees(map, u, f) && clearShot(units, u, u, f));
  cands.sort((a, b) => dist2(u, a) - dist2(u, b) || a.id.localeCompare(b.id));
  return cands[0];
}
