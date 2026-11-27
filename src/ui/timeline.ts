// 予約の時間軸(4 人 × 8 ティック)と、対象を選ぶモードで届くマスの計算。DOM に依存しない部分だけを置く。
import { RULES, expandPlan, fillPlan, planCost, spellCost, type Step } from '../core/actions';
import { hasLos } from '../core/los';
import { adjacent, dirBetween, dist2, isWalkable, nearOrSame, step } from '../core/map';
import { canShove, chargeRoute, inReach } from '../core/resolve';
import { spellRange, stats } from '../core/stats';
import { AP_PER_TURN, TICKS_PER_TURN, type Action, type GameState, type Plans, type Pos, type Unit } from '../core/types';
import { SPELLS } from '../data/units';
import { hostile } from '../core/vision';
import type { Mode } from './panel';

/**
 * 予約どおりに動いたときの各ティックの終わりの予定位置(添字 0 がターンの初め、t が t ティック目の終わり)。
 * 他のユニットとの競合は考えない(ただし重装ユニットが小さい敵を押し返せない壁際の詰まり・大きい敵への衝突は考慮する)。
 * 接近攻撃は予約の時点の経路の目安をたどる
 */
export function tickPositions(st: GameState, u: Unit, actions: Action[]): Pos[] {
  let p: Pos = { x: u.x, y: u.y };
  const out: Pos[] = [p];
  let route: Pos[] | null = null;
  let ri = 0;
  let skipNextMove = false;
  for (const s of expandPlan(actions)) {
    if (s.k === 'move') {
      if (skipNextMove) {
        skipNextMove = false;
      } else {
        const n = step(p, s.action.dir);
        const stepKind = canStepPreview(st, u, p, n);
        if (stepKind) {
          p = n;
          if (stepKind === 'shove') skipNextMove = true;
        }
      }
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

/** 予定位置の計算で p → n へ進めるか(壁は不可。敵がいるマスは、押し返せる場合だけ 'shove' を返す) */
function canStepPreview(st: GameState, u: Unit, p: Pos, n: Pos): false | 'walk' | 'shove' {
  if (!isWalkable(st.map, n.x, n.y)) return false;
  if (RULES.passThroughFoes) return 'walk';
  const foe = st.units.find((o) => o !== u && !o.down && o.side !== u.side && o.x === n.x && o.y === n.y);
  if (!foe) return 'walk';
  if (!canShove(u, foe)) return false;
  const dir = dirBetween(p, n);
  if (!dir) return false;
  const back = step(n, dir);
  return isWalkable(st.map, back.x, back.y) && !st.units.some((o) => !o.down && o.x === back.x && o.y === back.y) ? 'shove' : false;
}

/**
 * キャラ u を選んで mode の操作をしているとき、盤面と時間軸で基準にするティック(0〜8)。
 * - 移動・通常モード: 今から行動を足すティック(= 予約済み AP)
 * - 対象を選ぶモード(攻撃・魔法・薬・担ぐ): その行動が発動するティック(= min(8, 予約済み AP + 行動コスト))
 */
export function cursorTickFor(actions: Action[], mode: Mode): number {
  const used = planCost(actions);
  const cost = modeHitCost(mode);
  return Math.max(0, Math.min(TICKS_PER_TURN, used + cost));
}

function modeHitCost(mode: Mode): number {
  switch (mode) {
    case 'attack':
      return RULES.attackCost;
    case 'power':
      return RULES.powerCost;
    case 'fireball':
    case 'smite':
    case 'heal':
    case 'revive':
    case 'trip':
      return spellCost(mode);
    case 'potion':
      return RULES.itemCost;
    case 'carry':
      return 1;
    default:
      return 0;
  }
}

/** 指定ティック t(0〜8)の終わりにおける全ユニットの位置(味方は予約から進めた予定位置、敵は現在位置) */
export function unitsAtTick(st: GameState, plans: Plans, tick: number): Unit[] {
  const t = Math.max(0, Math.min(TICKS_PER_TURN, tick));
  return st.units.map((u) => {
    if (u.side !== 'party' || u.down) return u;
    const at = tickPositions(st, u, plans[u.id] ?? [])[t];
    return at.x === u.x && at.y === u.y ? u : { ...u, x: at.x, y: at.y };
  });
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
  // 余った AP は、敵が見えていれば防御、見えていなければただの待機(回復しない)
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
      return s.idle ? '待' : '休';
    case 'watch':
      return '迎';
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
export function reachInfo(st: GameState, u: Unit, from: Pos, mode: Mode, units: Unit[] = st.units): { tiles: Pos[]; targets: Unit[]; blind: Pos[] } {
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
  /** 火球: 射程内だが射線の通らない(見えない)マス。撃てるが着弾点がずれる */
  const blind: Pos[] = [];
  for (let y = Math.max(0, from.y - r); y <= Math.min(map.h - 1, from.y + r); y++) {
    for (let x = Math.max(0, from.x - r); x <= Math.min(map.w - 1, from.x + r); x++) {
      const p = { x, y };
      if (!isWalkable(map, x, y) || !st.explored[y * map.w + x]) continue;
      if (ok(p)) tiles.push(p);
      else if (mode === 'fireball' && dist2(from, p) <= r * r) blind.push(p);
    }
  }
  const others = units.filter((o) => o.id !== u.id);
  const selfAt = units.find((o) => o.id === u.id) ?? u;
  let targets: Unit[] = [];
  if (mode === 'attack' || mode === 'power') targets = others.filter((o) => hostile(u, o) && !o.down && inReach(map, u, from, o, others));
  else if (mode === 'trip') targets = others.filter((o) => hostile(u, o) && !o.down && ok(o));
  else if (mode === 'heal') targets = [selfAt, ...others].filter((o) => o.side === u.side && !o.down && ok(o));
  else if (mode === 'potion') targets = [selfAt, ...others].filter((o) => o.side === u.side && !o.down && ok(o));
  else if (near) targets = others.filter((o) => o.side === u.side && o.down && ok(o));
  return { tiles, targets, blind };
}
