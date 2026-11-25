// 条件付き行動の発動判定。
// - 警戒射撃(overwatch): このティックに動いて、射程・射線・視界の中にいる最も近い敵を撃つ
// - 迎撃(intercept): 隣接(斜めを含む)する敵を近接攻撃する。狙いは隣の敵からランダム。
//   動いてきた敵がいれば即座に、隣に動かない敵しかいなければ通常の攻撃と同じく溜めてから殴る(resolve.ts)
// 敵を見たら停止は移動処理側(resolve.ts)で扱う。
import { unitDef } from '../data/units';
import { hasLos, linePoints } from './los';
import { adjacent, dist2 } from './map';
import type { FloorMap, Pos, Unit } from './types';
import { hostile, unitSees } from './vision';

/** from から target を撃ったとき、射線上で最初に当たるのが target か(味方などが間にいないか) */
export function clearShot(units: Unit[], shooter: Unit, from: Pos, target: Unit): boolean {
  return linePoints(from, target).every(
    (p) => (p.x === target.x && p.y === target.y) || !units.some((o) => o !== shooter && !o.down && o.x === p.x && o.y === p.y),
  );
}

/** 迎撃の狙いの候補: 隣接(斜めを含む)する倒れていない敵(ID 順。乱数で選ぶときの並びを固定する) */
export function interceptCandidates(map: FloorMap, u: Unit, units: Unit[]): Unit[] {
  return units
    .filter((f) => hostile(u, f) && !f.down && adjacent(map, u, f))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** 警戒射撃の狙い: このティックに動いた敵のうち、射程・射線・視界の中で最も近い敵 */
export function overwatchTarget(map: FloorMap, u: Unit, units: Unit[], moved: Set<string>): Unit | undefined {
  const foes = units.filter((f) => hostile(u, f) && !f.down && moved.has(f.id));
  const range = unitDef(u.defId).range;
  // 自動で撃つ条件付き行動は、射線上で最初に当たるのが狙う敵のとき(味方越しでないとき)だけ発動する
  const cands = foes.filter((f) => dist2(u, f) <= range * range && hasLos(map, u, f) && unitSees(map, u, f) && clearShot(units, u, u, f));
  cands.sort((a, b) => dist2(u, a) - dist2(u, b) || a.id.localeCompare(b.id));
  return cands[0];
}
