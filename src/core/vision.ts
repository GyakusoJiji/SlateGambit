import { unitDef } from '../data/units';
import { inSight, markVisible } from './los';
import type { FloorMap, GameState, Pos, Side, Unit } from './types';

export function sightOf(u: Unit): number {
  return unitDef(u.defId).sight;
}

/** ユニット u が位置 p を見ているか */
export function unitSees(map: FloorMap, u: Pos & { defId: string }, p: Pos): boolean {
  return inSight(map, u, p, unitDef(u.defId).sight);
}

/** 地上の住人(住人に化けた盗人を含む)。敵の陣営だが、戦う相手としては扱わない */
export function isNeutral(u: { defId: string }): boolean {
  return u.defId === 'resident';
}

/** a から見て b が戦う相手か(別の陣営で、どちらも住人でない) */
export function hostile(a: Unit, b: Unit): boolean {
  return a.side !== b.side && !isNeutral(a) && !isNeutral(b);
}

/** 陣営全体の視界(合算) */
export function sideVisibleMask(map: FloorMap, units: Unit[], side: Side): Uint8Array {
  const mask = new Uint8Array(map.w * map.h);
  for (const u of units) {
    if (u.side !== side || u.down) continue;
    markVisible(map, u, sightOf(u), mask);
  }
  return mask;
}

/** 陣営から見えている相手陣営のユニット ID(倒れている相手は含まない) */
export function visibleFoes(map: FloorMap, units: Unit[], side: Side): Set<string> {
  const seen = new Set<string>();
  const watchers = units.filter((u) => u.side === side && !u.down && !isNeutral(u));
  for (const f of units) {
    if (f.side === side || f.down || isNeutral(f)) continue;
    if (watchers.some((w) => unitSees(map, w, f))) seen.add(f.id);
  }
  return seen;
}

/** パーティの視界を explored に反映する */
export function updateExplored(state: GameState): void {
  const mask = sideVisibleMask(state.map, state.units, 'party');
  for (let i = 0; i < mask.length; i++) if (mask[i]) state.explored[i] = 1;
}

export function foesOf(units: Unit[], side: Side): Unit[] {
  return units.filter((u) => u.side !== side && !u.down && !isNeutral(u));
}
