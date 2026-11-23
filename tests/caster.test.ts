// 遅い大技(呪術師長の業火)と、足払いで詠唱を止めるテスト
import { describe, expect, it } from 'vitest';
import { actionCost } from '../src/core/actions';
import { planEnemies } from '../src/core/ai';
import { parseMap } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import type { GameState, Unit } from '../src/core/types';
import { CLASSES, MONSTERS, SPELLS } from '../src/data/units';
import { turnSummary } from '../src/ui/panel';

const OPEN = [
  '##############',
  '#............#',
  '#............#',
  '#............#',
  '#............#',
  '#............#',
  '##############',
];

function mk(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  return { id, side: CLASSES[defId] ? 'party' : 'enemy', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false, ai: CLASSES[defId] ? undefined : { mode: 'idle' } };
}

function game(units: Unit[]): GameState {
  const map = parseMap(OPEN);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(0), status: 'playing' };
}

const u = (s: GameState, id: string) => s.units.find((x) => x.id === id)!;
const hellfire = { type: 'spell', spell: 'hellfire', tile: { x: 3, y: 3 } } as const;

describe('業火', () => {
  it('5 AP で、5 ティック目に 5×5 を焼く', () => {
    expect(actionCost(hellfire)).toBe(5);
    const s = game([mk('p1', 'warrior', 3, 3), mk('p3', 'mage', 5, 5), mk('k1', 'warlock', 9, 3)]);
    const r = resolveTurn(s, { k1: [hellfire] });
    const hit = r.events.filter((e) => e.type === 'damage' && e.by === 'k1');
    expect(hit.map((e) => e.tick)).toEqual([5, 5]);
    expect(u(r.state, 'k1').mp).toBe(MONSTERS.warlock.maxMp - SPELLS.hellfire.mp);
  });

  it('詠唱中に足払いを受けると取り消され、MP も減らない。止めたことが記録と要約に残る', () => {
    const s = game([mk('p1', 'warrior', 3, 3), mk('p2', 'thief', 5, 1), mk('k1', 'warlock', 9, 3)]);
    const r = resolveTurn(s, { k1: [hellfire], p2: [{ type: 'spell', spell: 'trip', target: 'k1' }] });
    expect(r.events.some((e) => e.type === 'damage' && e.by === 'k1')).toBe(false);
    expect(r.events.some((e) => e.type === 'interrupt' && e.id === 'k1' && e.spell === 'hellfire')).toBe(true);
    expect(u(r.state, 'k1').mp).toBe(MONSTERS.warlock.maxMp);
    const lines = turnSummary(r.events, s.units, (id) => id);
    expect(lines.find((l) => l.startsWith('p2'))).toContain('業火の詠唱を止めた');
  });

  it('呪術師長は見えている味方を巻き込めるマスへ業火を唱える', () => {
    const s = game([mk('p1', 'warrior', 4, 3), mk('p2', 'thief', 4, 4), mk('k1', 'warlock', 9, 3)]);
    const plan = planEnemies(s).k1;
    expect(plan[0]).toMatchObject({ type: 'spell', spell: 'hellfire' });
  });
});
