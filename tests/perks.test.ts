// 成長の二択(魔法使いの Lv 2)のテスト
import { describe, expect, it } from 'vitest';
import { canAppend } from '../src/core/actions';
import { parseMap } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import { pendingPerk, spellMp, spellRange } from '../src/core/stats';
import type { GameState, Unit } from '../src/core/types';
import { CLASSES, MONSTERS, SPELLS } from '../src/data/units';

function mk(id: string, defId: string, x: number, y: number, level = 1): Unit {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  return { id, side: CLASSES[defId] ? 'party' : 'enemy', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false, level, ai: CLASSES[defId] ? undefined : { mode: 'idle' } };
}

function game(units: Unit[]): GameState {
  const map = parseMap(['############', '#..........#', '#..........#', '############']);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(1), status: 'playing' };
}

describe('成長の二択', () => {
  it('魔法使いが Lv 2 になると、まだ選んでいなければ二択が待っている', () => {
    expect(pendingPerk(mk('p3', 'mage', 1, 1, 1))).toBeNull();
    expect(pendingPerk(mk('p3', 'mage', 1, 1, 2))).toEqual(['fireRange', 'fireMp']);
    expect(pendingPerk({ ...mk('p3', 'mage', 1, 1, 3), perks: ['fireMp'] })).toBeNull();
    expect(pendingPerk(mk('p1', 'warrior', 1, 1, 5))).toBeNull();
  });

  it('射程 +1 を選ぶと、7 マス先にも火球が届く', () => {
    const m = { ...mk('p3', 'mage', 1, 1, 2), perks: ['fireRange'] };
    expect(spellRange(m, 'fireball')).toBe(SPELLS.fireball.range + 1);
    const s = game([m, mk('g1', 'goblin', 8, 1)]);
    const r = resolveTurn(s, { p3: [{ type: 'spell', spell: 'fireball', tile: { x: 8, y: 1 } }], g1: [] });
    expect(r.events.some((e) => e.type === 'damage' && e.by === 'p3')).toBe(true);
    // 選んでいなければ届かない
    const r2 = resolveTurn(game([mk('p3', 'mage', 1, 1, 2), mk('g1', 'goblin', 8, 1)]), { p3: [{ type: 'spell', spell: 'fireball', tile: { x: 8, y: 1 } }], g1: [] });
    expect(r2.events.some((e) => e.type === 'fizzle' && e.id === 'p3')).toBe(true);
  });

  it('MP 消費 −1 を選ぶと、火球の MP が 2 になり、予約できる回数も増える', () => {
    const m = { ...mk('p3', 'mage', 1, 1, 2), perks: ['fireMp'], mp: 4 };
    expect(spellMp(m, 'fireball')).toBe(SPELLS.fireball.mp - 1);
    const fb = { type: 'spell', spell: 'fireball', tile: { x: 5, y: 1 } } as const;
    expect(canAppend(m, [fb], fb)).toBeNull();
    expect(canAppend({ ...m, perks: [] }, [fb], fb)).toBe('MP が足りない');
    // 残りの AP を休憩にすると MP が戻るので、防御で埋める
    const r = resolveTurn(game([m]), { p3: [fb, ...Array.from({ length: 5 }, () => ({ type: 'guard' }) as const)] });
    expect(r.state.units[0].mp).toBe(4 - 2);
  });
});
