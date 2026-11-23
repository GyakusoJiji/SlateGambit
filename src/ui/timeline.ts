// 予約の時間軸(4 人 × 8 ティック)と、対象を選ぶモードで届くマスの計算。DOM に依存しない部分だけを置く。
import { expandPlan, fillPlan, planCost, type Step } from '../core/actions';
import { hasLos } from '../core/los';
import { adjacent, dist2, isWalkable, nearOrSame, step } from '../core/map';
import { chargeRoute, inReach } from '../core/resolve';
import { spellRange, stats } from '../core/stats';
import { AP_PER_TURN, type Action, type GameState, type Pos, type Unit } from '../core/types';
import { SPELLS } from '../data/units';
import type { Mode } from './panel';

/**
 * 予約どおりに動いたときの各ティックの終わりの予定位置(添字 0 がターンの初め、t が t ティック目の終わり)。
 * 他のユニットとの競合は考えない。接近攻撃は予約の時点の経路の目安をたどる
 */
export function tickPositions(st: GameState, u: Unit, actions: Action[]): Pos[] {
  let p: Pos = { x: u.x, y: u.y };
  const out: Pos[] = [p];
  let route: Pos[] | null = null;
  let ri = 0;
  for (const s of expandPlan(actions)) {
    if (s.k === 'move') {
      const n = step(p, s.action.dir);
      if (isWalkable(st.map, n.x, n.y)) p = n;
    } else if (s.k === 'charge') {
      const t = st.units.find((x) => x.id === s.target);
      if (t && !route) {
        route = chargeRoute(st.map, u, p, t, st.units) ?? [p];
        ri = 0;
      }
      if (route && ri < route.length - 1) p = route[++ri];
    }
    out.push(p);
  }
  return out;
}

/** 時間軸の 1 マスの表示 */
export interface TickCell {
  glyph: string;
  /** 攻撃・魔法が発動するティック */
  hit: boolean;
  /** 予約していない(残り AP を防御か休憩で埋める)ティック */
  fill: boolean;
}

const ARROW = { N: '↑', E: '→', S: '↓', W: '←' } as const;

/** 1 人分の 8 ティックの表示。filler は予約していない AP の扱い(敵が見えていれば防御) */
export function tickCells(actions: Action[], filler: 'guard' | 'wait'): TickCell[] {
  const used = planCost(actions);
  const steps = expandPlan(fillPlan(actions, filler));
  return steps.slice(0, AP_PER_TURN).map((s, i) => ({ glyph: glyphOf(s), hit: s.k === 'strike', fill: i >= used }));
}

function glyphOf(s: Step): string {
  switch (s.k) {
    case 'move':
      return ARROW[s.action.dir];
    case 'windup':
      return '構';
    case 'strike':
      return s.action.type === 'attack' ? (s.action.power ? '強' : '攻') : s.action.type === 'item' ? '薬' : SPELLS[s.action.spell].name[0];
    case 'guard':
      return '防';
    case 'cover':
      return 'か';
    case 'wait':
      return '休';
    case 'watch':
      return '見';
    case 'charge':
      return '接';
    case 'carry':
      return '担';
    case 'drop':
      return '降';
    default:
      return '';
  }
}

/** 対象を選ぶモードの射程(マス)。近接・隣接で使うものは 1 */
function modeRange(u: Unit, mode: Mode): number {
  switch (mode) {
    case 'attack':
    case 'power':
      return stats(u).range;
    case 'fireball':
    case 'smite':
    case 'heal':
    case 'trip':
      return spellRange(u, mode);
    default:
      return 1;
  }
}

/**
 * 対象を選ぶモードで、予定位置 from から届くマス(壁を除く・探索済みだけ)と、届く相手。
 * 近接の攻撃は隣接、担ぐ・蘇生は隣接か同じマス、それ以外は射程内で射線が通るマス。
 * 届く相手は、攻撃なら射線上に味方などがいない敵、足払いは敵、回復は味方、担ぐ・蘇生は気絶した味方
 */
export function reachInfo(st: GameState, u: Unit, from: Pos, mode: Mode): { tiles: Pos[]; targets: Unit[] } {
  const { map } = st;
  const r = modeRange(u, mode);
  const near = mode === 'carry' || mode === 'revive' || mode === 'potion';
  const melee = (mode === 'attack' || mode === 'power') && r <= 1;
  const ok = (p: Pos): boolean => {
    if (near) return nearOrSame(map, from, p);
    if (melee) return adjacent(map, from, p);
    return dist2(from, p) <= r * r && hasLos(map, from, p);
  };
  const tiles: Pos[] = [];
  for (let y = Math.max(0, from.y - r); y <= Math.min(map.h - 1, from.y + r); y++) {
    for (let x = Math.max(0, from.x - r); x <= Math.min(map.w - 1, from.x + r); x++) {
      const p = { x, y };
      if (isWalkable(map, x, y) && st.explored[y * map.w + x] && ok(p)) tiles.push(p);
    }
  }
  const others = st.units.filter((o) => o.id !== u.id);
  let targets: Unit[] = [];
  if (mode === 'attack' || mode === 'power') targets = others.filter((o) => o.side !== u.side && !o.down && inReach(map, u, from, o, others));
  else if (mode === 'trip') targets = others.filter((o) => o.side !== u.side && !o.down && ok(o));
  else if (mode === 'heal') targets = [u, ...others].filter((o) => o.side === u.side && !o.down && ok(o));
  else if (mode === 'potion') targets = [u, ...others].filter((o) => o.side === u.side && !o.down && ok(o));
  else if (near) targets = others.filter((o) => o.side === u.side && o.down && ok(o));
  return { tiles, targets };
}
