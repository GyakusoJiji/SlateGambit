import { SPELLS, unitDef } from '../data/units';
import { AP_PER_TURN, type Action, type Unit } from './types';

/** 行動コストなどの調整用の値(自動対戦で比較できるよう書き換え可能にしてある) */
export const RULES = {
  attackCost: 3,
  spellCost: 3,
  /** 休憩(敵が見えない状態で全員が待機だけのターン)での回復量 */
  restHpRatio: 0.1,
  restMp: 2,
  /** 敵のいるマスも通り抜けられるか(false なら味方のマスだけ通り抜けられる) */
  passThroughFoes: false,
  /** 気絶した味方を担いでいる間の移動コスト(1 マスあたり) */
  carryMoveCost: 2,
  /** 担がれたまま何ターン過ごすと、意識を取り戻す判定が始まるか */
  carryWakeTurns: 3,
  /** 判定が始まった後、ターンの終わりごとに意識を取り戻す確率 */
  carryWakeChance: 0.5,
  /** 意識を取り戻したときの HP */
  carryWakeHp: 8,
  /** 敵 AI が接近攻撃(相手の動きに合わせて追う)を選ぶ割合 */
  aiChargeRate: 0.5,
  /** 敵が仲間を呼ぶ範囲(マンハッタン距離)。0 で呼ばない */
  aiCallRange: 8,
};

/** 予約が待機だけ(または空)か */
export function isRestPlan(actions: Action[] | undefined): boolean {
  return !actions || actions.every((a) => a.type === 'wait');
}

export function actionCost(a: Action): number {
  switch (a.type) {
    case 'move':
      return a.slow ? RULES.carryMoveCost : 1;
    case 'guard':
    case 'wait':
    case 'carry':
    case 'drop':
      return 1;
    case 'attack':
      return RULES.attackCost;
    case 'spell':
      return RULES.spellCost;
    case 'overwatch':
    case 'intercept':
    case 'follow':
    case 'escort':
    case 'charge':
      return a.ticks;
  }
}

/** 予約 actions をすべて実行した時点で、気絶した味方を担いでいるか */
export function carryingAfter(unit: Unit, actions: Action[]): boolean {
  let c = !!unit.carrying;
  for (const a of actions) {
    if (a.type === 'carry') c = true;
    if (a.type === 'drop') c = false;
  }
  return c;
}

/** 担いでいる間に予約できる行動 */
const WHILE_CARRYING = new Set<Action['type']>(['move', 'guard', 'wait', 'drop']);

export function planCost(actions: Action[]): number {
  return actions.reduce((s, a) => s + actionCost(a), 0);
}

export function apLeft(actions: Action[]): number {
  return AP_PER_TURN - planCost(actions);
}

/**
 * 余った AP を埋める行動。
 * - 何も予約していないキャラは、戦闘中でも待機
 * - 一部だけ予約したキャラの残りは、戦闘中(敵が見えている)は防御、それ以外は待機
 */
export function fillerAction(actions: Action[], inCombat: boolean): Action {
  return { type: inCombat && actions.length > 0 ? 'guard' : 'wait' };
}

/** 予約の残り AP を埋めた計画を返す(元の配列は変えない) */
export function fillPlan(actions: Action[], inCombat: boolean): Action[] {
  const out = [...actions];
  const filler = fillerAction(actions, inCombat);
  for (let n = apLeft(out); n > 0; n--) out.push(filler);
  return out;
}

/** 予約全体の MP 消費 */
export function planMp(actions: Action[]): number {
  return actions.reduce((s, a) => s + (a.type === 'spell' ? SPELLS[a.spell].mp : 0), 0);
}

/** 予約に action を追加できるか。できない場合は理由を返す */
export function canAppend(unit: Unit, actions: Action[], action: Action): string | null {
  if (unit.down) return '気絶している';
  if (actionCost(action) > apLeft(actions)) return 'AP が足りない';
  const def = unitDef(unit.defId);
  if (action.type === 'spell') {
    if (!def.spells.includes(action.spell)) return 'その魔法は使えない';
    if (planMp(actions) + SPELLS[action.spell].mp > unit.mp) return 'MP が足りない';
  }
  if (action.type === 'overwatch' && def.range <= 1) return '遠隔攻撃を持たない';
  const carrying = carryingAfter(unit, actions);
  if (carrying && !WHILE_CARRYING.has(action.type)) return '担いでいる間はできない';
  if (!carrying && action.type === 'drop') return '誰も担いでいない';
  return null;
}

/**
 * ティック単位の工程。2 AP の攻撃は「構え → 攻撃」、3 AP の魔法は「詠唱 ×2 → 発動」となり、
 * 効果は最後のティックで発生する。
 */
export type Step =
  | { k: 'move'; action: Extract<Action, { type: 'move' }> }
  | { k: 'windup'; action: Action }
  | { k: 'strike'; action: Extract<Action, { type: 'attack' | 'spell' }> }
  | { k: 'guard' }
  | { k: 'wait' }
  | { k: 'watch'; mode: 'overwatch' | 'intercept' }
  | { k: 'follow'; target: string }
  | { k: 'escort'; target: string }
  | { k: 'charge'; target: string }
  | { k: 'carry'; target: string }
  | { k: 'drop' }
  | { k: 'recover' };

export function expandPlan(actions: Action[]): Step[] {
  const steps: Step[] = [];
  for (const a of actions) {
    switch (a.type) {
      case 'move':
        // 担いでいる間は、1 ティック踏ん張ってから 1 マス進む
        if (a.slow) for (let i = 1; i < RULES.carryMoveCost; i++) steps.push({ k: 'wait' });
        steps.push({ k: 'move', action: a });
        break;
      case 'charge':
        for (let i = 0; i < a.ticks; i++) steps.push({ k: 'charge', target: a.target });
        break;
      case 'carry':
        steps.push({ k: 'carry', target: a.target });
        break;
      case 'drop':
        steps.push({ k: 'drop' });
        break;
      case 'guard':
        steps.push({ k: 'guard' });
        break;
      case 'wait':
        steps.push({ k: 'wait' });
        break;
      case 'attack':
      case 'spell': {
        const n = actionCost(a);
        for (let i = 0; i < n - 1; i++) steps.push({ k: 'windup', action: a });
        steps.push({ k: 'strike', action: a });
        break;
      }
      case 'overwatch':
      case 'intercept':
        for (let i = 0; i < a.ticks; i++) steps.push({ k: 'watch', mode: a.type });
        break;
      case 'follow':
        for (let i = 0; i < a.ticks; i++) steps.push({ k: 'follow', target: a.target });
        break;
      case 'escort':
        for (let i = 0; i < a.ticks; i++) steps.push({ k: 'escort', target: a.target });
        break;
    }
  }
  while (steps.length < AP_PER_TURN) steps.push({ k: 'wait' });
  return steps.slice(0, AP_PER_TURN);
}
