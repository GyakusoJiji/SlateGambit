import { describe, expect, it } from 'vitest';
import { changeFloor, findTile } from '../src/core/floors';
import { BACK_LINE, FLOORS, GEN, generateFloor, generateGame, MAP_H, MAP_W, TOWN_RESIDENTS } from '../src/core/generate';
import { DIR_LIST, isWalkable, step, tileAt } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import { quickMovePlans } from '../src/core/quickmove';
import { stats } from '../src/core/stats';
import type { FloorMap, GameState, Pos } from '../src/core/types';

function reachable(map: FloorMap, from: Pos): Set<string> {
  const seen = new Set([`${from.x},${from.y}`]);
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    for (const d of DIR_LIST) {
      const s = step(q[i], d);
      const k = `${s.x},${s.y}`;
      if (seen.has(k) || !isWalkable(map, s.x, s.y)) continue;
      seen.add(k);
      q.push(s);
    }
  }
  return seen;
}

const count = (map: FloorMap, c: string) => map.tiles.join('').split(c).length - 1;

/**
 * p へ 1 歩で入れる味方とその向き。上下左右の隣に立っている味方がいればその者、
 * いなければ戦士を空いた隣のマスへ置く
 */
function walkerOnto(s: GameState, p: Pos): { id: string; dir: 'N' | 'E' | 'S' | 'W' } {
  const back = { N: 'S', S: 'N', E: 'W', W: 'E' } as const;
  for (const d of DIR_LIST) {
    const q = step(p, d);
    const u = s.units.find((o) => o.side === 'party' && !o.down && !o.carrying && o.x === q.x && o.y === q.y);
    if (u) return { id: u.id, dir: back[d] };
  }
  const b = besideOf(s, p);
  const w = s.units[0];
  w.x = b.at.x;
  w.y = b.at.y;
  return { id: w.id, dir: b.dir };
}

/** p の隣の歩けるマスと、そこから p へ戻る向き */
function besideOf(s: GameState, p: Pos) {
  const back = { N: 'S', S: 'N', E: 'W', W: 'E' } as const;
  const o = DIR_LIST.map((d) => ({ d, p: step(p, d) })).find(
    (o) => isWalkable(s.map, o.p.x, o.p.y) && !s.units.some((u) => !u.down && u.x === o.p.x && u.y === o.p.y),
  )!;
  return { at: o.p, dir: back[o.d] };
}

describe('マップ生成', () => {
  it('同じシード・難易度・階なら同じマップになる', () => {
    expect(JSON.stringify(generateGame(5, 'hard', 1))).toBe(JSON.stringify(generateGame(5, 'hard', 1)));
    // 地上の城はどのシードでも同じ間取りなので、地下 1 階で比べる
    expect(generateGame(5, 'normal', 1).map.tiles.join()).not.toBe(generateGame(6, 'normal', 1).map.tiles.join());
    expect(JSON.stringify(generateFloor(5, 'normal', 3))).toBe(JSON.stringify(generateFloor(5, 'normal', 3)));
    expect(generateFloor(5, 'normal', 2).map.tiles.join()).not.toBe(generateFloor(5, 'normal', 3).map.tiles.join());
  });

  it('どの階も床はすべてつながり、階段・宝箱・敵が置かれる', () => {
    for (let seed = 1; seed <= 25; seed++) {
      for (const diff of ['easy', 'normal', 'hard'] as const) {
        for (let floor = 1; floor <= FLOORS; floor++) {
          const f = generateFloor(seed, diff, floor);
          const reach = reachable(f.map, f.up);
          expect(reach.size).toBe(f.map.tiles.join('').split('').filter((c) => c !== '#').length);
          expect(count(f.map, 'S')).toBe(1);
          expect(count(f.map, '>')).toBe(floor < FLOORS ? 1 : 0);
          expect(count(f.map, '$')).toBeGreaterThanOrEqual(2);
          expect(count(f.map, '$')).toBeLessThanOrEqual(3);
          expect(f.enemies.length).toBeGreaterThan(1);
          const cells = f.enemies.map((u) => `${u.x},${u.y}`);
          expect(new Set(cells).size).toBe(cells.length);
          for (const u of f.enemies) expect(tileAt(f.map, u.x, u.y)).toBe('.');
          const boss = f.enemies.filter((u) => u.defId === 'dragon' || u.defId === 'wyrm');
          if (floor < FLOORS) {
            expect(boss.length).toBe(0);
            expect(f.treasureAt).toBeNull();
          } else {
            // 地下 5 階: 秘宝と、眠っているドラゴンが 1 体
            expect(boss.length).toBe(1);
            expect(boss[0].defId).toBe(diff === 'easy' ? 'wyrm' : 'dragon');
            expect(boss[0].ai?.asleep).toBe(true);
            expect(reach.has(`${f.treasureAt!.x},${f.treasureAt!.y}`)).toBe(true);
          }
        }
      }
    }
  });

  it('新しいゲームは地上の町の入口から始まり、目的は秘宝', () => {
    const t = generateGame(7, 'normal');
    expect(t.floor).toBe(0);
    // 地上にはモンスターはおらず、住人(一部は化けた盗人)だけ
    const others = t.units.filter((u) => u.side === 'enemy');
    expect(others.length).toBe(TOWN_RESIDENTS.normal);
    expect(others.every((u) => u.defId === 'resident')).toBe(true);
    expect(findTile(t.map, '>')).not.toBeNull();
    expect(t.objective).toEqual({ kind: 'treasure', at: null, floor: FLOORS });
  });

  it('地下 1 階から始めると、入口の周りにパーティがいる', () => {
    const s = generateGame(7, 'normal', 1);
    expect(s.floor).toBe(1);
    expect(s.map.w).toBe(MAP_W);
    expect(s.map.h).toBe(MAP_H);
    const party = s.units.filter((u) => u.side === 'party');
    expect(party.length).toBe(4);
    const up = findTile(s.map, 'S')!;
    for (const u of party) {
      expect(tileAt(s.map, u.x, u.y)).toBe('.');
      expect(Math.abs(u.x - up.x) + Math.abs(u.y - up.y)).toBeLessThanOrEqual(4);
      expect(u.level).toBe(1);
    }
    expect(s.objective).toEqual({ kind: 'treasure', at: null, floor: FLOORS });
  });

  it('難易度が上がるほど、深い階ほど敵が多い(平均)', () => {
    const avg = (d: 'easy' | 'normal' | 'hard', floor: number) => {
      let n = 0;
      for (let seed = 1; seed <= 30; seed++) n += generateFloor(seed, d, floor).enemies.length;
      return n / 30;
    };
    expect(avg('easy', 2)).toBeLessThan(avg('normal', 2));
    expect(avg('normal', 2)).toBeLessThan(avg('hard', 2));
    expect(avg('normal', 1)).toBeLessThan(avg('normal', 4));
  });

  it('途中の階から始めると、その階に見合ったレベルになる', () => {
    const s = generateGame(3, 'normal', 5);
    expect(s.floor).toBe(5);
    const w = s.units.find((u) => u.id === 'p1')!;
    expect(w.level).toBe(5);
    expect(w.hp).toBe(stats(w).maxHp);
    expect(s.objective).toMatchObject({ kind: 'treasure', floor: 5 });
    expect((s.objective as { at: Pos }).at).not.toBeNull();
  });
});

describe('敵の編成', () => {
  /** 後衛の近く(3 マス以内)にいる前衛のうち、後衛より上り階段からの歩数が少ない者の割合 */
  function frontRatio(): number {
    let pairs = 0;
    let ordered = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const f = generateFloor(seed, 'normal', 3);
      const dist = new Map<string, number>([[`${f.up.x},${f.up.y}`, 0]]);
      const q = [f.up];
      for (let i = 0; i < q.length; i++) {
        for (const d of DIR_LIST) {
          const n = step(q[i], d);
          const k = `${n.x},${n.y}`;
          if (dist.has(k) || !isWalkable(f.map, n.x, n.y)) continue;
          dist.set(k, dist.get(`${q[i].x},${q[i].y}`)! + 1);
          q.push(n);
        }
      }
      const dd = (p: Pos) => dist.get(`${p.x},${p.y}`)!;
      for (const b of f.enemies.filter((e) => BACK_LINE.has(e.defId))) {
        for (const fr of f.enemies.filter((e) => !BACK_LINE.has(e.defId) && Math.max(Math.abs(e.x - b.x), Math.abs(e.y - b.y)) <= 3)) {
          pairs++;
          if (dd(fr) < dd(b)) ordered++;
        }
      }
    }
    return ordered / pairs;
  }

  it('編成を入れると、後衛の近くの前衛が入口(上り階段)側に並ぶことが、ばらばらに置くときより多い', () => {
    const saved = GEN.formationRate;
    try {
      GEN.formationRate = 0;
      const random = frontRatio();
      GEN.formationRate = 1;
      const formed = frontRatio();
      expect(formed).toBeGreaterThan(random + 0.15);
    } finally {
      GEN.formationRate = saved;
    }
  });
});

describe('階段', () => {
  it('下り階段に 1 人が入ると、全員(担がれた気絶者を含む)が次の階の上り階段の周りへ移る', () => {
    const s = generateGame(11, 'easy', 1);
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const [w, t, , p] = s.units;
    // 盗賊は気絶して僧侶に担がれている
    t.down = true;
    t.hp = 0;
    p.carrying = t.id;
    const down = findTile(s.map, '>')!;
    const b = besideOf(s, down);
    w.x = b.at.x;
    w.y = b.at.y;
    const r = resolveTurn(s, { p1: [{ type: 'move', dir: b.dir }, { type: 'stairs' }] });
    expect(r.events.some((e) => e.type === 'stairs' && e.from === 1 && e.to === 2)).toBe(true);
    const n = r.state;
    expect(n.floor).toBe(2);
    expect(n.deepest).toBe(2);
    expect(n.status).toBe('playing');
    expect(n.floors?.[1]).toBeDefined();
    const up = findTile(n.map, 'S')!;
    const party = n.units.filter((u) => u.side === 'party');
    expect(party.length).toBe(4);
    for (const u of party) {
      expect(tileAt(n.map, u.x, u.y)).not.toBe('S');
      expect(Math.abs(u.x - up.x) + Math.abs(u.y - up.y)).toBeLessThanOrEqual(4);
    }
    const priest = party.find((u) => u.id === p.id)!;
    const thief = party.find((u) => u.id === t.id)!;
    expect(priest.carrying).toBe(thief.id);
    expect([thief.x, thief.y]).toEqual([priest.x, priest.y]);
    // 敵は地下 2 階のものに入れ替わる
    expect(n.units.filter((u) => u.side === 'enemy').every((u) => u.id.startsWith('2'))).toBe(true);
  });

  it('上り階段で戻ると、前の階の敵・開けた宝箱・探索済み範囲がそのまま残っている', () => {
    const s = generateGame(12, 'normal', 1);
    const e1 = s.units.find((u) => u.side === 'enemy')!;
    e1.hp = 3;
    const chest = findTile(s.map, '$')!;
    s.map.tiles[chest.y] = s.map.tiles[chest.y].slice(0, chest.x) + 'c' + s.map.tiles[chest.y].slice(chest.x + 1);
    const explored = s.explored.reduce((a, b) => a + b, 0);
    changeFloor(s, 2);
    expect(s.floor).toBe(2);
    // 地下 2 階の上り階段へ歩く
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const up = findTile(s.map, 'S')!;
    const k = walkerOnto(s, up);
    const r = resolveTurn(s, { [k.id]: [{ type: 'move', dir: k.dir }, { type: 'stairs' }] });
    const n = r.state;
    expect(n.floor).toBe(1);
    const back = n.units.find((u) => u.id === e1.id)!;
    expect(back.hp).toBe(3);
    expect(tileAt(n.map, chest.x, chest.y)).toBe('c');
    expect(n.explored.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(explored);
    // 下り階段の周りに着く
    const down = findTile(n.map, '>')!;
    for (const u of n.units.filter((u) => u.side === 'party')) expect(Math.abs(u.x - down.x) + Math.abs(u.y - down.y)).toBeLessThanOrEqual(4);
    // 地下 2 階は退避されている(敵を倒した状態のまま)
    expect(n.floors?.[2]?.enemies.every((u) => u.down)).toBe(true);
  });

  it('地下 1 階の上り階段からは地上へ出る(秘宝が無ければ勝ちにはならない)', () => {
    const s = generateGame(13, 'easy', 1);
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const up = findTile(s.map, 'S')!;
    const k = walkerOnto(s, up);
    const r = resolveTurn(s, { [k.id]: [{ type: 'move', dir: k.dir }, { type: 'stairs' }] });
    expect(r.state.floor).toBe(0);
    expect(r.state.status).toBe('playing');
    expect(r.events.some((e) => e.type === 'stairs' && e.from === 1 && e.to === 0)).toBe(true);
    // 地上の下り階段の周りに着く
    const down = findTile(r.state.map, '>')!;
    for (const u of r.state.units.filter((u) => u.side === 'party')) expect(Math.abs(u.x - down.x) + Math.abs(u.y - down.y)).toBeLessThanOrEqual(6);
  });

  it('階段を使う予約が無ければ、階段の上でターンを終えても移らない(通り道の階段)', () => {
    const s = generateGame(11, 'easy', 1);
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const down = findTile(s.map, '>')!;
    const k = walkerOnto(s, down);
    const r = resolveTurn(s, { [k.id]: [{ type: 'move', dir: k.dir }] });
    const me = r.state.units.find((u) => u.id === k.id)!;
    expect([me.x, me.y]).toEqual([down.x, down.y]);
    expect(r.state.floor ?? 1).toBe(1);
    expect(r.events.some((e) => e.type === 'stairs')).toBe(false);
  });

  it('全員移動で階段を行き先にすると、先頭だけが階段を使い、着いたターンに移る', () => {
    const s = generateGame(11, 'easy', 1);
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const down = findTile(s.map, '>')!;
    const b = besideOf(s, down);
    const w = s.units[0];
    w.x = b.at.x;
    w.y = b.at.y;
    const plans = quickMovePlans(s, w.id, down)!;
    expect(plans[w.id].at(-1)).toEqual({ type: 'stairs' });
    for (const [id, list] of Object.entries(plans)) if (id !== w.id) expect(list.some((a) => a.type === 'stairs')).toBe(false);
    expect(resolveTurn(s, plans).state.floor).toBe(2);
    // 先頭がすでに階段の上にいれば、階段を使うだけ
    w.x = down.x;
    w.y = down.y;
    expect(quickMovePlans(s, w.id, down)).toEqual({ [w.id]: [{ type: 'stairs' }] });
    // 行き先が階段でなければ、誰も階段を使わない
    const plain = quickMovePlans(s, w.id, b.at)!;
    expect(Object.values(plain).flat().some((a) => a.type === 'stairs')).toBe(false);
  });
});

describe('宝箱', () => {
  it('宝箱に立つと開いてゴールドが増え、同じ宝箱は 2 回開かない', () => {
    const s = generateGame(14, 'easy', 1);
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const chest = findTile(s.map, '$')!;
    const b = besideOf(s, chest);
    const w = s.units[0];
    w.x = b.at.x;
    w.y = b.at.y;
    const back = { N: 'S', S: 'N', E: 'W', W: 'E' } as const;
    let r = resolveTurn(s, { p1: [{ type: 'move', dir: b.dir }, { type: 'move', dir: back[b.dir] }, { type: 'move', dir: b.dir }] });
    const opened = r.events.filter((e) => e.type === 'chest');
    expect(opened.length).toBe(1);
    const gold = r.state.gold!;
    expect(gold).toBeGreaterThanOrEqual(10);
    expect(tileAt(r.state.map, chest.x, chest.y)).toBe('c');
    r = resolveTurn(r.state, {});
    expect(r.state.gold).toBe(gold);
  });
});

describe('秘宝', () => {
  it('秘宝のマスに立つと拾い、地上へ上がると勝ち。地下 2 階以降の上り階段では階を移るだけ', () => {
    const s = generateGame(3, 'easy', 5);
    for (const u of s.units) if (u.side === 'enemy') u.down = true;
    const at = (s.objective as { at: Pos }).at;
    const b = besideOf(s, at);
    const w = s.units[0];
    w.x = b.at.x;
    w.y = b.at.y;
    let r = resolveTurn(s, { p1: [{ type: 'move', dir: b.dir }] });
    expect(r.events.some((e) => e.type === 'treasure' && e.got && e.id === 'p1')).toBe(true);
    expect(r.state.status).toBe('playing');

    // 地下 5 階の上り階段 → 地下 4 階へ移るだけ
    let st = r.state;
    let up = findTile(st.map, 'S')!;
    let nb = besideOf(st, up);
    const p1 = () => st.units.find((u) => u.id === 'p1')!;
    p1().x = nb.at.x;
    p1().y = nb.at.y;
    r = resolveTurn(st, { p1: [{ type: 'move', dir: nb.dir }, { type: 'stairs' }] });
    expect(r.state.status).toBe('playing');
    expect(r.state.floor).toBe(4);

    // 地下 1 階の上り階段に乗るだけでは勝ちにならず、階段を使って地上へ上がると勝ち
    st = r.state;
    changeFloor(st, 1);
    for (const u of st.units) if (u.side === 'enemy') u.down = true;
    up = findTile(st.map, 'S')!;
    nb = besideOf(st, up);
    p1().x = nb.at.x;
    p1().y = nb.at.y;
    r = resolveTurn(st, { p1: [{ type: 'move', dir: nb.dir }] });
    expect(r.state.status).toBe('playing');
    r = resolveTurn(r.state, { p1: [{ type: 'stairs' }] });
    expect(r.state.floor).toBe(0);
    expect(r.state.status).toBe('won');
  });

  it('秘宝を持った味方が気絶すると、秘宝はその階のその場に落ちる', () => {
    const s = generateGame(3, 'easy', 2);
    const w = s.units[0];
    s.objective = { kind: 'treasure', at: null, floor: 5, holder: w.id };
    w.hp = 1;
    const g = s.units.find((u) => u.side === 'enemy')!;
    const nb = DIR_LIST.map((d) => step(w, d)).find((p) => isWalkable(s.map, p.x, p.y) && !s.units.some((u) => u.x === p.x && u.y === p.y))!;
    g.x = nb.x;
    g.y = nb.y;
    const r = resolveTurn(s, { [g.id]: [{ type: 'attack', target: w.id }] });
    expect(r.events.some((e) => e.type === 'treasure' && !e.got)).toBe(true);
    expect(r.state.objective).toEqual({ kind: 'treasure', at: { x: w.x, y: w.y }, floor: 2, holder: undefined });
  });
});
