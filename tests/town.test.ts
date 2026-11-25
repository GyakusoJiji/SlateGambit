// 地上の町(迷路・施設)のテスト
import { describe, expect, it } from 'vitest';
import { changeFloor, findTile } from '../src/core/floors';
import { generateGame, MAP_H, MAP_W } from '../src/core/generate';
import { isWalkable, step, DIR_LIST, tileAt } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import { stats } from '../src/core/stats';
import { buyItem, clinicCost, FACILITY_TILE, facilityHere, generateTown, innCost, TOWN, useClinic, useInn, useStable } from '../src/core/town';
import type { GameState, Pos } from '../src/core/types';
import { ITEMS } from '../src/data/units';

function reachable(map: GameState['map'], from: Pos): Set<string> {
  const seen = new Set([`${from.x},${from.y}`]);
  const q = [from];
  for (let i = 0; i < q.length; i++)
    for (const d of DIR_LIST) {
      const n = step(q[i], d);
      if (!isWalkable(map, n.x, n.y) || seen.has(`${n.x},${n.y}`)) continue;
      seen.add(`${n.x},${n.y}`);
      q.push(n);
    }
  return seen;
}

/** 歩数 */
function walk(map: GameState['map'], from: Pos, to: Pos): number {
  const dist = new Map([[`${from.x},${from.y}`, 0]]);
  const q = [from];
  for (let i = 0; i < q.length; i++)
    for (const d of DIR_LIST) {
      const n = step(q[i], d);
      const k = `${n.x},${n.y}`;
      if (!isWalkable(map, n.x, n.y) || dist.has(k)) continue;
      dist.set(k, dist.get(`${q[i].x},${q[i].y}`)! + 1);
      q.push(n);
    }
  return dist.get(`${to.x},${to.y}`) ?? -1;
}

describe('地上の迷路', () => {
  it('どのシードでも、入口・下り階段・4 つの施設がすべてあり、全域がつながっている', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const t = generateTown(seed, MAP_W, MAP_H);
      const reach = reachable(t.map, t.start);
      let floors = 0;
      for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (isWalkable(t.map, x, y)) floors++;
      expect(reach.size).toBe(floors);
      expect(tileAt(t.map, t.down.x, t.down.y)).toBe('>');
      for (const [id, c] of Object.entries(FACILITY_TILE)) {
        const p = t.facilities[id as keyof typeof FACILITY_TILE];
        expect(tileAt(t.map, p.x, p.y)).toBe(c);
      }
      // 入口と下り階段は、歩いて遠い
      expect(walk(t.map, t.down, t.start)).toBeGreaterThan(30);
    }
  });

  it('同じシードからは同じ町ができる', () => {
    expect(generateTown(9, MAP_W, MAP_H).map.tiles).toEqual(generateTown(9, MAP_W, MAP_H).map.tiles);
  });
});

/** 地上から始めたゲームで、施設 c のマスに戦士を立たせる */
function at(c: string, seed = 21): GameState {
  const s = generateGame(seed, 'normal');
  const p = findTile(s.map, c)!;
  const w = s.units[0];
  w.x = p.x;
  w.y = p.y;
  return s;
}

describe('施設', () => {
  it('施設のマスに立っている味方がいれば、その施設を使える', () => {
    expect(facilityHere(at('I'))).toBe('inn');
    expect(facilityHere(at('C'))).toBe('clinic');
    const s = generateGame(21, 'normal');
    expect(facilityHere(s)).toBeNull();
  });

  it('宿: 宿代(レベルの合計 × 額)を払うと、立っている全員が全快する', () => {
    const s = at('I');
    for (const u of s.units) {
      u.hp = 1;
      u.mp = 0;
    }
    expect(innCost(s)).toBe(4 * TOWN.innPerLevel);
    s.gold = 100;
    expect(useInn(s)).toBe(true);
    expect(s.gold).toBe(100 - 4 * TOWN.innPerLevel);
    for (const u of s.units) expect([u.hp, u.mp]).toEqual([stats(u).maxHp, stats(u).maxMp]);
    // 全快していれば泊まらない、お金が足りなければ泊まれない
    expect(useInn(s)).toBe(false);
    s.units[0].hp = 1;
    s.gold = 0;
    expect(useInn(s)).toBe(false);
  });

  it('馬小屋: 無料で HP を半分まで戻すだけ(MP は戻らない)', () => {
    const s = at('B');
    const w = s.units[0];
    w.hp = 1;
    w.mp = 0;
    s.gold = 0;
    expect(useStable(s)).toBe(true);
    expect(w.hp).toBe(Math.ceil(stats(w).maxHp * TOWN.stableHpRatio));
    expect(useStable(s)).toBe(false);
  });

  it('療養所: 費用を払うと気絶した味方が復帰し、担いでいた者は降ろす', () => {
    const s = at('C');
    const [w, t] = s.units;
    t.down = true;
    t.hp = 0;
    t.x = w.x;
    t.y = w.y;
    w.carrying = t.id;
    s.gold = clinicCost(t);
    expect(useClinic(s, t.id)).toBe(true);
    expect(s.gold).toBe(0);
    expect(t.down).toBe(false);
    expect(t.hp).toBe(stats(t).maxHp);
    expect(w.carrying).toBeUndefined();
    expect([t.x, t.y]).not.toEqual([w.x, w.y]);
  });

  it('道具屋: 所持金が足りる分だけ買える', () => {
    const s = at('T');
    s.gold = ITEMS.food.price;
    const food = s.items?.food ?? 0;
    expect(buyItem(s, 'food')).toBe(true);
    expect(s.items?.food).toBe(food + 1);
    expect(buyItem(s, 'food')).toBe(false);
  });
});

describe('地上と地下の行き来', () => {
  it('地上の下り階段で地下 1 階へ降り、枯れた泉は地上から潜り直すと戻る', () => {
    const s = generateGame(22, 'normal');
    expect(s.floor).toBe(0);
    changeFloor(s, 1);
    const spring = findTile(s.map, 'H')!;
    s.map.tiles[spring.y] = s.map.tiles[spring.y].slice(0, spring.x) + 'h' + s.map.tiles[spring.y].slice(spring.x + 1);
    changeFloor(s, 0);
    expect(s.floor).toBe(0);
    changeFloor(s, 1);
    expect(tileAt(s.map, spring.x, spring.y)).toBe('H');
  });

  it('地上の下り階段を使うと地下 1 階へ移る', () => {
    const s = generateGame(23, 'normal');
    const down = findTile(s.map, '>')!;
    const w = s.units[0];
    w.x = down.x;
    w.y = down.y;
    const r = resolveTurn(s, { p1: [{ type: 'stairs' }] });
    expect(r.state.floor).toBe(1);
    expect(r.events.some((e) => e.type === 'stairs' && e.from === 0 && e.to === 1)).toBe(true);
  });
});
