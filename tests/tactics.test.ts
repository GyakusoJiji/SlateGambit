import { afterEach, describe, expect, it } from 'vitest';
import { RULES, apLeft, canAppend } from '../src/core/actions';
import { resolveTurn } from '../src/core/resolve';
import { createTestGame } from '../src/core/scenario';
import type { Action, GameEvent, GameState } from '../src/core/types';

const SAVED = { ...RULES };
afterEach(() => Object.assign(RULES, SAVED));

/** 左上の広い部屋(x 1〜8、y 1〜5)に、指定したユニットだけを置いた状態を作る */
function arena(spec: Record<string, [number, number]>): GameState {
  const s = createTestGame(1);
  s.units = s.units.filter((u) => spec[u.id]);
  for (const u of s.units) [u.x, u.y] = spec[u.id];
  return s;
}

const damages = (ev: GameEvent[], id: string) => ev.filter((e) => e.type === 'damage' && e.id === id);
const attack = (target: string, n = 1): Action[] => Array.from({ length: n }, () => ({ type: 'attack', target }));

describe('狙いの引き継ぎ', () => {
  it('狙った敵が先に倒れると、届く別の敵に攻撃が移る', () => {
    const s = arena({ p1: [4, 3], g1: [5, 3], g2: [5, 4] });
    s.units.find((u) => u.id === 'g1')!.hp = 1;
    const r = resolveTurn(s, { p1: attack('g1', 2) });
    expect(damages(r.events, 'g2').length).toBe(1);
    expect(r.events.some((e) => e.type === 'fizzle')).toBe(false);
  });

  it('RULES.retarget を切ると、これまでどおり不発になる', () => {
    RULES.retarget = false;
    const s = arena({ p1: [4, 3], g1: [5, 3], g2: [5, 4] });
    s.units.find((u) => u.id === 'g1')!.hp = 1;
    const r = resolveTurn(s, { p1: attack('g1', 2) });
    expect(damages(r.events, 'g2').length).toBe(0);
    expect(r.events.some((e) => e.type === 'fizzle' && e.reason === '対象がいない')).toBe(true);
  });
});

describe('挟み撃ち', () => {
  it('対象の反対側に味方がいる近接攻撃は、ダメージが増える', () => {
    const s = arena({ p1: [4, 3], p4: [6, 3], g1: [5, 3] });
    const r = resolveTurn(s, { p1: attack('g1') });
    const d = damages(r.events, 'g1')[0];
    expect(d).toMatchObject({ flank: true });
  });

  it('同じ側にしか味方がいなければ、増えない', () => {
    const s = arena({ p1: [4, 3], p4: [4, 2], g1: [5, 3] });
    const r = resolveTurn(s, { p1: attack('g1') });
    expect(damages(r.events, 'g1')[0]).not.toHaveProperty('flank');
  });
});

describe('強攻撃', () => {
  it('5AP を使い、5 ティック目に 1.5 倍のダメージを与える', () => {
    const s = arena({ p1: [4, 3], g1: [5, 3] });
    const plan: Action[] = [{ type: 'attack', target: 'g1', power: true }];
    expect(apLeft(plan)).toBe(8 - RULES.powerCost);
    const r = resolveTurn(s, { p1: plan });
    const d = r.events.find((e) => e.type === 'damage' && e.id === 'g1')!;
    expect(d.tick).toBe(RULES.powerCost);
    // ゴブリンは防御 0。戦士の攻撃 7〜10 の 1.5 倍(四捨五入)は 11 以上で、通常攻撃の上限 10 を超える
    expect(d.type === 'damage' && d.amount).toBeGreaterThanOrEqual(11);
  });

  it('強攻撃を持たない職業は予約できない', () => {
    const s = arena({ p3: [4, 3], g1: [5, 3] });
    const mage = s.units.find((u) => u.id === 'p3')!;
    expect(canAppend(mage, [], { type: 'attack', target: 'g1', power: true })).not.toBeNull();
  });
});

describe('かばう', () => {
  it('隣の味方への単体攻撃を、かばっている者が代わりに受ける(防御で半減)', () => {
    const s = arena({ p1: [4, 3], p3: [3, 3], g1: [3, 2] });
    const r = resolveTurn(s, { p1: [{ type: 'cover' }], g1: attack('p3') });
    expect(r.events.some((e) => e.type === 'cover' && e.id === 'p1' && e.for === 'p3')).toBe(true);
    expect(damages(r.events, 'p3').length).toBe(0);
    expect(damages(r.events, 'p1')[0]).toMatchObject({ guarded: true });
  });

  it('範囲魔法は防げない', () => {
    const s = arena({ p1: [4, 3], p3: [3, 3], p4: [2, 5], b1: [6, 3] });
    const shaman = s.units.find((u) => u.id === 'b1')!;
    shaman.defId = 'shaman';
    shaman.mp = 6;
    const r = resolveTurn(s, { p1: [{ type: 'cover' }], b1: [{ type: 'spell', spell: 'fireball', tile: { x: 3, y: 3 } }] });
    expect(damages(r.events, 'p3').length).toBe(1);
  });
});

describe('足払い', () => {
  it('構えの途中の攻撃を取り消し、足止めのイベントが出る', () => {
    const s = arena({ p2: [2, 3], p3: [5, 4], g1: [5, 3] });
    const r = resolveTurn(s, {
      p2: [{ type: 'spell', spell: 'trip', target: 'g1' }],
      g1: attack('p3', 2),
    });
    expect(r.events.some((e) => e.type === 'stun' && e.id === 'g1')).toBe(true);
    // 1 回目の一撃(3 ティック目)は足払いと同時なので当たるが、2 回目(6 ティック目)は取り消される
    expect(damages(r.events, 'p3').length).toBe(1);
  });

  it('MP を使う', () => {
    const s = arena({ p2: [2, 3], g1: [5, 3] });
    const mp = s.units.find((u) => u.id === 'p2')!.mp;
    const r = resolveTurn(s, { p2: [{ type: 'spell', spell: 'trip', target: 'g1' }] });
    expect(r.state.units.find((u) => u.id === 'p2')!.mp).toBeLessThan(mp);
  });
});

describe('聖光', () => {
  it('範囲内の敵だけに当たり、味方は巻き込まない', () => {
    const s = arena({ p4: [2, 3], p1: [5, 4], g1: [5, 3] });
    const r = resolveTurn(s, { p4: [{ type: 'spell', spell: 'smite', tile: { x: 5, y: 3 } }] });
    expect(damages(r.events, 'g1').length).toBe(1);
    expect(damages(r.events, 'p1').length).toBe(0);
  });
});

describe('休憩の物音', () => {
  it('休憩で回復したターンに、遠くから警戒した敵が現れる', () => {
    RULES.wanderChance = 1;
    const s = createTestGame(1);
    for (const u of s.units.filter((u) => u.side === 'party')) u.hp = Math.max(1, u.hp - 10);
    const before = s.units.length;
    const r = resolveTurn(s, {});
    const added = r.state.units.slice(before);
    expect(added.length).toBeGreaterThan(0);
    expect(r.events.some((e) => e.type === 'wander')).toBe(true);
    for (const u of added) {
      expect(u.side).toBe('enemy');
      expect(u.ai?.alerted).toBe(true);
    }
  });

  it('確率 0 なら現れない', () => {
    RULES.wanderChance = 0;
    const s = createTestGame(1);
    for (const u of s.units.filter((u) => u.side === 'party')) u.hp = Math.max(1, u.hp - 10);
    const r = resolveTurn(s, {});
    expect(r.state.units.length).toBe(s.units.length);
  });

  it('回復するものがなければ現れない', () => {
    RULES.wanderChance = 1;
    const s = createTestGame(1);
    const r = resolveTurn(s, {});
    expect(r.state.units.length).toBe(s.units.length);
  });
});
