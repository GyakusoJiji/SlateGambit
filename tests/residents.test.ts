// 地上の住人(噂・化けた盗人)と、城に入り込む魔物のテスト
import { describe, expect, it } from 'vitest';
import { fillPlan, RULES } from '../src/core/actions';
import { planEnemies } from '../src/core/ai';
import { DISGUISE_RATE, generateGame, TOWN_RESIDENTS } from '../src/core/generate';
import { resolveTurn } from '../src/core/resolve';
import { applyRumors, makeRumor, RUMOR_COOLDOWN } from '../src/core/rumors';
import { Rng } from '../src/core/rng';
import type { GameEvent, GameState, Unit, UnitSnapshot } from '../src/core/types';
import { isNeutral, visibleFoes } from '../src/core/vision';
import { MONSTERS } from '../src/data/units';
import { DIR_LIST, isWalkable, step } from '../src/core/map';

/** 地上から始め、住人 r を戦士の隣に置いたゲーム(ほかの住人は消す) */
function withResident(seed: number, disguise = false): { s: GameState; w: Unit; r: Unit } {
  const s = generateGame(seed, 'normal');
  const w = s.units[0];
  const r = s.units.find((u) => u.defId === 'resident')!;
  r.ai = { mode: 'idle', ...(disguise ? { disguise } : {}) };
  // 戦士の上下左右の、誰もいない床に置く
  const free = DIR_LIST.map((d) => step(w, d)).find((p) => isWalkable(s.map, p.x, p.y) && !s.units.some((u) => u.x === p.x && u.y === p.y))!;
  r.x = free.x;
  r.y = free.y;
  s.units = s.units.filter((u) => u.side === 'party' || u === r);
  return { s, w, r };
}

const partyWait = (s: GameState) => Object.fromEntries(s.units.filter((u) => u.side === 'party').map((u) => [u.id, fillPlan([], 'wait')]));

describe('住人', () => {
  it('地上には難易度ごとの数の住人がいて、およそ 20% が化けた盗人(見かけ・名前は同じ)', () => {
    let total = 0;
    let disguised = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rs = generateGame(seed, 'normal').units.filter((u) => u.side === 'enemy');
      expect(rs.length).toBe(TOWN_RESIDENTS.normal);
      for (const r of rs) {
        expect(r.defId).toBe('resident');
        expect(r.name).toBe(MONSTERS.resident.name);
        total++;
        if (r.ai?.disguise) disguised++;
      }
    }
    expect(disguised / total).toBeGreaterThan(DISGUISE_RATE - 0.08);
    expect(disguised / total).toBeLessThan(DISGUISE_RATE + 0.08);
  });

  it('住人は敵として扱わない(見えていても戦闘中にならず、攻撃もしてこない)', () => {
    const { s, r } = withResident(31);
    expect(isNeutral(r)).toBe(true);
    expect(visibleFoes(s.map, s.units, 'party').size).toBe(0);
    const plan = planEnemies(s)[r.id];
    expect(plan.some((a) => a.type === 'attack' || a.type === 'charge')).toBe(false);
  });

  it('隣に来た味方に噂を話し、しばらくは同じ住人は話さない', () => {
    const { s, r } = withResident(32);
    const a = resolveTurn(s, { ...partyWait(s), [r.id]: fillPlan([], 'wait') });
    expect(a.events.some((e) => e.type === 'rumor' && e.id === r.id)).toBe(true);
    const b = resolveTurn(a.state, { ...partyWait(a.state), [r.id]: fillPlan([], 'wait') });
    expect(b.events.some((e) => e.type === 'rumor')).toBe(false);
    expect(RUMOR_COOLDOWN).toBeGreaterThan(1);
  });

  it('ターンの途中で隣を通り過ぎただけでも噂を話す', () => {
    const { s, w, r } = withResident(36);
    // ティック 1 だけ隣にいて、ターンの終わりには離れている
    const far = { x: r.x + 5, y: r.y };
    const snap = (u: Unit, p: { x: number; y: number }) => ({ id: u.id, x: p.x, y: p.y, down: false }) as UnitSnapshot;
    const frames = [
      [snap(w, far), snap(r, r)],
      [snap(w, w), snap(r, r)],
      [snap(w, far), snap(r, r)],
    ];
    const events: GameEvent[] = [];
    applyRumors(s, events, frames);
    expect(events.some((e) => e.type === 'rumor' && e.id === r.id)).toBe(true);
    // 一度も隣に来なければ話さない
    const none: GameEvent[] = [];
    applyRumors(withResident(36).s, none, [frames[0], frames[2]]);
    expect(none.length).toBe(0);
  });

  it('隣に住人が 2 人いれば、同じターンに 2 人とも話す(化けた盗人も話す)', () => {
    const s = generateGame(37, 'normal');
    const w = s.units[0];
    const [a, b] = s.units.filter((u) => u.defId === 'resident');
    const free = DIR_LIST.map((d) => step(w, d)).filter((p) => isWalkable(s.map, p.x, p.y) && !s.units.some((u) => u.x === p.x && u.y === p.y));
    Object.assign(a, free[0], { ai: { mode: 'idle' } });
    Object.assign(b, free[1], { ai: { mode: 'idle', disguise: true } });
    s.units = s.units.filter((u) => u.side === 'party' || u === a || u === b);
    const events: GameEvent[] = [];
    applyRumors(s, events);
    expect(events.filter((e) => e.type === 'rumor').map((e) => (e as { id: string }).id).sort()).toEqual([a.id, b.id].sort());
  });

  it('噂には本当の話と嘘があり、化けた盗人はいつも嘘をつく', () => {
    const { s, r } = withResident(33);
    const truths = Array.from({ length: 60 }, (_, i) => makeRumor(s, r, new Rng(i + 1)).truth);
    expect(truths.some(Boolean)).toBe(true);
    expect(truths.some((t) => !t)).toBe(true);
    const liar = { ...r, ai: { mode: 'idle' as const, disguise: true } };
    expect(Array.from({ length: 30 }, (_, i) => makeRumor(s, liar, new Rng(i + 1)).truth).some(Boolean)).toBe(false);
  });

  it('化けた盗人は近づいて殴り、当たると正体を現してゴールドを盗む', () => {
    const { s, w, r } = withResident(34, true);
    s.gold = 50;
    const plan = planEnemies(s)[r.id];
    expect(plan.some((a) => a.type === 'attack' || a.type === 'charge' || a.type === 'intercept')).toBe(true);
    const res = resolveTurn(s, { [r.id]: [{ type: 'attack', target: w.id }] });
    const n = res.state.units.find((u) => u.id === r.id)!;
    expect(res.events.some((e) => e.type === 'unmask' && e.id === r.id)).toBe(true);
    expect(res.events.some((e) => e.type === 'steal' && e.id === r.id)).toBe(true);
    expect(n.defId).toBe('bandit');
    expect(n.name).toBe(MONSTERS.bandit.name);
    expect(res.state.gold).toBe(40);
    // 正体を現した後は敵として扱う
    expect(isNeutral(n)).toBe(false);
  });
});

describe('城に入り込む魔物', () => {
  it('地上ではごくまれに、地下 1 階の種類の魔物が入り込む', () => {
    const saved = RULES.intrudeChance;
    RULES.intrudeChance = 1;
    try {
      const s = generateGame(35, 'normal');
      const r = resolveTurn(s, {});
      expect(r.events.some((e) => e.type === 'intrude' && e.count > 0)).toBe(true);
      const added = r.state.units.filter((u) => u.id.startsWith('i'));
      expect(added.length).toBeGreaterThan(0);
      expect(added.every((u) => !['resident', 'bandit'].includes(u.defId))).toBe(true);
    } finally {
      RULES.intrudeChance = saved;
    }
    expect(RULES.intrudeChance).toBeLessThanOrEqual(0.02);
  });
});
