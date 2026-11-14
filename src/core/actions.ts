import { SPELLS, unitDef } from '../data/units';
import { AP_PER_TURN, type Action, type Unit } from './types';

/** 行動コストなどの調整用の値(自動対戦で比較できるよう書き換え可能にしてある) */
export const RULES = {
  attackCost: 3,
  spellCost: 3,
  /** 休憩(敵が見えない状態で全員が待機だけのターン)での回復量 */
  restHpRatio: 0.1,
  restMp: 2,
};

/** 予約が待機だけ(または空)か */
export function isRestPlan(actions: Action[] | undefined): boolean {
  return !actions || actions.every((a) => a.type === 'wait');
}

export function actionCost(a: Action): number {
  switch (a.type) {
    case 'move':
    case 'guard':
    case 'wait':
      return 1;
    case 'attack':
      return RULES.attackCost;
    case 'spell':
      return RULES.spellCost;
    case 'overwatch':
    case 'intercept':
    case 'follow':
    case 'escort':
      return a.ticks;
  }
}

export function planCost(actions: Action[]): number {
  return actions.reduce((s, a) => s + actionCost(a), 0);
}

export function apLeft(actions: Action[]): number {
  return AP_PER_TURN - planCost(actions);
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
  | { k: 'recover' };

export function expandPlan(actions: Action[]): Step[] {
  const steps: Step[] = [];
  for (const a of actions) {
    switch (a.type) {
      case 'move':
        steps.push({ k: 'move', action: a });
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
