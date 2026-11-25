// チュートリアル(操作ガイドと練習戦)のテスト
import { describe, expect, it } from 'vitest';
import { createFromDef, encounterDef, ENCOUNTERS } from '../src/core/encounters';
import { coachStep, TUTORIAL, TUTORIAL_ID, TUTORIAL_PAGES, TUTORIAL_STEPS } from '../src/core/tutorial';

describe('チュートリアル', () => {
  it('練習戦が作れて、味方 4 人と敵がいて、地図は長方形', () => {
    expect(new Set(TUTORIAL.rows.map((r) => r.length)).size).toBe(1);
    const s = createFromDef(TUTORIAL, TUTORIAL_ID, 1);
    expect(s.scenario).toBe('tutorial');
    expect(s.units.filter((u) => u.side === 'party').map((u) => u.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect(s.units.filter((u) => u.side === 'enemy').length).toBe(2);
    expect(s.objective).toEqual({ kind: 'annihilate' });
  });

  it('始めたときは敵が見えない(近づく練習になる)', () => {
    const s = createFromDef(TUTORIAL, TUTORIAL_ID, 1);
    const party = s.units.filter((u) => u.side === 'party');
    const foes = s.units.filter((u) => u.side === 'enemy');
    const minDist = Math.min(...party.flatMap((p) => foes.map((f) => Math.abs(p.x - f.x) + Math.abs(p.y - f.y))));
    expect(minDist).toBeGreaterThan(8);
  });

  it('練習戦は固定遭遇の一覧には出ないが、名前は引ける', () => {
    expect(ENCOUNTERS.some((e) => e.id === TUTORIAL_ID)).toBe(false);
    expect(encounterDef(TUTORIAL_ID)?.title).toBe('チュートリアル');
  });

  it('ガイドのページとステップの指示が揃っている', () => {
    expect(TUTORIAL_PAGES.length).toBeGreaterThanOrEqual(4);
    for (const p of TUTORIAL_PAGES) {
      expect(p.title).not.toBe('');
      expect(p.lines.length).toBeGreaterThan(0);
    }
    expect(TUTORIAL_STEPS.length).toBe(5);
  });

  it('ステップは状態から決まる: 移動を予約 → 実行 → 近づく → 攻撃を予約 → 実行', () => {
    const c = { turn: 1, hasMovePlan: false, hasAttackPlan: false, foeInSight: false };
    expect(coachStep(c)).toBe(0);
    expect(coachStep({ ...c, hasMovePlan: true })).toBe(1);
    expect(coachStep({ ...c, turn: 2 })).toBe(2);
    expect(coachStep({ ...c, turn: 2, foeInSight: true })).toBe(3);
    expect(coachStep({ ...c, turn: 2, foeInSight: true, hasAttackPlan: true })).toBe(4);
    // 1 ターン目に敵が見えても、攻撃の案内に進む
    expect(coachStep({ ...c, foeInSight: true })).toBe(3);
  });
});
