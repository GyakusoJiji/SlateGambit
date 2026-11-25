// チュートリアル(操作ガイドと 5 つのレッスン)のテスト
import { describe, expect, it } from 'vitest';
import { createEncounter, createFromDef, encounterDef } from '../src/core/encounters';
import { resolveTurn } from '../src/core/resolve';
import { LESSONS, lessonDef, TUTORIAL_ID, TUTORIAL_PAGES, type CoachInput } from '../src/core/tutorial';
import { planEnemies } from '../src/core/ai';
import { stairsDest } from '../src/core/floors';
import { spellRange } from '../src/core/stats';
import { unitSees } from '../src/core/vision';

const base: CoachInput = { turn: 1, plans: [], foeInSight: false, carrying: false, besideDown: false };

describe('チュートリアル', () => {
  it('レッスンは 5 つ。どれも作れて、味方 4 人・長方形の地図・案内の文がある', () => {
    expect(LESSONS.length).toBe(5);
    expect(new Set(LESSONS.map((l) => l.id)).size).toBe(5);
    expect(LESSONS[0].id).toBe(TUTORIAL_ID);
    for (const l of LESSONS) {
      expect(new Set(l.rows.map((r) => r.length)).size).toBe(1);
      const s = createFromDef(l, l.id, 1);
      expect(s.scenario).toBe(l.id);
      expect(s.units.filter((u) => u.side === 'party').map((u) => u.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(s.map.tiles.join('')).toMatch(/^[#.SH>$c+]+$/);
      expect(l.steps.length).toBeGreaterThan(0);
      expect(l.title).not.toBe('');
      expect(l.learn).not.toBe('');
      // どの状態でも、コーチは案内の範囲内を返す
      for (const turn of [1, 2]) for (const foeInSight of [false, true]) for (const carrying of [false, true]) for (const besideDown of [false, true]) for (const plans of [[], ['move'], ['attack'], ['guard'], ['fireball'], ['trip'], ['carry']]) {
        const k = l.coach({ turn, foeInSight, carrying, besideDown, plans });
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThan(l.steps.length);
      }
    }
  });

  it('レッスンの ID から引ける(固定遭遇としても作れる)。知らない ID は null', () => {
    expect(lessonDef('tut-carry')?.title).toContain('担いで');
    expect(encounterDef(TUTORIAL_ID)?.id).toBe(TUTORIAL_ID);
    expect(createEncounter('tut-fire', 1)?.scenario).toBe('tut-fire');
    expect(createEncounter('caster', 1)).toBeNull();
  });

  it('レッスン 1: 始めたときは敵が見えない(近づく練習になる)', () => {
    const s = createFromDef(LESSONS[0], TUTORIAL_ID, 1);
    const party = s.units.filter((u) => u.side === 'party');
    const foes = s.units.filter((u) => u.side === 'enemy');
    expect(foes.length).toBe(2);
    const minDist = Math.min(...party.flatMap((p) => foes.map((f) => Math.abs(p.x - f.x) + Math.abs(p.y - f.y))));
    expect(minDist).toBeGreaterThan(8);
  });

  it('レッスン 1 のステップ: 移動を予約 → 実行 → 近づく → 攻撃を予約 → 実行', () => {
    const c = LESSONS[0].coach;
    expect(c(base)).toBe(0);
    expect(c({ ...base, plans: ['move'] })).toBe(1);
    expect(c({ ...base, turn: 2 })).toBe(2);
    expect(c({ ...base, turn: 2, foeInSight: true })).toBe(3);
    expect(c({ ...base, turn: 2, foeInSight: true, plans: ['attack'] })).toBe(4);
    expect(c({ ...base, foeInSight: true })).toBe(3);
  });

  it('各レッスンのステップが、操作の順に進む', () => {
    const g = lessonDef('tut-guard')!.coach;
    expect([g(base), g({ ...base, plans: ['guard'] }), g({ ...base, plans: ['guard', 'attack'] })]).toEqual([0, 1, 2]);
    const f = lessonDef('tut-fire')!.coach;
    expect([f(base), f({ ...base, plans: ['fireball'] }), f({ ...base, turn: 2 })]).toEqual([0, 1, 2]);
    const c = lessonDef('tut-carry')!.coach;
    expect([c(base), c({ ...base, besideDown: true }), c({ ...base, besideDown: true, plans: ['carry'] }), c({ ...base, carrying: true })]).toEqual([0, 1, 2, 3]);
    const t = lessonDef('tut-trip')!.coach;
    expect([t(base), t({ ...base, plans: ['trip'] }), t({ ...base, turn: 2 })]).toEqual([0, 1, 2]);
  });

  it('レッスン 4: 敵がいなくても、担いで階段まで運べば勝てる', () => {
    const s = createEncounter('tut-carry', 1)!;
    expect(s.units.some((u) => u.side === 'enemy')).toBe(false);
    expect(s.objective).toEqual({ kind: 'escape', who: 'p1' });
    const w = s.units.find((u) => u.id === 'p1')!;
    expect(w.down).toBe(true);
    // 出口は、立っている味方の近くにある
    const exit = { x: 1, y: 2 };
    expect(s.map.tiles[exit.y][exit.x]).toBe('S');
    const priest = s.units.find((u) => u.id === 'p4')!;
    priest.x = exit.x;
    priest.y = exit.y + 1;
    priest.carrying = 'p1';
    w.x = priest.x;
    w.y = priest.y;
    expect(resolveTurn(s, { p4: [{ type: 'move', dir: 'N', slow: true }] }).state.status).toBe('won');
  });

  it('レッスン 4: 何も運んでいない味方が出口(S)に乗っても、階を移らずステージが続く', () => {
    const s = createEncounter('tut-carry', 1)!;
    const exit = { x: 1, y: 2 };
    expect(stairsDest(s, exit)).toBeNull();
    // 盗賊(p2)が出口へ 1 歩動き、階段を使う予約もしておく
    const before = s.map.tiles.join('/');
    const r = resolveTurn(s, { p2: [{ type: 'move', dir: 'W' }, { type: 'stairs' }] });
    expect(r.state.units.find((u) => u.id === 'p2')).toMatchObject(exit);
    expect(r.events.some((e) => e.type === 'stairs')).toBe(false);
    expect(r.state.floor).toBe(1);
    expect(r.state.scenario).toBe('tut-carry');
    expect(r.state.map.tiles.join('/')).toBe(before);
    expect(r.state.status).toBe('playing');
  });

  it('レッスン 3: ゴブリンは始めは気付いておらず、射程ぎりぎりの探索済みのマスへの火球で 3 体を巻き込める', () => {
    const s = createEncounter('tut-fire', 1)!;
    const party = s.units.filter((u) => u.side === 'party');
    const foes = s.units.filter((u) => u.side === 'enemy');
    for (const f of foes) for (const p of party) expect(unitSees(s.map, f, p), `${f.id} → ${p.id}`).toBe(false);
    const mage = party.find((u) => u.defId === 'mage')!;
    // 案内どおり、ゴブリンの列のすぐ手前(魔法使いから射程ちょうど)を狙う
    const tile = { x: mage.x + spellRange(mage, 'fireball'), y: mage.y };
    expect(s.explored[tile.y * s.map.w + tile.x]).toBe(1);
    expect(foes.filter((f) => f.x === tile.x + 1).length).toBe(3);
    const r = resolveTurn(s, { ...planEnemies(s), [mage.id]: [{ type: 'spell', spell: 'fireball', tile }] });
    const hit = new Set(r.events.filter((e) => e.type === 'damage' && foes.some((f) => f.id === e.id)).map((e) => (e as { id: string }).id));
    expect(hit.size).toBe(3);
  });

  it('レッスン 5: 1 ターン目に盗賊が角笛ゴブリンへ足払いをすると、逃げられる前に届く', () => {
    const s = createEncounter('tut-trip', 1)!;
    const thief = s.units.find((u) => u.defId === 'thief')!;
    const horn = s.units.find((u) => u.defId === 'hornblower')!;
    expect(s.explored[horn.y * s.map.w + horn.x]).toBe(1);
    const r = resolveTurn(s, { ...planEnemies(s), [thief.id]: [{ type: 'spell', spell: 'trip', target: horn.id }] });
    expect(r.events.some((e) => e.type === 'stun' && e.id === horn.id)).toBe(true);
    expect(r.events.some((e) => e.type === 'fizzle')).toBe(false);
  });

  it('レッスン 2〜3 と 5 は、敵を全滅させる目的', () => {
    for (const id of ['tut-guard', 'tut-fire', 'tut-trip']) expect(lessonDef(id)!.objective).toEqual({ kind: 'annihilate' });
    expect(createEncounter('tut-trip', 1)!.units.some((u) => u.defId === 'hornblower')).toBe(true);
    expect(createEncounter('tut-fire', 1)!.units.filter((u) => u.side === 'enemy').length).toBe(4);
  });

  it('ガイドのページが揃っている', () => {
    expect(TUTORIAL_PAGES.length).toBeGreaterThanOrEqual(4);
    for (const p of TUTORIAL_PAGES) {
      expect(p.title).not.toBe('');
      expect(p.lines.length).toBeGreaterThan(0);
    }
  });
});
