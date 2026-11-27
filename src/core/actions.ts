import { SPELLS, unitDef } from '../data/units';
import { spellMp } from './stats';
import { AP_PER_TURN, type Action, type SpellId, type Unit } from './types';

/** 行動コストなどの調整用の値(自動対戦で比較できるよう書き換え可能にしてある) */
export const RULES = {
  attackCost: 3,
  spellCost: 3,
  /** 強攻撃の AP と、ダメージの倍率 */
  powerCost: 5,
  powerMult: 2,
  /** かばうの AP(その間、防御もする) */
  coverCost: 3,
  /** 足払いで動けなくなるティック数 */
  stunTicks: 2,
  /** 見えない(射線の通らない)マスを狙った火球の着弾点のずれ(最大マス数) */
  fireballScatter: 1,
  /** 挟み撃ち(対象の反対側に味方がいる近接攻撃)のダメージ倍率。1 で無効 */
  flankMult: 1.25,
  /** 狙った敵が先に倒れていたら、届く別の敵に狙いを移す */
  retarget: true,
  /** 休憩(HP・MP が減っている状態での)のたびに、遠くから敵が現れる確率。0 で無効 */
  wanderChance: 0.15,
  /** 現れる敵の点数(+階)と、パーティからの最低距離(マンハッタン) */
  wanderBudget: 2,
  wanderDistance: 14,
  /** 8 ティック全部休憩したときの回復量(HP は最大値に対する割合) */
  restHpRatio: 0.2,
  restMp: 2,
  /** 野盗が盗むゴールド(基本 + 階 × 1 階あたり。所持金が少なければ所持金まで) */
  stealBase: 10,
  stealPerFloor: 10,
  /** 地上で味方が受けるダメージの倍率(地上ではゲージの減りを抑える) */
  surfaceDamageRatio: 0.5,
  /** 地上(城の中)に、ターンごとに魔物が入り込む確率(ごくまれ)と、その点数 */
  intrudeChance: 0.01,
  intrudeBudget: 2,
  /** 盗んだ野盗が、見られずに何ターン過ごすと逃げ切るか */
  banditEscapeTurns: 2,
  /** 回復の泉を使ったときに酸の泉に変わる確率。酸の泉に触れたときに回復の泉へ戻る確率も同じ(地上から潜り直しても戻る) */
  springDryChance: 0.33,
  /** 酸の泉に触れたときのダメージ(最大 HP に対する割合。酸では気絶せず HP 1 で止まる) */
  acidRatio: 0.2,
  /** 戦闘中(ターンの初めか終わりに敵が見えている)の休憩の回復量の倍率 */
  combatRestRatio: 0.5,
  /** 敵のいるマスも通り抜けられるか(false なら味方のマスだけ通り抜けられる) */
  passThroughFoes: false,
  /** 弓などの遠隔攻撃で、撃つ瞬間に味方が射線上にいたら撃たない(AP は消費する) */
  holdFireOnAlly: true,
  /** 気絶した味方を担いでいる間の移動コスト(1 マスあたり) */
  carryMoveCost: 2,
  /** 担がれたまま何ターン過ごすと、意識を取り戻す判定が始まるか */
  carryWakeTurns: 3,
  /** 判定が始まった後、ターンの終わりごとに意識を取り戻す確率 */
  carryWakeChance: 0.5,
  /** 意識を取り戻したときの HP */
  carryWakeHp: 8,
  /** 敵 AI が接近攻撃(相手の動きに合わせて追う)を選ぶ割合(一般の敵 / 素早い追跡型の敵) */
  aiChargeRate: 0.15,
  aiChaseChargeRate: 0.6,
  /** 強攻撃を持つ近接の敵(オークなど)が、最初から隣にいる味方に強攻撃を選ぶ割合 */
  aiPowerRate: 0.5,
  /** 重装ユニットが自分より体格の小さい敵を移動で押し返せるか */
  shoveSmaller: true,
  /** 敵が仲間を呼ぶ範囲(マンハッタン距離)。0 で呼ばない */
  aiCallRange: 8,
  /** ドラゴンが炎のブレスを吐く間隔(ターン) */
  breathEvery: 2,
  /** 眠っている敵が、姿を見て目を覚ます距離(マンハッタン距離、射線が通るとき) */
  wakeRange: 3,
  /** 回復薬を使う AP(最後のティックで効く) */
  itemCost: 2,
  /** 警報役が気付いてから増援を呼ぶまでのターン数 */
  alarmTurns: 3,
};

/** 魔法(地上では使えない)。足払い・かばう・強攻撃は特技なので使える */
export const MAGIC = new Set<SpellId>(['fireball', 'heal', 'revive', 'smite', 'hellfire', 'breath']);

/** 魔法の AP(業火のような遅い大技は多い) */
export function spellCost(id: SpellId): number {
  return SPELLS[id].cost ?? RULES.spellCost;
}

export function actionCost(a: Action): number {
  switch (a.type) {
    case 'move':
      return a.slow ? RULES.carryMoveCost : 1;
    case 'stairs':
      return 0;
    case 'guard':
    case 'wait':
    case 'carry':
    case 'drop':
      return 1;
    case 'attack':
      return a.power ? RULES.powerCost : RULES.attackCost;
    case 'cover':
      return RULES.coverCost;
    case 'spell':
      return spellCost(a.spell);
    case 'item':
      return RULES.itemCost;
    case 'overwatch':
    case 'intercept':
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
const WHILE_CARRYING = new Set<Action['type']>(['move', 'guard', 'wait', 'drop', 'stairs']);

export function planCost(actions: Action[]): number {
  return actions.reduce((s, a) => s + actionCost(a), 0);
}

export function apLeft(actions: Action[]): number {
  return AP_PER_TURN - planCost(actions);
}

/**
 * 予約の残り AP を埋めた計画を返す(元の配列は変えない)。
 * - 'wait': ただの待機(idle。食料を使わず、回復もしない)。予約で余った AP や全員移動はこれで埋める
 * - 'rest': 休憩(食料を 1 つ使って回復する。全員休憩)
 * - 'guard': 防御(敵が見えているとき)
 */
export function fillPlan(actions: Action[], filler: 'wait' | 'rest' | 'guard' = 'wait'): Action[] {
  const out = [...actions];
  const a: Action = filler === 'guard' ? { type: 'guard' } : filler === 'rest' ? { type: 'wait' } : { type: 'wait', idle: true };
  for (let n = apLeft(out); n > 0; n--) out.push(a);
  return out;
}

/** 休憩に数えるティック数(自分で予約した休憩だけ。余った AP の待機・予約していない AP は数えない) */
export function restTicks(actions: Action[] | undefined): number {
  if (!actions) return 0;
  return actions.filter((a) => a.type === 'wait' && !a.idle).length;
}

/** 予約全体の MP 消費 */
export function planMp(actions: Action[], unit?: { perks?: string[] }): number {
  return actions.reduce((s, a) => s + (a.type === 'spell' ? (unit ? spellMp(unit, a.spell) : SPELLS[a.spell].mp) : 0), 0);
}

/** 予約に action を追加できるか。できない場合は理由を返す */
/** floor: 今いる階(0 = 地上では魔法を予約できない) */
export function canAppend(unit: Unit, actions: Action[], action: Action, floor?: number): string | null {
  if (unit.down) return '気絶している';
  if (floor === 0 && action.type === 'spell' && MAGIC.has(action.spell)) return '地上では魔法は使えない';
  if (actionCost(action) > apLeft(actions)) return 'AP が足りない';
  // 残り AP 全部を使う行動は、AP が 0 なら予約しない
  if ((action.type === 'charge' || action.type === 'overwatch' || action.type === 'intercept') && action.ticks <= 0) return 'AP が足りない';
  const def = unitDef(unit.defId);
  if (action.type === 'spell') {
    if (!def.spells.includes(action.spell)) return 'その魔法は使えない';
    if (planMp(actions, unit) + spellMp(unit, action.spell) > unit.mp) return 'MP が足りない';
  }
  if (action.type === 'overwatch' && def.range <= 1) return '遠隔攻撃を持たない';
  if (action.type === 'cover' && !def.spells.includes('cover')) return 'かばうは使えない';
  if (action.type === 'attack' && action.power && !def.spells.includes('power')) return '強攻撃は使えない';
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
  | { k: 'strike'; action: Extract<Action, { type: 'attack' | 'spell' | 'item' }> }
  | { k: 'guard' }
  | { k: 'cover' }
  /** 足払いで動けない */
  | { k: 'stun' }
  /** idle=true は、予約で余った AP を埋めるただの待機(表示用) */
  | { k: 'wait'; idle?: boolean }
  | { k: 'watch'; mode: 'overwatch' | 'intercept' }
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
      case 'stairs':
        // ティックを使わない。ターンの終わりの判定(applyStairs)で見る
        break;
      case 'guard':
        steps.push({ k: 'guard' });
        break;
      case 'cover':
        for (let i = 0; i < RULES.coverCost; i++) steps.push({ k: 'cover' });
        break;
      case 'wait':
        steps.push(a.idle ? { k: 'wait', idle: true } : { k: 'wait' });
        break;
      case 'attack':
      case 'spell':
      case 'item': {
        const n = actionCost(a);
        for (let i = 0; i < n - 1; i++) steps.push({ k: 'windup', action: a });
        steps.push({ k: 'strike', action: a });
        break;
      }
      case 'overwatch':
      case 'intercept':
        for (let i = 0; i < a.ticks; i++) steps.push({ k: 'watch', mode: a.type });
        break;
    }
  }
  while (steps.length < AP_PER_TURN) steps.push({ k: 'wait' });
  return steps.slice(0, AP_PER_TURN);
}
