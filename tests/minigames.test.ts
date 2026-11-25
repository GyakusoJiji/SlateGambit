// ミニゲーム(固定遭遇をつないだ短い連戦)のテスト
import { describe, expect, it } from 'vitest';
import { createFromDef, ENCOUNTER_LEVEL } from '../src/core/encounters';
import { carryOver, MINIGAMES, minigameDef, parseStageScenario, rankOf, stageScenario } from '../src/core/minigames';
import { stats } from '../src/core/stats';

describe('ミニゲーム', () => {
  it('どのステージも作れて、地図は長方形で、味方 4 人と敵がいる', () => {
    for (const m of MINIGAMES) {
      expect(m.stages.length).toBe(3);
      m.stages.forEach((def, i) => {
        expect(new Set(def.rows.map((r) => r.length)).size, `${m.id}/${def.id} の行の長さ`).toBe(1);
        const s = createFromDef(def, stageScenario(m.id, i), 1);
        expect(s.scenario).toBe(`mg:${m.id}:${i}`);
        expect(s.units.filter((u) => u.side === 'party').map((u) => u.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
        expect(s.units.some((u) => u.side === 'enemy')).toBe(true);
        expect(s.map.tiles.join('')).toMatch(/^[#.SH>$c+]+$/);
        if (def.objective.kind === 'escape') {
          expect(s.map.tiles.join('')).toContain('S');
          expect(s.units.find((u) => u.id === 'p1')!.down).toBe(true);
        }
      });
    }
  });

  it('ステージの ID を読み取れる', () => {
    expect(parseStageScenario(stageScenario('caster', 2))).toEqual({ id: 'caster', index: 2 });
    expect(parseStageScenario('caster')).toBeNull();
    expect(parseStageScenario(undefined)).toBeNull();
  });

  it('次のステージへは少し回復して持ち越す(上限は最大値、気絶は復帰、成長も引き継ぐ)', () => {
    const def = minigameDef('caster')!;
    const s = createFromDef(def.stages[0], stageScenario('caster', 0), 1);
    const [w, t, m, p] = s.units.filter((u) => u.side === 'party');
    w.hp = 10;
    t.hp = 1;
    t.down = true;
    m.mp = 0;
    m.perks = ['longFire'];
    const c = carryOver(s);
    expect(c.p1.hp).toBe(10 + Math.ceil(stats(w).maxHp * 0.4));
    expect(c.p2.hp).toBe(Math.ceil(stats(t).maxHp * 0.25));
    expect(c.p3.mp).toBe(Math.ceil(stats(m).maxMp * 0.5));
    expect(c.p3.perks).toEqual(['longFire']);
    expect(c.p4.hp).toBe(stats(p).maxHp);

    const next = createFromDef(def.stages[1], stageScenario('caster', 1), 1, c);
    const [w2, t2, m2] = next.units.filter((u) => u.side === 'party');
    expect(w2.hp).toBe(c.p1.hp);
    expect(t2.down).toBe(false);
    expect(t2.hp).toBe(c.p2.hp);
    expect(m2.perks).toEqual(['longFire']);
    expect(w2.level).toBe(ENCOUNTER_LEVEL);
  });

  it('救出ステージで気絶した戦士は、持ち越しがあっても気絶のまま始まる', () => {
    const def = minigameDef('rescue')!;
    const c = { p1: { hp: 50, mp: 0 } };
    const s = createFromDef(def.stages[0], stageScenario('rescue', 0), 1, c);
    const w = s.units.find((u) => u.id === 'p1')!;
    expect(w.down).toBe(true);
    expect(w.hp).toBe(0);
  });

  it('評価: 目安ターン以内で S、1.4 倍以内で A、それより遅いと B', () => {
    const def = minigameDef('caster')!;
    const par = def.stages.reduce((s, g) => s + (g.par ?? 0), 0);
    expect(rankOf(def, par)).toBe('S');
    expect(rankOf(def, par + 1)).toBe('A');
    expect(rankOf(def, Math.ceil(par * 1.4))).toBe('A');
    expect(rankOf(def, Math.ceil(par * 1.4) + 1)).toBe('B');
  });
});
