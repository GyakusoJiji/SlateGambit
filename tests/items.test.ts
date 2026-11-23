// 回復薬のテスト
import { describe, expect, it } from 'vitest';
import { actionCost } from '../src/core/actions';
import { parseMap } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import type { GameState, Unit } from '../src/core/types';
import { CLASSES, ITEMS } from '../src/data/units';

function mk(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId];
  return { id, side: 'party', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false };
}

function game(units: Unit[], items: GameState['items']): GameState {
  const map = parseMap(['########', '#......#', '#......#', '########']);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(1), status: 'playing', items };
}

const u = (s: GameState, id: string) => s.units.find((x) => x.id === id)!;

describe('回復薬', () => {
  it('2 AP で、2 ティック目に隣の味方の HP を回復し、持ち物が 1 つ減る', () => {
    expect(actionCost({ type: 'item', item: 'hp', target: 'p1' })).toBe(2);
    const w = mk('p1', 'warrior', 1, 1);
    w.hp = 10;
    const s = game([w, mk('p4', 'priest', 2, 1)], { hp: 2 });
    const r = resolveTurn(s, { p4: [{ type: 'item', item: 'hp', target: 'p1' }] });
    expect(r.events.find((e) => e.type === 'heal' && e.id === 'p1')?.tick).toBe(2);
    expect(u(r.state, 'p1').hp).toBeGreaterThanOrEqual(10 + ITEMS.hp.amount);
    expect(r.state.items?.hp).toBe(1);
  });

  it('MP 回復薬は MP を最大値まで回復する', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.mp = 2;
    const s = game([m], { mp: 1 });
    const r = resolveTurn(s, { p3: [{ type: 'item', item: 'mp', target: 'p3' }] });
    expect(u(r.state, 'p3').mp).toBeGreaterThanOrEqual(2 + ITEMS.mp.amount);
    expect(r.events.some((e) => e.type === 'heal' && e.mp)).toBe(true);
    expect(r.state.items?.mp).toBe(0);
  });

  it('持ち物が尽きていたり、相手が隣にいなければ不発', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('p4', 'priest', 5, 2)], { hp: 1 });
    const r = resolveTurn(s, {
      p1: [{ type: 'item', item: 'hp', target: 'p1' }],
      p4: [{ type: 'item', item: 'hp', target: 'p1' }],
    });
    expect(r.events.filter((e) => e.type === 'fizzle').map((e) => e.type === 'fizzle' && e.reason)).toEqual(['隣にいない']);
    // 同じティックに 2 人が使っても、1 つしか無ければ 2 人目は「薬がない」
    const s2 = game([mk('p1', 'warrior', 1, 1), mk('p4', 'priest', 2, 1)], { hp: 1 });
    const r2 = resolveTurn(s2, {
      p1: [{ type: 'item', item: 'hp', target: 'p1' }],
      p4: [{ type: 'item', item: 'hp', target: 'p4' }],
    });
    expect(r2.events.some((e) => e.type === 'fizzle' && e.reason === '薬がない')).toBe(true);
    expect(r2.state.items?.hp).toBe(0);
  });
});
