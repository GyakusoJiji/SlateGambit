// ゴールドの経済(食料・泉の枯渇・敵のゴールド)のテスト
import { describe, expect, it } from 'vitest';
import { fillPlan, RULES } from '../src/core/actions';
import { generateGame, START_FOOD, START_GOLD } from '../src/core/generate';
import { parseMap, tileAt } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import type { GameState, Unit } from '../src/core/types';
import { CLASSES, MONSTERS } from '../src/data/units';

function mk(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  return { id, side: CLASSES[defId] ? 'party' : 'enemy', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false, ai: CLASSES[defId] ? undefined : { mode: 'idle' } };
}

function game(units: Unit[], rows = ['########', '#......#', '#......#', '########'], items: GameState['items'] = {}): GameState {
  const map = parseMap(rows);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(1), status: 'playing', items, gold: 0 };
}

const rest = () => fillPlan([], 'wait');
const u = (s: GameState, id: string) => s.units.find((x) => x.id === id)!;

describe('食料と休憩', () => {
  it('休憩して回復したターンは、食料を 1 つ使う', () => {
    const w = { ...mk('p1', 'warrior', 1, 1), hp: 10 };
    const r = resolveTurn(game([w, mk('p3', 'mage', 3, 1)], undefined, { food: 2 }), { p1: rest(), p3: rest() });
    expect(r.state.items?.food).toBe(1);
    expect(u(r.state, 'p1').hp).toBe(10 + Math.round(CLASSES.warrior.maxHp * RULES.restHpRatio));
    expect(r.events.some((e) => e.type === 'ration' && e.food)).toBe(true);
  });

  it('食料が無いと、休憩しても回復しない', () => {
    const w = { ...mk('p1', 'warrior', 1, 1), hp: 10 };
    const r = resolveTurn(game([w], undefined, {}), { p1: rest() });
    expect(u(r.state, 'p1').hp).toBe(10);
    expect(r.events.some((e) => e.type === 'ration' && !e.food)).toBe(true);
    expect(r.events.some((e) => e.type === 'rest')).toBe(false);
  });

  it('全員が全快していれば、待機しても食料は減らない', () => {
    const r = resolveTurn(game([mk('p1', 'warrior', 1, 1)], undefined, { food: 3 }), { p1: rest() });
    expect(r.state.items?.food).toBe(3);
  });

  it('新しいゲームは所持金と食料を持って始まる', () => {
    const s = generateGame(5, 'normal');
    expect(s.gold).toBe(START_GOLD);
    expect(s.items?.food).toBe(START_FOOD);
  });
});

describe('回復の泉の枯渇', () => {
  it(`使うたびに ${Math.round(RULES.springDryChance * 100)}% 前後の確率で枯れ、枯れた泉では回復しない`, () => {
    let dried = 0;
    const N = 300;
    for (let rng = 1; rng <= N; rng++) {
      const s = { ...game([{ ...mk('p1', 'warrior', 1, 1), hp: 5 }], ['#####', '#.H.#', '#####']), rng };
      const r = resolveTurn(s, { p1: [{ type: 'move', dir: 'E' }] });
      expect(u(r.state, 'p1').hp).toBe(CLASSES.warrior.maxHp);
      if (tileAt(r.state.map, 2, 1) === 'h') {
        dried++;
        expect(r.events.some((e) => e.type === 'dry')).toBe(true);
      }
    }
    expect(dried / N).toBeGreaterThan(RULES.springDryChance - 0.1);
    expect(dried / N).toBeLessThan(RULES.springDryChance + 0.1);
    // 枯れた泉に立っても回復しない
    const s = game([{ ...mk('p1', 'warrior', 1, 1), hp: 5 }], ['#####', '#.h.#', '#####']);
    const r = resolveTurn(s, { p1: [{ type: 'move', dir: 'E' }] });
    expect(u(r.state, 'p1').hp).toBe(5);
  });
});

describe('敵のゴールド', () => {
  it('敵を倒すと、経験値とは別にゴールドが入る', () => {
    const g = { ...mk('g1', 'goblin', 2, 1), hp: 1 };
    const r = resolveTurn(game([mk('p1', 'warrior', 1, 1), g]), { p1: [{ type: 'attack', target: 'g1' }], g1: [] });
    expect(r.state.gold).toBe(MONSTERS.goblin.gold);
    expect(r.events.some((e) => e.type === 'loot' && e.gold === MONSTERS.goblin.gold)).toBe(true);
  });

  it('すべてのモンスターにゴールドが設定されている', () => {
    for (const m of Object.values(MONSTERS)) expect(m.gold, m.id).toBeGreaterThan(0);
  });
});
