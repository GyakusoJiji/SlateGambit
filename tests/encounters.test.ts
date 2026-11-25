// 固定遭遇(部屋の定義から遭遇を作る仕組み)のテスト。部屋はチュートリアルのレッスンを使う
import { describe, expect, it } from 'vitest';
import { createEncounter, ENCOUNTER_LEVEL } from '../src/core/encounters';
import { resolveTurn } from '../src/core/resolve';
import { fillPlan } from '../src/core/actions';
import { LESSONS } from '../src/core/tutorial';
import type { GameState } from '../src/core/types';

describe('固定遭遇', () => {
  it('どの部屋も作れて、味方 4 人(p1 戦士〜p4 僧侶)がいて、地図に印の文字が残らない', () => {
    for (const e of LESSONS) {
      const s = createEncounter(e.id, 1)!;
      expect(s.scenario).toBe(e.id);
      const party = s.units.filter((u) => u.side === 'party');
      expect(party.map((u) => u.defId)).toEqual(['warrior', 'thief', 'mage', 'priest']);
      expect(party.map((u) => u.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(party.every((u) => u.level === ENCOUNTER_LEVEL)).toBe(true);
      expect(s.map.tiles.join('')).toMatch(/^[#.SH>$c+]+$/);
    }
  });

  it('救出: 戦士が出口に着くまでは、敵を全滅させても勝ちにならない', () => {
    // 気絶した戦士のいる部屋に敵を置いた上で、全滅させても勝ちにならない
    const s = createEncounter('tut-carry', 1)!;
    s.units.push({ id: 'g1', side: 'enemy', defId: 'goblin', name: 'ゴブリン', x: 14, y: 5, hp: 0, mp: 0, down: true, ai: { mode: 'idle' } });
    expect(resolveTurn(s, {}).state.status).toBe('playing');
  });

  it('知らない ID なら作らない', () => {
    expect(createEncounter('nothing', 1)).toBeNull();
  });

  it('固定遭遇では休憩しても物音で敵が現れない', () => {
    const s = createEncounter('tut-trip', 1)!;
    // 敵がいない(戦闘中でない)状態で、傷んだ味方が休み続けても、敵が現れない
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    let st = s;
    for (let i = 0; i < 30; i++) {
      st.units[0].hp = 1;
      st = resolveTurn(st, { [st.units[0].id]: fillPlan([], 'rest') }).state;
    }
    expect(st.units.some((u) => /^w\d/.test(u.id))).toBe(false);
    // 比べるため、固定遭遇の印を外すと現れる
    let free: GameState = { ...s, scenario: undefined };
    for (let i = 0; i < 30; i++) {
      free.units[0].hp = 1;
      free = resolveTurn(free, { [free.units[0].id]: fillPlan([], 'rest') }).state;
    }
    expect(free.units.some((u) => /^w\d/.test(u.id))).toBe(true);
  });
});
