import { describe, expect, it } from 'vitest';
import { generateGame, MAP_H, MAP_W } from '../src/core/generate';
import { DIR_LIST, isWalkable, step, tileAt } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import type { GameState, Pos } from '../src/core/types';

function reachable(state: GameState, from: Pos): Set<string> {
  const seen = new Set([`${from.x},${from.y}`]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    for (const d of DIR_LIST) {
      const s = step(q[i], d);
      const k = `${s.x},${s.y}`;
      if (seen.has(k) || !isWalkable(state.map, s.x, s.y)) continue;
      seen.add(k);
      q.push(s);
    }
  }
  return seen;
}

describe('マップ生成', () => {
  it('同じシード・難易度なら同じマップになる', () => {
    expect(JSON.stringify(generateGame(5, 'hard'))).toBe(JSON.stringify(generateGame(5, 'hard')));
    expect(generateGame(5).map.tiles.join()).not.toBe(generateGame(6).map.tiles.join());
  });

  it('床はすべてつながり、全ユニットが床の別々のマスにいる', () => {
    for (let seed = 1; seed <= 60; seed++) {
      for (const diff of ['easy', 'normal', 'hard'] as const) {
        const s = generateGame(seed, diff);
        expect(s.map.w).toBe(MAP_W);
        expect(s.map.h).toBe(MAP_H);
        const start = s.units[0];
        const reach = reachable(s, start);
        const floors = s.map.tiles.join('').split('').filter((c) => c !== '#').length;
        expect(reach.size).toBe(floors);
        const cells = s.units.map((u) => `${u.x},${u.y}`);
        expect(new Set(cells).size).toBe(cells.length);
        for (const u of s.units) expect(isWalkable(s.map, u.x, u.y)).toBe(true);
        expect(s.map.tiles.join('').split('S').length - 1).toBe(1);
        expect(s.units.filter((u) => u.side === 'enemy').length).toBeGreaterThan(1);
        // ボスのドラゴンは必ず 1 体
        expect(s.units.filter((u) => u.defId === 'dragon').length).toBe(1);
        if (s.objective?.kind === 'treasure') {
          const at = s.objective.at!;
          expect(reach.has(`${at.x},${at.y}`)).toBe(true);
        }
      }
    }
  });

  it('難易度が上がるほど敵が多い(平均)', () => {
    const avg = (d: 'easy' | 'normal' | 'hard') => {
      let n = 0;
      for (let seed = 1; seed <= 30; seed++) n += generateGame(seed, d).units.filter((u) => u.side === 'enemy').length;
      return n / 30;
    };
    expect(avg('easy')).toBeLessThan(avg('normal'));
    expect(avg('normal')).toBeLessThan(avg('hard'));
  });

  it('目的は全滅と宝探しの両方が出る', () => {
    const kinds = new Set(Array.from({ length: 30 }, (_, i) => generateGame(i + 1).objective?.kind));
    expect(kinds).toEqual(new Set(['annihilate', 'treasure']));
  });
});

describe('宝探し', () => {
  it('宝のマスに立つと拾い、入口の階段に戻ると勝ち', () => {
    const s = generateGame(3, 'easy', 'treasure');
    // 敵を片付け、戦士を宝の隣に置く
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const at = (s.objective as { at: Pos }).at;
    const w = s.units[0];
    const from = DIR_LIST.map((d) => ({ d, p: step(at, d) })).find((o) => isWalkable(s.map, o.p.x, o.p.y))!;
    w.x = from.p.x;
    w.y = from.p.y;
    const back = { N: 'S', S: 'N', E: 'W', W: 'E' } as const;
    let r = resolveTurn(s, { p1: [{ type: 'move', dir: back[from.d] }] });
    expect(r.events.some((e) => e.type === 'treasure' && e.got && e.id === 'p1')).toBe(true);
    expect(r.state.status).toBe('playing');
    // 入口の階段へ移す
    const st = r.state;
    const sIdx = st.map.tiles.join('').indexOf('S');
    const sp = { x: sIdx % st.map.w, y: Math.floor(sIdx / st.map.w) };
    const nb = DIR_LIST.map((d) => ({ d, p: step(sp, d) })).find((o) => isWalkable(st.map, o.p.x, o.p.y) && !st.units.some((u) => u.x === o.p.x && u.y === o.p.y))!;
    const p1 = st.units.find((u) => u.id === 'p1')!;
    p1.x = nb.p.x;
    p1.y = nb.p.y;
    r = resolveTurn(st, { p1: [{ type: 'move', dir: back[nb.d] }] });
    expect(tileAt(r.state.map, p1.x, p1.y)).not.toBe('S');
    expect(r.state.status).toBe('won');
  });

  it('宝を持った味方が気絶すると宝はその場に落ちる', () => {
    const s = generateGame(3, 'easy', 'treasure');
    const w = s.units[0];
    s.objective = { kind: 'treasure', at: null, holder: w.id };
    w.hp = 1;
    // 隣に敵を置いて殴らせる
    const g = s.units.find((u) => u.side === 'enemy')!;
    const nb = DIR_LIST.map((d) => step(w, d)).find((p) => isWalkable(s.map, p.x, p.y) && !s.units.some((u) => u.x === p.x && u.y === p.y))!;
    g.x = nb.x;
    g.y = nb.y;
    const r = resolveTurn(s, { [g.id]: [{ type: 'attack', target: w.id }] });
    expect(r.events.some((e) => e.type === 'treasure' && !e.got)).toBe(true);
    expect(r.state.objective).toEqual({ kind: 'treasure', at: { x: w.x, y: w.y }, holder: undefined });
  });
});
