// 予約の時間軸と、対象を選ぶモードで届くマスのテスト
import { describe, expect, it } from 'vitest';
import { parseMap } from '../src/core/map';
import type { GameState, Unit } from '../src/core/types';
import { CLASSES, MONSTERS } from '../src/data/units';
import { resolveTurn } from '../src/core/resolve';
import { cursorTickFor, previewPlan, reachInfo, shoveDelay, tickCells, tickPositions, unitsAtTick } from '../src/ui/timeline';

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

  it('押し返しを見込む: 押した敵の位置を追い、踏ん張りで後ろの予約を遅らせる(エンジンと同じ結果)', () => {
    const w = mk('p1', 'warrior', 1, 1);
    const s = game([w, mk('g1', 'goblin', 2, 1)]);
    const plan = [{ type: 'move' as const, dir: 'E' as const }, { type: 'move' as const, dir: 'E' as const }, { type: 'attack' as const, target: 'g1' }];
    const pv = previewPlan(s, w, plan);
    // t1 押す → t2 踏ん張り → t3 もう一度押す → t4 踏ん張り → t5〜t7 攻撃
    expect(pv.pushes.map((p) => [p.tick, p.to.x])).toEqual([[1, 3], [3, 4]]);
    expect(pv.end).toEqual({ x: 3, y: 1 });
    expect(pv.pos[2]).toEqual({ x: 2, y: 1 });
    expect(shoveDelay(s, w, plan)).toBe(2);
    expect(tickCells(plan, 'guard', { st: s, u: w }).map((c) => c.glyph)).toEqual(['押', '踏', '押', '踏', '構', '構', '攻', '防']);
    // 押された敵は、押されたティックの後は後ろへ動いて見える(押したあとの攻撃が届く)
    expect(unitsAtTick(s, { p1: plan }, 3).find((u) => u.id === 'g1')).toMatchObject({ x: 4, y: 1 });
    expect(reachInfo(s, w, pv.end, 'attack', unitsAtTick(s, { p1: plan }, 7)).targets.map((u) => u.id)).toEqual(['g1']);
    // 同じ予約をエンジンで解決しても、同じ位置になって攻撃が当たる
    const r = resolveTurn({ ...s, items: { food: 9 } }, { p1: plan, g1: [{ type: 'guard' }] });
    expect(r.state.units.find((u) => u.id === 'p1')).toMatchObject(pv.end);
    expect(r.state.units.find((u) => u.id === 'g1')).toMatchObject({ x: 4, y: 1 });
    expect(r.events.some((e) => e.type === 'damage' && e.by === 'p1' && e.tick === 7)).toBe(true);
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

  it('予約済みの味方の移動を発動ティックに合わせて反映し、射線の開通や遮蔽を判定できる', () => {
    // 初期位置では盗賊(1,2)とゴブリン(6,2)の間に戦士(3,2)が立っている
    const thief = mk('p2', 'thief', 1, 2);
    const warrior = mk('p1', 'warrior', 3, 2);
    const goblin = mk('g1', 'goblin', 6, 2);
    const s = game([warrior, thief, goblin]);
    // 予約なし(Tick 3)では戦士が射線上にいるので撃てない
    const hitTick = cursorTickFor([], 'attack');
    expect(hitTick).toBe(3);
    expect(reachInfo(s, thief, thief, 'attack', unitsAtTick(s, {}, hitTick)).targets).toHaveLength(0);
    // 戦士が Tick 1 で南へ 1 マスどく予約をしていれば、Tick 3 発射時には射線が通る
    const plans = { p1: [{ type: 'move' as const, dir: 'S' as const }] };
    expect(reachInfo(s, thief, thief, 'attack', unitsAtTick(s, plans, hitTick)).targets.map((u) => u.id)).toEqual(['g1']);
  });
});
