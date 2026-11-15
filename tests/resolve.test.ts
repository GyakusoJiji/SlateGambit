import { describe, expect, it } from 'vitest';
import { RULES, canAppend, fillPlan } from '../src/core/actions';
import { planEnemies } from '../src/core/ai';
import { parseMap } from '../src/core/map';
import { resolveTurn } from '../src/core/resolve';
import { createTestGame } from '../src/core/scenario';
import type { Action, GameState, Unit } from '../src/core/types';
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
  return { seed, rng: seed, turn: 1, map, units, explored: new Array(map.w * map.h).fill(0), status: 'playing' };
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

  it('残り AP は待機で埋まる', () => {
    const plan: Action[] = [...moves('E', 2), { type: 'attack', target: 'g1' }];
    expect(fillPlan(plan).slice(3)).toEqual([{ type: 'wait' }, { type: 'wait' }, { type: 'wait' }]);
    expect(plan).toHaveLength(3);
    expect(fillPlan([]).every((a) => a.type === 'wait')).toBe(true);
  });

  it('敵のマスは通り抜けられず、敵とのすれ違いもできない', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 2, 1)]);
    const r = resolveTurn(s, { p1: moves('E', 3) });
    expect(u(r.state, 'p1')).toMatchObject({ x: 1, y: 1 });
    const r2 = resolveTurn(s, { p1: moves('E', 1), g1: moves('W', 1) });
    expect(u(r2.state, 'p1')).toMatchObject({ x: 1, y: 1 });
    expect(u(r2.state, 'g1')).toMatchObject({ x: 2, y: 1 });
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
      expect(u(r.state, 'p1').hp).toBeLessThan(CLASSES.warrior.maxHp);
    } finally {
      RULES.holdFireOnAlly = true;
    }
  });

  it('火球はマスを狙い、範囲内の味方も巻き込む', () => {
    const s = game([mk('p3', 'mage', 1, 3), mk('p1', 'warrior', 5, 3), mk('g1', 'goblin', 6, 3)]);
    const r = resolveTurn(s, { p3: [{ type: 'spell', spell: 'fireball', tile: { x: 6, y: 3 } }] });
    expect(u(r.state, 'g1').hp).toBeLessThan(MONSTERS.goblin.maxHp);
    expect(u(r.state, 'p1').hp).toBeLessThan(CLASSES.warrior.maxHp);
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

  it('警戒射撃・迎撃は動かない敵には反応しない', () => {
    const s = game([mk('p2', 'thief', 1, 3), mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 4, 3), mk('g2', 'goblin', 2, 1)]);
    const r = resolveTurn(s, { p2: [{ type: 'overwatch', ticks: 8 }], p1: [{ type: 'intercept', ticks: 8 }] });
    expect(r.events.some((e) => e.type === 'strike' && e.reaction)).toBe(false);
  });

  it('迎撃は隣に居続ける敵には 1 回だけ反応する(動いて来たティックのみ)', () => {
    const s = game([mk('p1', 'warrior', 1, 3), mk('g1', 'goblin', 3, 3)]);
    const r = resolveTurn(s, { p1: [{ type: 'intercept', ticks: 8 }], g1: [...moves('W', 1), { type: 'guard' }, { type: 'guard' }, { type: 'guard' }] });
    expect(r.events.filter((e) => e.type === 'strike' && e.id === 'p1')).toHaveLength(1);
  });

  it('迎撃は隣接してきた敵を攻撃する', () => {
    const s = game([mk('p1', 'warrior', 1, 3), mk('g1', 'goblin', 5, 3)]);
    const r = resolveTurn(s, { p1: [{ type: 'intercept', ticks: 8 }], g1: moves('W', 3) });
    expect(r.events.some((e) => e.type === 'strike' && e.id === 'p1' && e.reaction)).toBe(true);
  });

  it('追尾は対象に隣接するまで追いかける', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 6, 4)]);
    const r = resolveTurn(s, { p1: [{ type: 'follow', target: 'g1', ticks: 8 }] });
    const p = u(r.state, 'p1');
    expect(Math.abs(p.x - 6) + Math.abs(p.y - 4)).toBe(1);
  });

  it('護衛は味方の隣を保つ', () => {
    const s = game([mk('p4', 'priest', 1, 1), mk('p1', 'warrior', 2, 1)]);
    const r = resolveTurn(s, { p1: moves('E', 5), p4: [{ type: 'escort', target: 'p1', ticks: 8 }] });
    const a = u(r.state, 'p1');
    const b = u(r.state, 'p4');
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
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
  it('敵が見えない状態で全員が待機すると HP と MP が回復する', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.hp = 5;
    m.mp = 0;
    const r = resolveTurn(game([m, mk('g1', 'goblin', 10, 1)], rows), {});
    expect(u(r.state, 'p3').hp).toBeGreaterThan(5);
    expect(u(r.state, 'p3').mp).toBeGreaterThan(0);
  });

  it('倒れた敵が見えていても休憩できる', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.hp = 5;
    const g = mk('g1', 'goblin', 3, 1);
    g.down = true;
    g.hp = 0;
    const r = resolveTurn(game([m, g], rows), {});
    expect(u(r.state, 'p3').hp).toBeGreaterThan(5);
  });

  it('休憩はキャラごと。待ったティック数に応じて回復する', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.hp = 5;
    const w = mk('p1', 'warrior', 2, 2);
    w.hp = 10;
    const w2 = mk('p4', 'priest', 1, 2);
    w2.hp = 10;
    // 魔法使いは何も予約しない(8 ティック休憩)、戦士は 4 マス動いて残り 4 ティック休憩、僧侶は 8 マス往復で休憩なし
    const r = resolveTurn(game([m, w, w2, mk('g1', 'goblin', 12, 1)], rows), {
      p1: moves('E', 4),
      p4: [...moves('E', 4), ...moves('W', 4)],
    });
    const full = Math.round(CLASSES.mage.maxHp * RULES.restHpRatio);
    expect(u(r.state, 'p3').hp).toBe(5 + full);
    expect(u(r.state, 'p1').hp).toBe(10 + Math.round(CLASSES.warrior.maxHp * RULES.restHpRatio * 0.5));
    expect(u(r.state, 'p4').hp).toBe(10);
  });

  it('敵が見えていると休憩にならない', () => {
    const m = mk('p3', 'mage', 1, 1);
    m.hp = 5;
    const r = resolveTurn(game([m, mk('g1', 'goblin', 4, 1)], rows), {});
    expect(u(r.state, 'p3').hp).toBeLessThanOrEqual(5);
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
