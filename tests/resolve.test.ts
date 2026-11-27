import { describe, expect, it } from 'vitest';
import { RULES, canAppend, fillPlan } from '../src/core/actions';
import { planEnemies } from '../src/core/ai';
import { parseMap } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import { createTestGame } from '../src/core/scenario';
import type { Action, GameState, Plans, Unit } from '../src/core/types';
import { CLASSES, MONSTERS, SPELLS } from '../src/data/units';

const OPEN = [
  '############',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '#..........#',
  '############',
];

function mk(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  return {
    id,
    side: CLASSES[defId] ? 'party' : 'enemy',
    defId,
    name: d.name,
    x,
    y,
    hp: d.maxHp,
    mp: d.maxMp,
    down: false,
    ai: CLASSES[defId] ? undefined : { mode: 'idle' },
  };
}

function game(units: Unit[], rows = OPEN, seed = 1): GameState {
  const map = parseMap(rows);
  // 休憩には食料が要るので、十分に持たせておく
  return { seed, rng: seed, turn: 1, map, units, explored: new Array(map.w * map.h).fill(0), status: 'playing', items: { food: 99 } };
}

const u = (s: GameState, id: string) => s.units.find((x) => x.id === id)!;
const moves = (dir: 'N' | 'E' | 'S' | 'W', n: number): Action[] => Array.from({ length: n }, () => ({ type: 'move', dir }));

describe('移動', () => {
  it('予約どおりに移動する', () => {
    const r = resolveTurn(game([mk('p1', 'warrior', 1, 1)]), { p1: moves('E', 3) });
    expect(u(r.state, 'p1')).toMatchObject({ x: 4, y: 1 });
    expect(r.frames).toHaveLength(9);
  });

  it('壁には入れない', () => {
    const r = resolveTurn(game([mk('p1', 'warrior', 1, 1)]), { p1: moves('N', 1) });
    expect(u(r.state, 'p1')).toMatchObject({ x: 1, y: 1 });
    expect(r.events.some((e) => e.type === 'bump')).toBe(true);
  });

  it('同じマスへの同時進入は 1 体だけ成功する', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 3, 1)]);
    const r = resolveTurn(s, { p1: moves('E', 1), g1: moves('W', 1) });
    const a = u(r.state, 'p1');
    const b = u(r.state, 'g1');
    const entered = [a.x === 2, b.x === 2].filter(Boolean).length;
    expect(entered).toBe(1);
  });

  it('味方同士はすれ違い(入れ替わり)ができる', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 2, 1)]);
    const r = resolveTurn(s, { p1: moves('E', 1), p2: moves('W', 1) });
    expect(u(r.state, 'p1')).toMatchObject({ x: 2 });
    expect(u(r.state, 'p2')).toMatchObject({ x: 1 });
  });

  it('設定で敵とのすれ違いを許可できる', () => {
    RULES.passThroughFoes = true;
    try {
      const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 1)]);
      const r = resolveTurn(s, { p1: moves('E', 1), g1: moves('W', 1) });
      expect(u(r.state, 'p1')).toMatchObject({ x: 2 });
      expect(u(r.state, 'g1')).toMatchObject({ x: 1 });
    } finally {
      RULES.passThroughFoes = false;
    }
  });

  it('止まっているユニットのマスを通り抜けられる', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 2, 1)]);
    const r = resolveTurn(s, { p1: moves('E', 3) });
    expect(u(r.state, 'p1')).toMatchObject({ x: 4, y: 1 });
    expect(u(r.state, 'p2')).toMatchObject({ x: 2, y: 1 });
  });

  it('止まっているユニットのマスには止まれない', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 3, 1)]);
    const r = resolveTurn(s, { p1: moves('E', 2) });
    expect(u(r.state, 'p1')).toMatchObject({ x: 2, y: 1 });
    expect(u(r.state, 'p2')).toMatchObject({ x: 3, y: 1 });
  });

  it('通り抜けの途中で止まったら空きマスへ押し出される', () => {
    // p1 が p2 のマスを通る途中、行き先の (3,1) に g1 が同時に止まって入れない
    const s = game([mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 2, 1), mk('g1', 'goblin', 3, 2)]);
    const r = resolveTurn(s, { p1: [...moves('E', 2)], g1: [{ type: 'wait' }, ...moves('N', 1)] });
    const tiles = r.state.units.map((x) => `${x.x},${x.y}`);
    expect(new Set(tiles).size).toBe(tiles.length);
  });

  it('残り AP はただの待機(回復しない)で埋まり、全員休憩は休憩で埋まる', () => {
    const plan: Action[] = [...moves('E', 2), { type: 'attack', target: 'g1' }];
    const idle = { type: 'wait', idle: true };
    expect(fillPlan(plan).slice(3)).toEqual([idle, idle, idle]);
    expect(plan).toHaveLength(3);
    expect(fillPlan([]).every((a) => a.type === 'wait' && a.idle)).toBe(true);
    expect(fillPlan([], 'rest').every((a) => a.type === 'wait' && !a.idle)).toBe(true);
  });

  it('同じ体格以上の敵のマスは通り抜けられず、敵とのすれ違いもできない', () => {
    const s = game([mk('p2', 'thief', 1, 1), mk('g1', 'goblin', 2, 1)]);
    const r = resolveTurn(s, { p2: moves('E', 3) });
    expect(u(r.state, 'p2')).toMatchObject({ x: 1, y: 1 });
    // 重装の戦士でも、相手が向かってくる(すれ違い)ときや同じ体格のオークは押せない
    const s2 = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 1)]);
    const r2 = resolveTurn(s2, { p1: moves('E', 1), g1: moves('W', 1) });
    expect(u(r2.state, 'p1')).toMatchObject({ x: 1, y: 1 });
    expect(u(r2.state, 'g1')).toMatchObject({ x: 2, y: 1 });
    const s3 = game([mk('p1', 'warrior', 1, 1), mk('o1', 'orc', 2, 1)]);
    const r3 = resolveTurn(s3, { p1: moves('E', 2) });
    expect(u(r3.state, 'p1')).toMatchObject({ x: 1, y: 1 });
  });

  it('重装の戦士は小型の敵を 1 マス後ろへ押し返して前進できる(直後の 1 ティックは踏ん張りで残りが遅れる、壁際は押せない)', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 1)]);
    const r = resolveTurn(s, { p1: moves('E', 1) });
    expect(u(r.state, 'p1')).toMatchObject({ x: 2, y: 1 });
    expect(u(r.state, 'g1')).toMatchObject({ x: 3, y: 1 });
    expect(r.events.some((e) => e.type === 'push' && e.id === 'p1' && e.target === 'g1')).toBe(true);
    // 2 歩目は消えずに 1 ティック遅れて、t3 にもう一度押す
    const r2 = resolveTurn(s, { p1: moves('E', 2) });
    expect(u(r2.state, 'p1')).toMatchObject({ x: 3, y: 1 });
    expect(u(r2.state, 'g1')).toMatchObject({ x: 4, y: 1 });
    expect(r2.events.filter((e) => e.type === 'push').map((e) => e.tick)).toEqual([1, 3]);
    expect(r2.events.some((e) => e.type === 'move' && e.id === 'p1' && e.tick === 2)).toBe(false);
    // 敵の後ろが壁なら押せない
    const wall = game([mk('p1', 'warrior', 9, 1), mk('g1', 'goblin', 10, 1)]);
    const rw = resolveTurn(wall, { p1: moves('E', 1) });
    expect(u(rw.state, 'p1')).toMatchObject({ x: 9, y: 1 });
    expect(u(rw.state, 'g1')).toMatchObject({ x: 10, y: 1 });
  });

  it('押し返しの踏ん張りは、移動以外の行動が続いても 1 ティック遅らせる(曲がる経路も予定の道をたどる)', () => {
    // 押す → 北へ曲がる: 曲がる 1 歩は消えずに t3 に進む
    const s = game([mk('p1', 'warrior', 1, 2), mk('g1', 'goblin', 2, 2)]);
    const r = resolveTurn(s, { p1: [...moves('E', 1), ...moves('N', 1)] });
    expect(u(r.state, 'p1')).toMatchObject({ x: 2, y: 1 });
    expect(r.events.some((e) => e.type === 'move' && e.id === 'p1' && e.tick === 3)).toBe(true);
    // 押す → 攻撃: 攻撃も 1 ティック遅れて発動する(押す → 防御 → 移動で踏ん張りを踏み倒せない)
    const s2 = game([mk('p1', 'warrior', 1, 2), mk('g1', 'goblin', 2, 2)]);
    const r2 = resolveTurn(s2, { p1: [...moves('E', 1), { type: 'attack', target: 'g1' }] });
    const hit = r2.events.find((e) => e.type === 'damage' && e.by === 'p1');
    expect(hit?.tick).toBe(1 + 1 + RULES.attackCost);
  });

  it('1 マスの通路で後ろの敵が前へ動いたティックには、押せないはずの敵を押さない', () => {
    const corridor = ['#######', '#.....#', '#######'];
    for (let seed = 1; seed <= 20; seed++) {
      // 戦士 p1 が東へ踏み込み、g1 はその場、後ろの g2 は西へ(g1 のマス)動こうとする
      const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 1), mk('g2', 'goblin', 3, 1)], corridor, seed);
      const r = resolveTurn(s, { p1: moves('E', 1), g1: [{ type: 'guard' }], g2: moves('W', 1) });
      expect(r.events.some((e) => e.type === 'push')).toBe(false);
      expect(u(r.state, 'p1')).toMatchObject({ x: 1, y: 1 });
      expect(u(r.state, 'g1')).toMatchObject({ x: 2, y: 1 });
      expect(u(r.state, 'g2')).toMatchObject({ x: 3, y: 1 });
    }
  });

  it('大型の敵の接近攻撃は、押し返せる味方を通れるものとして進む', () => {
    // 1 マスの通路で、オーガ b1 が戦士 p1 の奥の魔法使い p3 を狙う。戦士を押し返して進む
    const corridor = ['########', '#......#', '########'];
    const s = game([mk('b1', 'ogre', 1, 1), mk('p1', 'warrior', 3, 1), mk('p3', 'mage', 6, 1)], corridor);
    const r = resolveTurn(s, { b1: [{ type: 'charge', target: 'p3', ticks: 8 }] });
    expect(r.events.some((e) => e.type === 'push' && e.id === 'b1' && e.target === 'p1')).toBe(true);
  });

  it('止まるマスが重ならない(多数のランダムな移動)', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const units = [mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 2, 1), mk('p3', 'mage', 3, 1), mk('g1', 'goblin', 4, 2), mk('g2', 'goblin', 5, 3)];
      const s = game(units, OPEN, seed);
      const dirs = ['N', 'E', 'S', 'W'] as const;
      const plans: Record<string, Action[]> = {};
      let r = seed;
      for (const x of units) plans[x.id] = Array.from({ length: 8 }, () => ({ type: 'move', dir: dirs[(r = (r * 1103515245 + 12345) & 0x7fffffff) % 4] }));
      const res = resolveTurn(s, plans);
      const tiles = res.state.units.map((x) => `${x.x},${x.y}`);
      expect(new Set(tiles).size).toBe(tiles.length);
    }
  });

  it('前のユニットが動けば後ろも続いて動ける', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 2, 1)]);
    const r = resolveTurn(s, { p1: moves('E', 2), p2: moves('E', 2) });
    expect(u(r.state, 'p1').x).toBe(3);
    expect(u(r.state, 'p2').x).toBe(4);
  });
});

describe('攻撃', () => {
  it('近接攻撃は隣接していれば当たる', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 1)]);
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: 'g1' }] });
    expect(u(r.state, 'g1').hp).toBeLessThan(MONSTERS.goblin.maxHp);
  });

  it('近接攻撃は斜めの隣にも届く', () => {
    const s = game([mk('p1', 'warrior', 2, 2), mk('g1', 'goblin', 3, 3)]);
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: 'g1' }] });
    expect(u(r.state, 'g1').hp).toBeLessThan(MONSTERS.goblin.maxHp);
  });

  it('壁の角の隙間越し(間の 2 マスがどちらも壁)の斜めには届かない', () => {
    const rows = ['#####', '#.#.#', '##.##', '#...#', '#####'];
    // (1,1) と (2,2) の間は (2,1)・(1,2) とも壁
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 2)], rows);
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: 'g1' }] });
    expect(u(r.state, 'g1').hp).toBe(MONSTERS.goblin.maxHp);
    expect(r.events.some((e) => e.type === 'fizzle' && e.id === 'p1')).toBe(true);
  });

  it('移動は上下左右だけで、斜めの敵には隣接マスまで回り込まずに攻撃できる', async () => {
    const { pathAdjacent } = await import('../src/core/path');
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 4, 3)]);
    // (1,1) → (3,2) まで 3 歩で斜め隣に着く
    expect(pathAdjacent(s.map, u(s, 'p1'), u(s, 'g1'))).toHaveLength(3);
  });

  it('構えている間に相手が離れると不発になる(ユニット狙い)', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 1)]);
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: 'g1' }], g1: moves('E', 2) });
    expect(u(r.state, 'g1').hp).toBe(MONSTERS.goblin.maxHp);
    expect(r.events.some((e) => e.type === 'fizzle' && e.id === 'p1')).toBe(true);
  });

  it('防御中は被ダメージが半減する', () => {
    const base = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 1)], OPEN, 7);
    const hit = resolveTurn(base, { p1: [{ type: 'attack', target: 'g1' }] });
    const guarded = resolveTurn(base, { p1: [{ type: 'attack', target: 'g1' }], g1: [{ type: 'guard' }, { type: 'guard' }, { type: 'guard' }] });
    const dmg = (r: typeof hit) => r.events.find((e) => e.type === 'damage')!;
    const d1 = dmg(hit);
    const d2 = dmg(guarded);
    expect(d2.type === 'damage' && d2.guarded).toBe(true);
    if (d1.type === 'damage' && d2.type === 'damage') expect(d2.amount).toBe(Math.ceil(d1.amount / 2));
  });

  it('相打ちが起こる', () => {
    const w = mk('p1', 'warrior', 1, 1);
    const g = mk('g1', 'goblin', 2, 1);
    w.hp = 1;
    g.hp = 1;
    const r = resolveTurn(game([w, g]), { p1: [{ type: 'attack', target: 'g1' }], g1: [{ type: 'attack', target: 'p1' }] });
    expect(u(r.state, 'p1').down).toBe(true);
    expect(u(r.state, 'g1').down).toBe(true);
    expect(r.state.status).toBe('lost');
  });

  it('撃つ瞬間に味方が射線上にいれば撃たない(AP は消費する)', () => {
    const s = game([mk('p2', 'thief', 1, 1), mk('p1', 'warrior', 3, 1), mk('g1', 'goblin', 6, 1)]);
    const r = resolveTurn(s, { p2: [{ type: 'attack', target: 'g1' }] });
    expect(u(r.state, 'p1').hp).toBe(CLASSES.warrior.maxHp);
    expect(u(r.state, 'g1').hp).toBe(MONSTERS.goblin.maxHp);
    expect(r.events.some((e) => e.type === 'fizzle' && e.id === 'p2' && e.reason === '味方が射線上にいる')).toBe(true);
  });

  it('矢は射線上で最初に当たった敵に命中する', () => {
    const s = game([mk('p2', 'thief', 1, 1), mk('g2', 'goblin', 3, 1), mk('g1', 'goblin', 6, 1)]);
    const r = resolveTurn(s, { p2: [{ type: 'attack', target: 'g1' }] });
    expect(u(r.state, 'g2').hp).toBeLessThan(MONSTERS.goblin.maxHp);
    expect(u(r.state, 'g1').hp).toBe(MONSTERS.goblin.maxHp);
  });

  it('旧ルール(holdFireOnAlly=false)では味方に当たる', () => {
    RULES.holdFireOnAlly = false;
    try {
      const s = game([mk('p2', 'thief', 1, 1), mk('p1', 'warrior', 3, 1), mk('g1', 'goblin', 6, 1)]);
      const r = resolveTurn(s, { p2: [{ type: 'attack', target: 'g1' }] });
      // (予約のない戦士はターンの終わりに休憩で回復するので、HP ではなくダメージで確かめる)
      expect(r.events.some((e) => e.type === 'damage' && e.id === 'p1')).toBe(true);
    } finally {
      RULES.holdFireOnAlly = true;
    }
  });

  it('火球はマスを狙い、範囲内の味方も巻き込む', () => {
    const s = game([mk('p3', 'mage', 1, 3), mk('p1', 'warrior', 5, 3), mk('g1', 'goblin', 6, 3)]);
    // 残りの AP は防御で埋める(休憩すると MP が回復してしまう)
    const r = resolveTurn(s, { p3: fillPlan([{ type: 'spell', spell: 'fireball', tile: { x: 6, y: 3 } }], 'guard') });
    expect(u(r.state, 'g1').hp).toBeLessThan(MONSTERS.goblin.maxHp);
    expect(r.events.some((e) => e.type === 'damage' && e.id === 'p1')).toBe(true);
    expect(u(r.state, 'p3').mp).toBe(CLASSES.mage.maxMp - SPELLS.fireball.mp);
  });

  it('火球は相手が動けば外れる(マス狙い)', () => {
    const s = game([mk('p3', 'mage', 1, 3), mk('g1', 'goblin', 6, 3)]);
    const r = resolveTurn(s, { p3: [{ type: 'spell', spell: 'fireball', tile: { x: 6, y: 3 } }], g1: moves('E', 3) });
    expect(u(r.state, 'g1').hp).toBe(MONSTERS.goblin.maxHp);
  });

  it('僧侶は気絶した味方を蘇生できる', () => {
    const w = mk('p1', 'warrior', 2, 1);
    w.hp = 0;
    w.down = true;
    const r = resolveTurn(game([w, mk('p4', 'priest', 1, 1), mk('g1', 'goblin', 9, 5)]), {
      p4: [{ type: 'spell', spell: 'revive', target: 'p1' }],
    });
    expect(u(r.state, 'p1').down).toBe(false);
    expect(u(r.state, 'p1').hp).toBeGreaterThan(0);
  });

  it('接近攻撃は離れた敵に近づいて攻撃し、AP が残れば続けて攻撃する', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 4, 1)]);
    const r = resolveTurn(s, { p1: [{ type: 'charge', target: 'g1', ticks: 8 }] });
    // 2 マス進んで隣接(2 ティック)→ 構え 2 + 攻撃 → 構え 2 + 攻撃 = 8 ティックで 2 回
    expect(u(r.state, 'p1')).toMatchObject({ x: 3, y: 1 });
    expect(r.events.filter((e) => e.type === 'strike' && e.id === 'p1')).toHaveLength(2);
  });

  it('接近攻撃は逃げる相手を追いかけ、届くまで構えない', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 3, 1)]);
    const r = resolveTurn(s, { p1: [{ type: 'charge', target: 'g1', ticks: 8 }], g1: moves('E', 4) });
    expect(r.events.some((e) => e.type === 'fizzle' && e.id === 'p1')).toBe(false);
    expect(u(r.state, 'p1').x).toBeGreaterThan(1);
  });

  it('接近攻撃は味方に囲まれていても通り抜けて近づく', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 2, 1), mk('p3', 'mage', 1, 2), mk('g1', 'goblin', 6, 1)]);
    const r = resolveTurn(s, { p1: [{ type: 'charge', target: 'g1', ticks: 8 }] });
    expect(u(r.state, 'p1')).toMatchObject({ x: 5, y: 1 });
    expect(r.events.some((e) => e.type === 'strike' && e.id === 'p1')).toBe(true);
  });

  it('遠隔の接近攻撃は味方越しには撃たず、射線が空く位置へ動く', () => {
    const s = game([mk('p2', 'thief', 1, 1), mk('p1', 'warrior', 3, 1), mk('g1', 'goblin', 6, 1)]);
    const r = resolveTurn(s, { p2: [{ type: 'charge', target: 'g1', ticks: 8 }] });
    expect(u(r.state, 'p1').hp).toBe(CLASSES.warrior.maxHp);
    expect(u(r.state, 'g1').hp).toBeLessThan(MONSTERS.goblin.maxHp);
  });

  it('遠隔の接近攻撃は射線が通る位置まで寄って撃つ', () => {
    const s = game([mk('p2', 'thief', 1, 1), mk('g1', 'goblin', 10, 5)], ['############', '#..........#', '#..........#', '#..........#', '#..........#', '#..........#', '############']);
    const r = resolveTurn(s, { p2: [{ type: 'charge', target: 'g1', ticks: 8 }] });
    expect(r.events.some((e) => e.type === 'strike' && e.id === 'p2')).toBe(true);
  });
});

describe('敵 AI', () => {
  it('パーティを見た敵は、近くの仲間を呼ぶ', () => {
    const rows = ['##############', '#......#.....#', '#......#.....#', '#............#', '##############'];
    const g2 = mk('g2', 'goblin', 10, 1);
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 5, 1), g2], rows);
    const r = resolveTurn(s, {});
    expect(u(r.state, 'g1').ai?.alerted).toBe(true);
    expect(u(r.state, 'g2').ai).toMatchObject({ alerted: true, lastSeen: { x: 1, y: 1 } });
  });

  it('弓兵は仲間越しには撃たない(計画時点で射線上にいる仲間を避ける)', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 3, 1), mk('a1', 'archer', 5, 1)]);
    for (let t = 1; t <= 10; t++) {
      // 仲間のゴブリンは動かない(撃つ途中で射線に入ってくる場合は、同時解決の結果として起こりうる)
      const plans = { ...planEnemies({ ...s, turn: t }), g1: [] };
      const r = resolveTurn({ ...s, turn: t }, plans);
      expect(r.events.some((e) => e.type === 'damage' && e.by === 'a1' && e.id === 'g1')).toBe(false);
    }
  });

  it('弱った敵は下がるか守りを固める(何度か試して、少なくとも一度は下がる)', () => {
    let retreated = false;
    for (let t = 1; t <= 12 && !retreated; t++) {
      const g = mk('g1', 'goblin', 3, 1);
      g.hp = 3;
      const s = { ...game([mk('p1', 'warrior', 1, 1), g]), turn: t };
      const r = resolveTurn(s, planEnemies(s));
      if (u(r.state, 'g1').x > 3) retreated = true;
    }
    expect(retreated).toBe(true);
  });
});

describe('担ぐ・泉', () => {
  const downed = (id: string, defId: string, x: number, y: number) => {
    const d = mk(id, defId, x, y);
    d.hp = 0;
    d.down = true;
    return d;
  };

  it('気絶した味方を担いで運び、降ろせる。担いでいる間の移動は 1 マス 2 AP', () => {
    const s = game([mk('p1', 'warrior', 1, 1), downed('p3', 'mage', 2, 1)]);
    const slow: Action = { type: 'move', dir: 'E', slow: true };
    const r = resolveTurn(s, { p1: [{ type: 'carry', target: 'p3' }, slow, slow, { type: 'drop' }] });
    expect(u(r.state, 'p1')).toMatchObject({ x: 3, y: 1 });
    expect(u(r.state, 'p3')).toMatchObject({ x: 3, y: 1, down: true });
    expect(u(r.state, 'p1').carrying).toBeUndefined();
  });

  it('担がれたまま 3 ターン目以降は、ターンの終わりに 50% で意識を取り戻す', () => {
    const results: number[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      let s = game([mk('p1', 'warrior', 1, 1), downed('p3', 'mage', 2, 1)], OPEN, seed);
      s = resolveTurn(s, { p1: [{ type: 'carry', target: 'p3' }] }).state;
      let woke = 0;
      for (let t = 2; t <= 12 && !woke; t++) {
        const r = resolveTurn(s, {});
        if (r.events.some((e) => e.type === 'wake')) woke = t;
        s = r.state;
      }
      results.push(woke);
      if (woke) {
        expect(u(s, 'p3')).toMatchObject({ down: false, hp: RULES.carryWakeHp });
        expect(u(s, 'p1').carrying).toBeUndefined();
        expect(`${u(s, 'p3').x},${u(s, 'p3').y}`).not.toBe(`${u(s, 'p1').x},${u(s, 'p1').y}`);
      }
    }
    // 1・2 ターン目には起きない。3 ターン目にはおよそ半分が起きる
    expect(results.every((t) => t === 0 || t >= 3)).toBe(true);
    const third = results.filter((t) => t === 3).length;
    expect(third).toBeGreaterThan(8);
    expect(third).toBeLessThan(32);
  });

  it('降ろすと、担がれた回数は数え直しになる', () => {
    let s = game([mk('p1', 'warrior', 1, 1), downed('p3', 'mage', 2, 1)]);
    s = resolveTurn(s, { p1: [{ type: 'carry', target: 'p3' }] }).state;
    s = resolveTurn(s, {}).state;
    expect(u(s, 'p3').carriedTurns).toBe(2);
    s = resolveTurn(s, { p1: [{ type: 'drop' }] }).state;
    expect(u(s, 'p3').carriedTurns).toBeUndefined();
  });

  it('担いでいる者が倒れたら、その場に落とす', () => {
    const p1 = mk('p1', 'warrior', 1, 1);
    p1.hp = 1;
    const s = game([p1, downed('p3', 'mage', 2, 1), mk('g1', 'goblin', 1, 2)]);
    const r = resolveTurn(s, { p1: [{ type: 'carry', target: 'p3' }], g1: [{ type: 'attack', target: 'p1' }] });
    expect(u(r.state, 'p1').down).toBe(true);
    expect(u(r.state, 'p1').carrying).toBeUndefined();
    expect(r.events.some((e) => e.type === 'drop')).toBe(true);
  });

  it('担いだまま攻撃は予約できない', () => {
    const p1 = mk('p1', 'warrior', 1, 1);
    expect(canAppend(p1, [{ type: 'carry', target: 'p3' }], { type: 'attack', target: 'g1' })).not.toBeNull();
    expect(canAppend(p1, [{ type: 'carry', target: 'p3' }, { type: 'drop' }], { type: 'attack', target: 'g1' })).toBeNull();
  });

  it('泉のマスでターンを終えると気絶から復帰し、全回復する', () => {
    const rows = ['#######', '#..H..#', '#######'];
    const p1 = mk('p1', 'warrior', 1, 1);
    p1.hp = 5;
    const s = game([p1, downed('p3', 'mage', 2, 1)], rows);
    const slow: Action = { type: 'move', dir: 'E', slow: true };
    const r = resolveTurn(s, { p1: [{ type: 'carry', target: 'p3' }, slow, slow] });
    // p1 は (3,1) の泉に立ち、担がれた p3 も同じマス → 両方回復し、p3 は隣の空きマスに立つ
    expect(u(r.state, 'p1').hp).toBe(CLASSES.warrior.maxHp);
    expect(u(r.state, 'p3')).toMatchObject({ down: false, hp: CLASSES.mage.maxHp });
    expect(`${u(r.state, 'p3').x},${u(r.state, 'p3').y}`).not.toBe('3,1');
  });
});

describe('条件付き行動', () => {
  it('警戒射撃は射程に入った敵を撃つ', () => {
    const s = game([mk('p2', 'thief', 1, 3), mk('g1', 'goblin', 10, 3)]);
    const r = resolveTurn(s, { p2: [{ type: 'overwatch', ticks: 8 }], g1: moves('W', 6) });
    expect(r.events.some((e) => e.type === 'strike' && e.id === 'p2' && e.reaction)).toBe(true);
    expect(u(r.state, 'g1').hp).toBeLessThan(MONSTERS.goblin.maxHp);
  });

  it('警戒射撃は味方越しには撃たない', () => {
    const s = game([mk('p2', 'thief', 1, 3), mk('p1', 'warrior', 3, 3), mk('g1', 'goblin', 6, 3)]);
    const r = resolveTurn(s, { p2: [{ type: 'overwatch', ticks: 8 }], g1: [{ type: 'wait' }, ...moves('W', 1)] });
    expect(r.events.some((e) => e.type === 'strike' && e.id === 'p2')).toBe(false);
    expect(u(r.state, 'p1').hp).toBe(CLASSES.warrior.maxHp);
  });

  it('警戒射撃は動かない敵には反応しない', () => {
    const s = game([mk('p2', 'thief', 1, 3), mk('g1', 'goblin', 4, 3)]);
    const r = resolveTurn(s, { p2: [{ type: 'overwatch', ticks: 8 }] });
    expect(r.events.some((e) => e.type === 'strike')).toBe(false);
  });

  it('迎撃は隣で動かない敵を、通常の攻撃と同じく溜めてから攻撃する', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g2', 'goblin', 2, 1)]);
    const r = resolveTurn(s, { p1: [{ type: 'intercept', ticks: 8 }] });
    const ticks = r.events.filter((e) => e.type === 'strike' && e.id === 'p1').map((e) => e.tick);
    // 3 ティックごとに 1 回(8 ティックで 2 回。残り 2 ティックでは足りない)
    expect(ticks).toEqual([RULES.attackCost, RULES.attackCost * 2]);
  });

  it('迎撃は残りの AP が攻撃のコストに足りなければ動かない敵を攻撃しない', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g2', 'goblin', 2, 1)]);
    const r = resolveTurn(s, { p1: [...Array(8 - (RULES.attackCost - 1)).fill({ type: 'wait' }), { type: 'intercept', ticks: RULES.attackCost - 1 }] });
    expect(r.events.some((e) => e.type === 'strike' && e.id === 'p1')).toBe(false);
  });

  it('迎撃は隣に来た敵に即座に反応し、その後も隣に居続ければ溜めて攻撃する', () => {
    const s = game([mk('p1', 'warrior', 1, 3), mk('g1', 'goblin', 3, 3)]);
    const r = resolveTurn(s, { p1: [{ type: 'intercept', ticks: 8 }], g1: [...moves('W', 1), { type: 'guard' }, { type: 'guard' }, { type: 'guard' }] });
    const ticks = r.events.filter((e) => e.type === 'strike' && e.id === 'p1').map((e) => e.tick);
    // 1: 即座に反応 → 2: 休み → 3〜5: 溜めて攻撃 → 6〜8: 溜めて攻撃
    expect(ticks).toEqual([1, 5, 8]);
  });

  it('迎撃は隣の敵からランダムに狙う', () => {
    const targets = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const s = game([mk('p1', 'warrior', 3, 3), mk('g1', 'goblin', 2, 3), mk('g2', 'goblin', 4, 3)], OPEN, seed);
      // 敵は防御し続ける(最初の溜めの狙いだけを見る)
      const r = resolveTurn(s, { p1: [{ type: 'intercept', ticks: 8 }], g1: Array(8).fill({ type: 'guard' }), g2: Array(8).fill({ type: 'guard' }) });
      const first = r.events.find((e) => e.type === 'strike' && e.id === 'p1');
      if (first && first.type === 'strike' && first.target) targets.add(first.target);
    }
    expect(targets).toEqual(new Set(['g1', 'g2']));
  });

  it('迎撃は隣接してきた敵を攻撃する', () => {
    const s = game([mk('p1', 'warrior', 1, 3), mk('g1', 'goblin', 5, 3)]);
    const r = resolveTurn(s, { p1: [{ type: 'intercept', ticks: 8 }], g1: moves('W', 3) });
    expect(r.events.some((e) => e.type === 'strike' && e.id === 'p1' && e.reaction)).toBe(true);
  });

  it('迎撃は斜めに隣接してきた敵も攻撃する', () => {
    const s = game([mk('p1', 'warrior', 3, 3), mk('g1', 'goblin', 6, 2)]);
    // g1 は (4,2) まで来る(p1 の斜め隣)
    const r = resolveTurn(s, { p1: [{ type: 'intercept', ticks: 8 }], g1: [...moves('W', 2), { type: 'guard' }] });
    expect(r.events.some((e) => e.type === 'strike' && e.id === 'p1' && e.reaction)).toBe(true);
  });

  it('敵を見たら停止すると、残りの移動が防御になる', () => {
    const rows = [
      '##############',
      '#......#.....#',
      '#............#',
      '#......#.....#',
      '##############',
    ];
    // (7,2) の切れ目越しにしか見えない位置にゴブリンを置く
    const s = game([mk('p1', 'warrior', 1, 2), mk('g1', 'goblin', 11, 1)], rows);
    const plan: Action[] = moves('E', 6).map((a) => ({ ...a, stop: true }) as Action);
    const r = resolveTurn(s, { p1: plan });
    expect(r.events.some((e) => e.type === 'halt')).toBe(true);
    expect(u(r.state, 'p1').x).toBeLessThan(7);
  });
});

describe('休憩', () => {
  const rows = [
    '##############',
    '#.....#......#',
    '#.....#......#',
    '##############',
  ];
  const rest = fillPlan([], 'rest');
  it('敵が見えない状態で休憩を予約すると HP と MP が回復する。余った AP の待機・予約なしでは回復しない', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.hp = 5;
    m.mp = 0;
    const r = resolveTurn(game([m, mk('g1', 'goblin', 10, 1)], rows), { p3: rest });
    expect(u(r.state, 'p3').hp).toBeGreaterThan(5);
    expect(u(r.state, 'p3').mp).toBeGreaterThan(0);
    for (const plans of [{}, { p3: fillPlan([]) }] as Plans[]) {
      const n = resolveTurn(game([{ ...m }, mk('g1', 'goblin', 10, 1)], rows), plans);
      expect(u(n.state, 'p3').hp).toBe(5);
      expect(n.state.items?.food).toBe(99);
    }
  });

  it('倒れた敵が見えていても休憩できる', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.hp = 5;
    const g = mk('g1', 'goblin', 3, 1);
    g.down = true;
    g.hp = 0;
    const r = resolveTurn(game([m, g], rows), { p3: rest });
    expect(u(r.state, 'p3').hp).toBeGreaterThan(5);
  });

  it('休憩はキャラごと。待ったティック数に応じて回復する', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.hp = 5;
    const w = mk('p1', 'warrior', 2, 2);
    w.hp = 10;
    const w2 = mk('p4', 'priest', 1, 2);
    w2.hp = 10;
    // 魔法使いは 8 ティック休憩、戦士は 4 マス動いて 4 ティック休憩、僧侶は 8 マス往復で休憩なし
    const r = resolveTurn(game([m, w, w2, mk('g1', 'goblin', 12, 1)], rows), {
      p3: rest,
      p1: fillPlan(moves('E', 4), 'rest'),
      p4: [...moves('E', 4), ...moves('W', 4)],
    });
    const full = Math.round(CLASSES.mage.maxHp * RULES.restHpRatio);
    expect(u(r.state, 'p3').hp).toBe(5 + full);
    expect(u(r.state, 'p1').hp).toBe(10 + Math.round(CLASSES.warrior.maxHp * RULES.restHpRatio * 0.5));
    expect(u(r.state, 'p4').hp).toBe(10);
  });

  it('敵が見えていても休憩すれば回復する(回復量は戦闘中の倍率を掛けたもの)', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.hp = 5;
    const g = Array(8).fill({ type: 'guard' });
    const r = resolveTurn(game([m, mk('g1', 'goblin', 4, 1)], rows), { g1: g, p3: rest });
    expect(u(r.state, 'p3').hp).toBe(5 + Math.round(CLASSES.mage.maxHp * RULES.restHpRatio * RULES.combatRestRatio));
  });

  it('休憩中は被ダメージが減らず、ダメージを受けても回復はする', () => {
    const w = mk('p1', 'warrior', 1, 1);
    w.hp = 30;
    // ゴブリンは隣から 2 回攻撃する(攻撃の振れ幅があるので、休憩なしの結果と比べる)
    const atk = [{ type: 'attack', target: 'p1' } as const, { type: 'attack', target: 'p1' } as const];
    const rest = resolveTurn(game([w, mk('g1', 'goblin', 2, 1)], rows), { g1: atk, p1: Array(8).fill({ type: 'wait' }) });
    const guard = resolveTurn(game([w, mk('g1', 'goblin', 2, 1)], rows), { g1: atk, p1: Array(8).fill({ type: 'guard' }) });
    const dmg = (r: typeof rest) => r.events.filter((e) => e.type === 'damage' && e.id === 'p1');
    expect(dmg(rest).every((e) => e.type === 'damage' && !e.guarded)).toBe(true);
    expect(dmg(guard).every((e) => e.type === 'damage' && e.guarded)).toBe(true);
    const taken = dmg(rest).reduce((s, e) => s + (e.type === 'damage' ? e.amount : 0), 0);
    expect(u(rest.state, 'p1').hp).toBe(30 - taken + Math.round(CLASSES.warrior.maxHp * RULES.restHpRatio * RULES.combatRestRatio));
  });
});

describe('敵 AI', () => {
  it('巡回する敵は巡回点の間を往復する', () => {
    const o = mk('o1', 'orc', 1, 1);
    o.ai = { mode: 'patrol', patrol: [{ x: 1, y: 1 }, { x: 10, y: 5 }], patrolIndex: 1 };
    let s = game([o, mk('p1', 'warrior', 10, 5)]);
    // パーティを見えない位置へ(視界外)置くため壁で区切った地図にはせず、戦士を倒れた状態にする
    s.units[1].down = true;
    s.units[1].hp = 0;
    const xs: number[] = [];
    for (let i = 0; i < 4; i++) {
      s = resolveTurn(s, planEnemies(s)).state;
      xs.push(u(s, 'o1').x + u(s, 'o1').y * 100);
    }
    // 1 ターン目で (10,5) 付近へ到達し、その後 (1,1) へ戻る
    expect(xs[1]).toBe(10 + 5 * 100);
    expect(xs[3]).toBe(1 + 1 * 100);
  });
});

describe('決定性', () => {
  it('同じ状態と同じ計画からは同じ結果になる', () => {
    const s = createTestGame(42);
    const plans = { ...planEnemies(s), p1: moves('E', 4), p2: [{ type: 'overwatch', ticks: 8 } as Action] };
    const a = resolveTurn(s, plans);
    const b = resolveTurn(s, plans);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('resolveTurn は入力の状態を書き換えない', () => {
    const s = createTestGame(3);
    const before = JSON.stringify(s);
    resolveTurn(s, { ...planEnemies(s), p1: moves('E', 3) });
    planEnemies(s);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('数十ターン進めても例外が出ない', () => {
    let s = createTestGame(5);
    for (let i = 0; i < 40 && s.status === 'playing'; i++) {
      s = resolveTurn(s, { ...planEnemies(s), p1: moves(i % 2 ? 'E' : 'N', 4) }).state;
    }
    expect(s.turn).toBeGreaterThan(1);
  });
});

describe('ドラゴン', () => {
  it('眠っている間は何もせず、仲間に呼ばれても起きない', () => {
    const d = mk('d1', 'dragon', 9, 3);
    d.ai = { mode: 'idle', asleep: true };
    const g = mk('g1', 'goblin', 6, 3);
    // 戦士はドラゴンから 6 マス、ゴブリンからは見える距離
    const s = game([mk('p1', 'warrior', 3, 3), g, d]);
    const plans = planEnemies(s);
    expect(plans.d1.every((a) => a.type === 'wait')).toBe(true);
    const r = resolveTurn(s, { ...plans, p1: [] });
    expect(u(r.state, 'd1').ai?.asleep).toBe(true);
    expect(u(r.state, 'g1').ai?.alerted).toBe(true);
  });

  it('近く(3 マス以内)で姿を見ると目を覚ます', () => {
    const d = mk('d1', 'dragon', 9, 3);
    d.ai = { mode: 'idle', asleep: true };
    const r = resolveTurn(game([mk('p1', 'warrior', 5, 3), d]), { p1: moves('E', 1), d1: [] });
    expect(u(r.state, 'd1').ai?.asleep).toBe(false);
    expect(r.events.some((e) => e.type === 'awaken' && e.id === 'd1')).toBe(true);
  });

  it('攻撃されると目を覚ます', () => {
    const d = mk('d1', 'dragon', 9, 3);
    d.ai = { mode: 'idle', asleep: true };
    const r = resolveTurn(game([mk('p2', 'thief', 4, 3), d]), { p2: [{ type: 'attack', target: 'd1' }], d1: [] });
    expect(u(r.state, 'd1').ai?.asleep).toBe(false);
  });

  it('起きていれば炎のブレスを吐き、次のターンは吐かない', () => {
    const s = game([mk('p1', 'warrior', 4, 3), mk('p3', 'mage', 4, 4), mk('d1', 'dragon', 7, 3)]);
    const plan = planEnemies(s).d1;
    const breath = plan.find((a) => a.type === 'spell' && a.spell === 'breath');
    expect(breath).toBeTruthy();
    const r = resolveTurn(s, { d1: plan });
    expect(r.events.some((e) => e.type === 'strike' && e.kind === 'breath')).toBe(true);
    // 巻き込まれた味方がダメージを受ける
    expect(r.events.filter((e) => e.type === 'damage' && e.by === 'd1').length).toBeGreaterThan(0);
    expect(u(r.state, 'd1').ai?.breathTurn).toBe(1);
    const next = planEnemies(r.state).d1;
    expect(next.some((a) => a.type === 'spell')).toBe(false);
    expect(SPELLS.breath.radius).toBe(1);
  });

  it('仲間の敵を巻き込むマスにはブレスを吐かない', () => {
    const s = game([mk('p1', 'warrior', 4, 3), mk('g1', 'goblin', 5, 3), mk('d1', 'dragon', 7, 3)]);
    const plan = planEnemies(s).d1;
    expect(plan.some((a) => a.type === 'spell')).toBe(false);
  });
});

describe('クイック移動', () => {
  it('先頭が行き先へ向かい、残りは隊列でついていく(全員「発見で停止」付き)', async () => {
    const { quickMovePlans } = await import('../src/core/quickmove');
    const s = game([mk('p1', 'warrior', 3, 3), mk('p2', 'thief', 2, 3), mk('p3', 'mage', 1, 3), mk('p4', 'priest', 1, 4)]);
    const plans = quickMovePlans(s, 'p1', { x: 10, y: 3 })!;
    expect(plans.p1).toHaveLength(7);
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(plans[id].every((a) => a.type === 'move' && a.stop)).toBe(true);
    const r = resolveTurn(s, plans);
    expect(u(r.state, 'p1')).toMatchObject({ x: 10, y: 3 });
    // 全員が東へ進み、重ならずに止まる
    const cells = ['p1', 'p2', 'p3', 'p4'].map((id) => `${u(r.state, id).x},${u(r.state, id).y}`);
    expect(new Set(cells).size).toBe(4);
    expect(u(r.state, 'p4').x).toBeGreaterThan(1);
    // 着いていれば null
    expect(quickMovePlans(r.state, 'p1', { x: 10, y: 3 })).toBeNull();
  });

  it('隊列の順を指定すると、その順で後ろに並ぶ', async () => {
    const { quickMovePlans } = await import('../src/core/quickmove');
    const s = game([mk('p1', 'warrior', 3, 3), mk('p2', 'thief', 2, 3), mk('p3', 'mage', 1, 3), mk('p4', 'priest', 1, 4)]);
    // 近い順なら p2 → p3 → p4。指定で p4 → p3 → p2 にする(先頭 p1 は order に入っていても先頭のまま)
    const plans = quickMovePlans(s, 'p1', { x: 10, y: 3 }, ['p1', 'p4', 'p3', 'p2'])!;
    const r = resolveTurn(s, plans);
    const x = (id: string) => u(r.state, id).x;
    expect(x('p1')).toBe(10);
    expect(x('p4')).toBeGreaterThan(x('p3'));
    expect(x('p3')).toBeGreaterThan(x('p2'));
    const cells = ['p1', 'p2', 'p3', 'p4'].map((id) => `${u(r.state, id).x},${u(r.state, id).y}`);
    expect(new Set(cells).size).toBe(4);
  });
});
