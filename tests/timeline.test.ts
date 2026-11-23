// 予約の時間軸と、対象を選ぶモードで届くマスのテスト
import { describe, expect, it } from 'vitest';
import { parseMap } from '../src/core/map';
import type { GameState, Unit } from '../src/core/types';
import { CLASSES, MONSTERS } from '../src/data/units';
import { reachInfo, tickCells, tickPositions } from '../src/ui/timeline';

const OPEN = [
  '##########',
  '#........#',
  '#........#',
  '#...#....#',
  '#........#',
  '##########',
];

function mk(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  return { id, side: CLASSES[defId] ? 'party' : 'enemy', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false };
}

function game(units: Unit[]): GameState {
  const map = parseMap(OPEN);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(1), status: 'playing' };
}

describe('時間軸', () => {
  it('移動・構え・発動・予約していない残りを 8 ティックに並べる', () => {
    const cells = tickCells([{ type: 'move', dir: 'E' }, { type: 'attack', target: 'g1' }], 'guard');
    expect(cells.map((c) => c.glyph)).toEqual(['→', '構', '構', '攻', '防', '防', '防', '防']);
    expect(cells.map((c) => c.hit)).toEqual([false, false, false, true, false, false, false, false]);
    expect(cells.map((c) => c.fill)).toEqual([false, false, false, false, true, true, true, true]);
  });

  it('各ティックの終わりの予定位置(壁には入らない)', () => {
    const w = mk('p1', 'warrior', 3, 3);
    const s = game([w]);
    const pos = tickPositions(s, w, [{ type: 'move', dir: 'E' }, { type: 'move', dir: 'N' }]);
    expect(pos).toHaveLength(9);
    // (4,3) は壁なので動かない
    expect(pos[1]).toEqual({ x: 3, y: 3 });
    expect(pos[2]).toEqual({ x: 3, y: 2 });
    expect(pos[8]).toEqual({ x: 3, y: 2 });
  });

  it('接近攻撃は経路の目安をたどる', () => {
    const w = mk('p1', 'warrior', 1, 1);
    const s = game([w, mk('g1', 'goblin', 6, 1)]);
    const pos = tickPositions(s, w, [{ type: 'charge', target: 'g1', ticks: 8 }]);
    expect(pos[1]).toEqual({ x: 2, y: 1 });
    expect(pos[4]).toEqual({ x: 5, y: 1 });
    expect(pos[8]).toEqual({ x: 5, y: 1 });
  });
});

describe('届く範囲', () => {
  it('遠隔の攻撃は射程内で射線の通るマスと、射線上に味方のいない敵', () => {
    const t = mk('p2', 'thief', 1, 3);
    const s = game([t, mk('p1', 'warrior', 3, 2), mk('g1', 'goblin', 6, 3), mk('g2', 'goblin', 5, 1), mk('g3', 'goblin', 2, 4)]);
    const { tiles, targets } = reachInfo(s, t, t, 'attack');
    // (4,3) の壁の向こう (6,3) は射線が通らない。(5,1) の g2 は (3,2) の戦士越しなので撃てない
    expect(tiles.some((p) => p.x === 6 && p.y === 3)).toBe(false);
    expect(targets.map((u) => u.id).sort()).toEqual(['g3']);
  });

  it('近接の攻撃は隣接、担ぐ・蘇生は気絶した味方', () => {
    const w = mk('p1', 'warrior', 2, 2);
    const down = mk('p4', 'priest', 3, 3);
    down.down = true;
    const s = game([w, down, mk('g1', 'goblin', 1, 1)]);
    expect(reachInfo(s, w, w, 'attack').targets.map((u) => u.id)).toEqual(['g1']);
    expect(reachInfo(s, w, w, 'attack').tiles).toHaveLength(8);
    expect(reachInfo(s, w, w, 'carry').targets.map((u) => u.id)).toEqual(['p4']);
  });
});
