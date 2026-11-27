// 予約の時間軸(4 人 × 8 ティック)と、対象を選ぶモードで届くマスの計算。DOM に依存しない部分だけを置く。
import { RULES, expandPlan, fillPlan, planCost, spellCost, type Step } from '../core/actions';
import { hasLos } from '../core/los';
import { adjacent, dirBetween, dist2, isWalkable, nearOrSame, step } from '../core/map';
import { canShove, chargeRoute, inReach } from '../core/resolve';
import { delayAfterShove } from '../core/shove';
import { spellRange, stats } from '../core/stats';
import { AP_PER_TURN, TICKS_PER_TURN, type Action, type GameState, type Plans, type Pos, type Unit } from '../core/types';
import { SPELLS } from '../data/units';
import { hostile } from '../core/vision';
import type { Mode } from './panel';

/** 予約どおりに動いたときの見込み(予約画面の予定経路・予定位置・時間軸が共通で使う) */
export interface PlanPreview {
  /** 各ティックの終わりの予定位置(添字 0 がターンの初め、t が t ティック目の終わり。9 要素) */
  pos: Pos[];
  /** 押し返しの踏ん張りを反映した 8 ティック分の動き(踏ん張りのあとの予約は 1 ティックずつ遅れる) */
  steps: Step[];
  /** 押し返し: 押したティック・押した敵・敵の行き先 */
  pushes: { tick: number; id: string; to: Pos }[];
  /** 移動でたどるマス(予定経路の線。接近攻撃の経路は含めない) */
  path: Pos[];
  /** 移動を終えた予定位置(次に足す行動の起点) */
  end: Pos;
}

/**
 * 予約どおりに動いたときの見込み。エンジン(resolveTurn)と同じく、
 * 壁や押し返せない敵のマスには入らず、小さい敵を押し返したら敵を 1 マス後ろへ動かし、次のティックを踏ん張りにして残りを遅らせる。
 * 他のユニットの移動との競合は考えない。接近攻撃は予約の時点の経路の目安をたどる
 */
export function previewPlan(st: GameState, u: Unit, actions: Action[]): PlanPreview {
  const steps = expandPlan(actions);
  /** 押し返した敵の移動後の位置 */
  const moved = new Map<string, Pos>();
  const others = (): Unit[] => (moved.size === 0 ? st.units : st.units.map((o) => (moved.has(o.id) ? { ...o, ...moved.get(o.id)! } : o)));
  let p: Pos = { x: u.x, y: u.y };
  const pos: Pos[] = [p];
  const path: Pos[] = [p];
  const pushes: PlanPreview['pushes'] = [];
  let end = p;
  let route: Pos[] | null = null;
  let ri = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.k === 'move') {
      const n = step(p, s.action.dir);
      const r = canStepPreview(st.map, others(), u, p, n);
      if (r) {
        p = n;
        end = p;
        path.push(p);
        if (r !== 'walk') {
          moved.set(r.foe.id, r.back);
          pushes.push({ tick: i + 1, id: r.foe.id, to: r.back });
          delayAfterShove(steps, i + 1);
        }
      }
    } else if (s.k === 'charge') {
      const units = others();
      const t = units.find((x) => x.id === s.target);
      if (t && !route) {
        route = chargeRoute(st.map, u, p, t, units) ?? [p];
        ri = 0;
      }
      if (route && ri < route.length - 1) p = route[++ri];
    }
    pos.push(p);
  }
  return { pos, steps, pushes, path, end };
}

/** 予約どおりに動いたときの各ティックの終わりの予定位置(previewPlan の pos) */
export function tickPositions(st: GameState, u: Unit, actions: Action[]): Pos[] {
  return previewPlan(st, u, actions).pos;
}

/** 押し返しの踏ん張りで遅れるティック数(このターンに入らなくなる予約の AP) */
export function shoveDelay(st: GameState, u: Unit, actions: Action[]): number {
  return previewPlan(st, u, actions).pushes.length;
}

/** 予定位置の計算で p → n へ進めるか(壁は不可。敵がいるマスは、押し返せる場合だけ押す相手と行き先を返す) */
export function canStepPreview(
  map: GameState['map'],
  units: Unit[],
  u: Unit,
  p: Pos,
  n: Pos,
): false | 'walk' | { foe: Unit; back: Pos } {
  if (!isWalkable(map, n.x, n.y)) return false;
  if (RULES.passThroughFoes) return 'walk';
  const foe = units.find((o) => o.id !== u.id && !o.down && o.side !== u.side && o.x === n.x && o.y === n.y);
  if (!foe) return 'walk';
  if (!canShove(u, foe)) return false;
  const dir = dirBetween(p, n);
  if (!dir) return false;
  const back = step(n, dir);
  return isWalkable(map, back.x, back.y) && !units.some((o) => !o.down && o.x === back.x && o.y === back.y) ? { foe, back } : false;
}

/**
 * キャラ u を選んで mode の操作をしているとき、盤面と時間軸で基準にするティック(0〜8)。
 * - 移動・通常モード: 今から行動を足すティック(= 予約済み AP)
 * - 対象を選ぶモード(攻撃・魔法・薬・担ぐ): その行動が発動するティック(= min(8, 予約済み AP + 行動コスト))
 * どちらも、押し返しの踏ん張りで遅れる分(delay)を足す
 */
export function cursorTickFor(actions: Action[], mode: Mode, delay = 0): number {
  // delay: 押し返しの踏ん張りで遅れるティック数(shoveDelay)
  const used = planCost(actions) + delay;
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

/**
 * 指定ティック t(0〜8)の終わりにおける全ユニットの位置。
 * 味方は予約から進めた予定位置、敵は現在位置(ただし味方が t までに押し返す敵は押された先)
 */
export function unitsAtTick(st: GameState, plans: Plans, tick: number): Unit[] {
  const t = Math.max(0, Math.min(TICKS_PER_TURN, tick));
  const at = new Map<string, Pos>();
  for (const u of st.units) {
    if (u.side !== 'party' || u.down) continue;
    const pv = previewPlan(st, u, plans[u.id] ?? []);
    at.set(u.id, pv.pos[t]);
    for (const p of pv.pushes) if (p.tick <= t) at.set(p.id, p.to);
  }
  return st.units.map((u) => {
    const p = at.get(u.id);
    return !p || (p.x === u.x && p.y === u.y) ? u : { ...u, x: p.x, y: p.y };
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

/**
 * 1 人分の 8 ティックの表示。filler は予約していない AP の扱い(敵が見えていれば防御)。
 * at(盤面とキャラ)を渡すと押し返しを見込み、押すティックを「押」、踏ん張りを「踏」にして、後ろの予約を遅らせて並べる
 */
export function tickCells(actions: Action[], filler: 'guard' | 'wait', at?: { st: GameState; u: Unit }): TickCell[] {
  // 余った AP は、敵が見えていれば防御、見えていなければただの待機(回復しない)
  const used = planCost(actions);
  const filled = fillPlan(actions, filler);
  const pv = at ? previewPlan(at.st, at.u, filled) : null;
  const steps = pv ? pv.steps : expandPlan(filled);
  const shoveTicks = new Set(pv?.pushes.map((p) => p.tick));
  let delay = 0;
  return steps.slice(0, AP_PER_TURN).map((s, i) => {
    if (s.k === 'recover') delay++;
    return { glyph: shoveTicks.has(i + 1) ? '押' : glyphOf(s), hit: s.k === 'strike', fill: s.k !== 'recover' && i >= used + delay };
  });
}

function glyphOf(s: Step): string {
  switch (s.k) {
    case 'recover':
      return '踏';
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
