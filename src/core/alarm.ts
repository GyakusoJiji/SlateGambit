// 警報役(角笛ゴブリン): パーティに気付くと逃げながら角笛を吹き続け、RULES.alarmTurns ターン止められなければ
// 増援を呼ぶ。その前に倒せば、持っていた宝(ゴールド)が手に入る。足払いを受けたターンは数えない(吹けない)。
import { RULES } from './actions';
import { currentFloor, spawnFoes } from './floors';
import type { Rng } from './rng';
import { TICKS_PER_TURN, type GameEvent, type GameState } from './types';
import { unitSees } from './vision';

/** 警報役のモンスター ID */
export const ALARM_DEF = 'hornblower';

/** 止めたときに手に入るゴールド */
export function alarmBounty(floor: number): number {
  return 15 + 15 * floor;
}

/** 増援の点数 */
export function alarmBudget(floor: number): number {
  return 3 + 2 * floor;
}

/**
 * ターンの終わりの警報の処理。stunned=このターンに足払いを受けた敵、sawAtStart=ターンの初めに味方を見ていた敵
 * (気付いたターンに逃げて見えなくなっても、気付いたことにする)。
 * - 倒れた警報役(まだ吹き終えていない)からは宝が手に入る
 * - 気付いた警報役は 1 ターンごとに数を進め、RULES.alarmTurns に達したら増援が現れる
 */
export function applyAlarm(state: GameState, rng: Rng, events: GameEvent[], stunned: ReadonlySet<string>, sawAtStart: ReadonlySet<string>): void {
  const floor = currentFloor(state);
  for (const e of state.units) {
    if (e.defId !== ALARM_DEF || !e.ai || e.ai.alarmRaised) continue;
    if (e.down) {
      if (e.ai.bountyPaid) continue;
      e.ai.bountyPaid = true;
      const gold = alarmBounty(floor);
      state.gold = (state.gold ?? 0) + gold;
      events.push({ tick: TICKS_PER_TURN, type: 'bounty', id: e.id, gold });
      continue;
    }
    if (e.ai.alarm === undefined) {
      // 姿を見た・攻撃されたら気付く(このターンから数え始める)
      const seen = state.units.some((p) => p.side === 'party' && !p.down && unitSees(state.map, e, p));
      if (seen || sawAtStart.has(e.id) || e.ai.alerted) e.ai.alarm = 0;
      continue;
    }
    if (stunned.has(e.id)) continue;
    e.ai.alarm += 1;
    if (e.ai.alarm < RULES.alarmTurns) continue;
    e.ai.alarmRaised = true;
    const count = spawnFoes(state, rng, alarmBudget(floor), `h${state.turn}_`, 8);
    events.push({ tick: TICKS_PER_TURN, type: 'alarm', id: e.id, count });
  }
}
