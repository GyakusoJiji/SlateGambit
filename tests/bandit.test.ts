// 野盗(ゴールドを盗んで逃げる敵)のテスト
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/core/actions';
import { planEnemies } from '../src/core/ai';
import { generateFloor, MONSTER_GEN } from '../src/core/generate';
import { manhattan, parseMap } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import type { GameState, Unit } from '../src/core/types';
import { CLASSES, MONSTERS } from '../src/data/units';

function mk(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  return { id, side: CLASSES[defId] ? 'party' : 'enemy', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false, ai: CLASSES[defId] ? undefined : { mode: 'idle' } };
}

// 左に小部屋、長い通路の先に右の部屋(逃げる先)
const ROWS = ['##################', '#...#............#', '#................#', '#...#............#', '##################'];

function game(units: Unit[], gold = 100, floor = 1): GameState {
  const map = parseMap(ROWS);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(1), status: 'playing', gold, floor };
}

describe('野盗', () => {
  it('近接攻撃が当たると、所持金から「基本 + 階 × 額」を盗む(所持金が少なければその分だけ)', () => {
    const s = game([mk('p1', 'warrior', 2, 2), mk('n1', 'bandit', 3, 2)], 100, 2);
    const r = resolveTurn(s, { n1: [{ type: 'attack', target: 'p1' }] });
    const take = RULES.stealBase + RULES.stealPerFloor * 2;
    expect(r.events.some((e) => e.type === 'steal' && e.gold === take)).toBe(true);
    expect(r.state.gold).toBe(100 - take);
    expect(r.state.units.find((u) => u.id === 'n1')!.ai?.stolen).toBe(take);
    const poor = resolveTurn(game([mk('p1', 'warrior', 2, 2), mk('n1', 'bandit', 3, 2)], 5), { n1: [{ type: 'attack', target: 'p1' }] });
    expect(poor.state.gold).toBe(0);
    // 2 回目の攻撃では盗まない
    const twice = resolveTurn(s, { n1: [{ type: 'attack', target: 'p1' }, { type: 'attack', target: 'p1' }] });
    expect(twice.events.filter((e) => e.type === 'steal').length).toBe(1);
  });

  it('盗んだ後は、パーティから離れるように逃げる', () => {
    const s = game([mk('p1', 'warrior', 2, 2), { ...mk('n1', 'bandit', 5, 2), ai: { mode: 'idle', stolen: 20 } }]);
    const plan = planEnemies(s).n1;
    expect(plan.some((a) => a.type === 'attack' || a.type === 'charge')).toBe(false);
    const r = resolveTurn(s, { n1: plan });
    const n = r.state.units.find((u) => u.id === 'n1')!;
    expect(manhattan(n, { x: 2, y: 2 })).toBeGreaterThan(3);
  });

  it(`見られずに ${RULES.banditEscapeTurns} ターン過ごすと逃げ切り、盗まれたゴールドは戻らない`, () => {
    // 戦士は左の小部屋の奥(壁の陰)、野盗は通路の先
    let s = game([mk('p1', 'warrior', 1, 1), { ...mk('n1', 'bandit', 15, 2), ai: { mode: 'idle', stolen: 20 } }], 30);
    for (let i = 0; i < RULES.banditEscapeTurns; i++) {
      const r = resolveTurn(s, { n1: [] });
      s = r.state;
      if (i < RULES.banditEscapeTurns - 1) expect(s.units.some((u) => u.id === 'n1')).toBe(true);
      else expect(r.events.some((e) => e.type === 'escape' && e.id === 'n1' && e.gold === 20)).toBe(true);
    }
    expect(s.units.some((u) => u.id === 'n1')).toBe(false);
    expect(s.gold).toBe(30);
  });

  it('盗んだ野盗を倒すと、盗まれた分と野盗自身のゴールドが戻る', () => {
    const s = game([mk('p1', 'warrior', 2, 2), { ...mk('n1', 'bandit', 3, 2), hp: 1, ai: { mode: 'idle', stolen: 20 } }], 0);
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: 'n1' }], n1: [] });
    expect(r.events.some((e) => e.type === 'recover' && e.gold === 20)).toBe(true);
    expect(r.state.gold).toBe(20 + MONSTERS.bandit.gold!);
  });

  it('野盗は地上と地下 1〜2 階にだけ出る', () => {
    expect(MONSTER_GEN.bandit.from).toBe(0);
    expect(MONSTER_GEN.bandit.to).toBe(2);
    for (let seed = 1; seed <= 20; seed++) {
      for (const f of [3, 4, 5]) expect(generateFloor(seed, 'hard', f).enemies.some((u) => u.defId === 'bandit')).toBe(false);
    }
    const shallow = Array.from({ length: 20 }, (_, i) => generateFloor(i + 1, 'hard', 1).enemies.some((u) => u.defId === 'bandit'));
    expect(shallow.some(Boolean)).toBe(true);
  });
});
