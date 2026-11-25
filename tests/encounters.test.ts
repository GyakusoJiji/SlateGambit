// 固定遭遇のテスト
import { describe, expect, it } from 'vitest';
import { createEncounter, ENCOUNTER_LEVEL, ENCOUNTERS } from '../src/core/encounters';
import { resolveTurn } from '../src/core/resolve';
import { fillPlan } from '../src/core/actions';
import type { GameState } from '../src/core/types';

describe('固定遭遇', () => {
  it('どの固定遭遇も作れて、味方 4 人(p1 戦士〜p4 僧侶)と敵がいる', () => {
    for (const e of ENCOUNTERS) {
      const s = createEncounter(e.id, 1)!;
      expect(s.scenario).toBe(e.id);
      const party = s.units.filter((u) => u.side === 'party');
      expect(party.map((u) => u.defId)).toEqual(['warrior', 'thief', 'mage', 'priest']);
      expect(party.map((u) => u.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
      expect(party.every((u) => u.level === ENCOUNTER_LEVEL)).toBe(true);
      expect(s.units.some((u) => u.side === 'enemy')).toBe(true);
      // 地図に印の文字が残っていない
      expect(s.map.tiles.join('')).toMatch(/^[#.SH>$c+]+$/);
    }
  });

  it('救出: 気絶した戦士を担いで出口の階段まで運べば勝ち(運ぶ者が立っていれば、担がれた戦士も一緒)', () => {
    const s = createEncounter('rescue', 1)!;
    expect(s.objective).toEqual({ kind: 'escape', who: 'p1' });
    const w = s.units.find((u) => u.id === 'p1')!;
    expect(w.down).toBe(true);
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const exit = { x: 1, y: 3 };
    expect(s.map.tiles[exit.y][exit.x]).toBe('S');
    const priest = s.units.find((u) => u.id === 'p4')!;
    priest.x = exit.x;
    priest.y = exit.y + 1;
    priest.carrying = 'p1';
    w.x = priest.x;
    w.y = priest.y;
    const r = resolveTurn(s, { p4: [{ type: 'move', dir: 'N', slow: true }] });
    expect(r.state.status).toBe('won');
  });

  it('救出: 戦士が出口に着くまでは、敵を全滅させても勝ちにならない', () => {
    const s = createEncounter('rescue', 1)!;
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    expect(resolveTurn(s, {}).state.status).toBe('playing');
  });

  it('知らない ID なら作らない', () => {
    expect(createEncounter('nothing', 1)).toBeNull();
  });

  it('固定遭遇では休憩しても物音で敵が現れない', () => {
    const s = createEncounter(ENCOUNTERS[0].id, 1)!;
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
