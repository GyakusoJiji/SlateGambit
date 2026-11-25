// 扉の開閉と、見えないマスへの火球のテスト
import { describe, expect, it } from 'vitest';
import { fillPlan } from '../src/core/actions';
import { planEnemies } from '../src/core/ai';
import { DOOR, openDoorsNear, tickDoors } from '../src/core/doors';
import { generateGame } from '../src/core/generate';
import { hasLos } from '../src/core/los';
import { parseMap, tileAt } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import type { Action, GameState, Unit } from '../src/core/types';
import { visibleFoes } from '../src/core/vision';
import { CLASSES, MONSTERS } from '../src/data/units';

function mk(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  return { id, side: CLASSES[defId] ? 'party' : 'enemy', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false, ai: CLASSES[defId] ? undefined : { mode: 'idle' } };
}

// 左右の部屋を 1 マスの扉(4,2)でつなぐ
const ROWS = ['#########', '#...#...#', '#...D...#', '#...#...#', '#########'];

function game(units: Unit[]): GameState {
  const map = parseMap(ROWS);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(1), status: 'playing' };
}

const wait = (n = 8): Action[] => fillPlan([], 'wait').slice(0, n);

describe('扉', () => {
  it('作った階の扉は閉じていて、パーティの隣のものだけ開いている', () => {
    const s = generateGame(1234, 'normal', 1);
    const party = s.units.filter((u) => u.side === 'party');
    let closed = 0;
    for (let y = 0; y < s.map.h; y++)
      for (let x = 0; x < s.map.w; x++) {
        const t = tileAt(s.map, x, y);
        if (t === 'D') closed++;
        if (t === '+') expect(party.some((u) => Math.abs(u.x - x) + Math.abs(u.y - y) <= 1)).toBe(true);
      }
    expect(closed).toBeGreaterThan(0);
  });

  it('閉じた扉は視線を遮り、扉の向こうの敵は見えない(戦闘にならない)', () => {
    const s = game([mk('p1', 'warrior', 2, 2), mk('g1', 'goblin', 6, 2)]);
    expect(hasLos(s.map, { x: 2, y: 2 }, { x: 6, y: 2 })).toBe(false);
    // 扉そのものは見える
    expect(hasLos(s.map, { x: 2, y: 2 }, { x: 4, y: 2 })).toBe(true);
    expect(visibleFoes(s.map, s.units, 'party').size).toBe(0);
    const r = resolveTurn(s, { p1: wait(), g1: [] });
    expect(visibleFoes(r.state.map, r.state.units, 'party').size).toBe(0);
  });

  it('上下左右に隣接すると開き、開けた先の敵を見て立ち止まる', () => {
    const s = game([mk('p1', 'warrior', 2, 2), mk('g1', 'goblin', 6, 2)]);
    const r = resolveTurn(s, { p1: [{ type: 'move', dir: 'E', stop: true }, { type: 'move', dir: 'E', stop: true }], g1: [] });
    expect(tileAt(r.state.map, 4, 2)).toBe('+');
    expect(r.events.some((e) => e.type === 'halt' && e.id === 'p1')).toBe(true);
    // 開いたのは 1 ティック目(3,2 に着いたとき)なので、そのフレームから地形が開いている
    expect(r.tiles?.[0][2][4]).toBe('D');
    expect(r.tiles?.[1][2][4]).toBe('+');
  });

  it('斜めの隣では開かない', () => {
    const s = game([mk('p1', 'warrior', 3, 1)]);
    expect(openDoorsNear(s.map, s.units)).toBe(false);
    expect(tileAt(s.map, 4, 2)).toBe('D');
  });

  it(`誰も近くにいなくなってから ${DOOR.openTurns} ターンで閉まる(上に誰かいる間は閉まらない)`, () => {
    const s = game([mk('p1', 'warrior', 3, 2)]);
    openDoorsNear(s.map, s.units);
    expect(tileAt(s.map, 4, 2)).toBe('+');
    // 隣にいる間は閉まらない
    for (let i = 0; i < DOOR.openTurns + 2; i++) tickDoors(s.map, s.units);
    expect(tileAt(s.map, 4, 2)).toBe('+');
    // 離れる
    s.units[0].x = 1;
    for (let i = 0; i < DOOR.openTurns - 1; i++) {
      tickDoors(s.map, s.units);
      expect(tileAt(s.map, 4, 2)).toBe('+');
    }
    // 気絶者が上にいる間は閉まらない
    const body = { ...mk('p2', 'thief', 4, 2), down: true, hp: 0 };
    tickDoors(s.map, [...s.units, body]);
    expect(tileAt(s.map, 4, 2)).toBe('+');
    tickDoors(s.map, s.units);
    expect(tileAt(s.map, 4, 2)).toBe('D');
  });
});

describe('閉じた扉とモンスターの視界', () => {
  // 扉(4,2)の右の部屋にゴブリン、左の部屋に戦士(扉には隣接していない)
  const setup = () => game([mk('p1', 'warrior', 1, 2), mk('g1', 'goblin', 6, 2), mk('a1', 'archer', 7, 2)]);
  const targeting = (plan: Action[]) => plan.some((a) => a.type === 'attack' || a.type === 'charge' || a.type === 'spell' || a.type === 'overwatch' || a.type === 'intercept');

  it('閉じた扉の向こうのキャラは見えず、狙わない・近づかない', () => {
    const s = setup();
    const plans = planEnemies(s);
    expect(targeting(plans.g1)).toBe(false);
    expect(targeting(plans.a1)).toBe(false);
    expect(plans.g1.some((a) => a.type === 'move')).toBe(false);
    // ターンが終わっても気付いていない
    const r = resolveTurn(s, { ...plans, p1: wait() });
    expect(r.state.units.find((u) => u.id === 'g1')!.ai?.alerted).toBeFalsy();
  });

  it('扉が開くと見えるようになり、狙って近づいてくる', () => {
    const s = setup();
    s.map.tiles[2] = s.map.tiles[2].slice(0, 4) + '+' + s.map.tiles[2].slice(5);
    const plans = planEnemies(s);
    expect(targeting(plans.g1) || plans.g1.some((a) => a.type === 'move')).toBe(true);
    expect(targeting(plans.a1)).toBe(true);
  });
});

describe('見えないマスへの火球', () => {
  it('射線が通らなくても撃て、着弾点は狙ったマスから最大 1 マスずれる', () => {
    let scattered = 0;
    for (let rng = 1; rng <= 40; rng++) {
      const s = { ...game([mk('p3', 'mage', 2, 2)]), rng };
      const r = resolveTurn(s, { p3: [{ type: 'spell', spell: 'fireball', tile: { x: 6, y: 2 } }] });
      expect(r.events.some((e) => e.type === 'fizzle')).toBe(false);
      const st = r.events.find((e) => e.type === 'strike');
      expect(st?.type).toBe('strike');
      if (st?.type !== 'strike') continue;
      expect(Math.max(Math.abs(st.end.x - 6), Math.abs(st.end.y - 2))).toBeLessThanOrEqual(1);
      expect(tileAt(s.map, st.end.x, st.end.y)).not.toBe('#');
      if (st.scatter) scattered++;
    }
    expect(scattered).toBeGreaterThan(0);
  });

  it('見えるマスへの火球はずれない', () => {
    const s = game([mk('p3', 'mage', 1, 2)]);
    const r = resolveTurn(s, { p3: [{ type: 'spell', spell: 'fireball', tile: { x: 3, y: 1 } }] });
    const st = r.events.find((e) => e.type === 'strike');
    expect(st?.type === 'strike' && st.end).toEqual({ x: 3, y: 1 });
  });

  it('射程外へは撃てない', () => {
    const map = parseMap(['############', '#..........#', '############']);
    const s: GameState = { seed: 1, rng: 1, turn: 1, map, units: [mk('p3', 'mage', 1, 1)], explored: new Array(map.w * map.h).fill(1), status: 'playing' };
    const r = resolveTurn(s, { p3: [{ type: 'spell', spell: 'fireball', tile: { x: 10, y: 1 } }] });
    expect(r.events.some((e) => e.type === 'fizzle')).toBe(true);
  });
});

describe('倒れた敵', () => {
  it('倒れたターンを記録する', () => {
    const g = { ...mk('g1', 'goblin', 2, 2), hp: 1 };
    const s = { ...game([mk('p1', 'warrior', 1, 2), g]), turn: 7 };
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: 'g1' }], g1: [] });
    const dead = r.state.units.find((u) => u.id === 'g1')!;
    expect(dead.down).toBe(true);
    expect(dead.downTurn).toBe(7);
  });
});
