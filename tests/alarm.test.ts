// 警報役(角笛ゴブリン)のテスト
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/actions';
import { planEnemies } from '../src/core/ai';
import { alarmBounty } from '../src/core/alarm';
import { generateFloor } from '../src/core/generate';
import { parseMap } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import type { GameState, Plans, Unit } from '../src/core/types';
import { CLASSES, MONSTERS } from '../src/data/units';

const ROOM = [
  '##############################',
  '#............................#',
  '#............................#',
  '#............................#',
  '#............................#',
  '##############################',
];

function mk(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  return { id, side: CLASSES[defId] ? 'party' : 'enemy', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false, ai: CLASSES[defId] ? undefined : { mode: 'idle' } };
}

function game(units: Unit[]): GameState {
  const map = parseMap(ROOM);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(1), status: 'playing', floor: 1, gold: 0 };
}

const horn = (s: GameState) => s.units.find((u) => u.defId === 'hornblower')!;
/** 味方は動かず、敵は AI のまま */
const idle = (s: GameState): Plans => ({ ...planEnemies(s), p1: [] });

describe('警報役', () => {
  it('気付いてから RULES.alarmTurns ターン止めなければ、増援が現れる', () => {
    let s = game([mk('p1', 'warrior', 1, 2), mk('h1', 'hornblower', 7, 2)]);
    s = resolveTurn(s, idle(s)).state;
    expect(horn(s).ai?.alarm).toBe(0);
    const before = s.units.length;
    for (let i = 0; i < RULES.alarmTurns - 1; i++) s = resolveTurn(s, idle(s)).state;
    expect(horn(s).ai?.alarmRaised).toBeFalsy();
    const r = resolveTurn(s, idle(s));
    expect(r.events.some((e) => e.type === 'alarm' && e.count > 0)).toBe(true);
    expect(r.state.units.length).toBeGreaterThan(before);
    expect(horn(r.state).ai?.alarmRaised).toBe(true);
  });

  it('角笛を吹き終える前に倒せば、持っていた宝(ゴールド)が手に入る', () => {
    const h = mk('h1', 'hornblower', 2, 2);
    h.hp = 1;
    const s = game([mk('p1', 'warrior', 1, 2), h]);
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: 'h1' }], h1: [] });
    expect(r.events.some((e) => e.type === 'bounty' && e.gold === alarmBounty(1))).toBe(true);
    // 警報役を倒したゴールドも入る
    expect(r.state.gold).toBe(alarmBounty(1) + (MONSTERS.hornblower.gold ?? 0));
    // 2 回は手に入らない
    const r2 = resolveTurn(r.state, {});
    expect(r2.events.some((e) => e.type === 'bounty')).toBe(false);
  });

  it('足払いを受けたターンは数えない', () => {
    // 逃げられないよう、警報役は動かさない
    let s = game([mk('p2', 'thief', 3, 2), mk('h1', 'hornblower', 6, 2)]);
    s = resolveTurn(s, { p2: [], h1: [] }).state;
    expect(horn(s).ai?.alarm).toBe(0);
    s = resolveTurn(s, { p2: [{ type: 'spell', spell: 'trip', target: 'h1' }], h1: [] }).state;
    expect(horn(s).ai?.alarm).toBe(0);
    s = resolveTurn(s, { p2: [], h1: [] }).state;
    expect(horn(s).ai?.alarm).toBe(1);
  });

  it('気付いた警報役は、見えている味方から逃げて距離を取る', () => {
    const s = game([mk('p1', 'warrior', 10, 2), mk('h1', 'hornblower', 13, 2)]);
    const r = resolveTurn(s, { h1: planEnemies(s).h1 });
    const h = horn(r.state);
    expect(Math.abs(h.x - 10) + Math.abs(h.y - 2)).toBeGreaterThan(3);
  });

  it('ランダム生成では、地下 2 階以降にだけ出る', () => {
    const has = (floor: number) => [1, 2, 3, 4, 5, 6, 7, 8].some((seed) => generateFloor(seed, 'normal', floor).enemies.some((e) => e.defId === 'hornblower'));
    expect(has(1)).toBe(false);
    expect(has(2)).toBe(true);
    expect(has(4)).toBe(true);
  });
});
