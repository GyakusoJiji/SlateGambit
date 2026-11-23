// 結果と理由を伝える仕組み(届かない理由・接近攻撃の経路の目安・ターン後の要約)のテスト
import { describe, expect, it } from 'vitest';
import { parseMap } from '../src/core/map';
import { chargeRoute, reachProblem, REACH, resolveTurn } from '../src/core/resolve';
import type { GameState, Unit } from '../src/core/types';
import { CLASSES, MONSTERS } from '../src/data/units';
import { eventLog, turnSummary } from '../src/ui/panel';

const OPEN = [
  '##############',
  '#............#',
  '#............#',
  '#.....#......#',
  '#............#',
  '#............#',
  '##############',
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

function game(units: Unit[]): GameState {
  const map = parseMap(OPEN);
  return { seed: 1, rng: 1, turn: 1, map, units, explored: new Array(map.w * map.h).fill(0), status: 'playing' };
}

const nameOf = (id: string) => id;

describe('届かない理由', () => {
  it('射程外・壁・味方・別の敵・隣にいないを区別する', () => {
    const thief = mk('p2', 'thief', 1, 3);
    const s = game([thief, mk('p1', 'warrior', 3, 1), mk('g1', 'goblin', 12, 3), mk('g2', 'goblin', 8, 3), mk('g3', 'goblin', 5, 1)]);
    const { map, units } = s;
    const g = (id: string) => units.find((x) => x.id === id)!;
    expect(reachProblem(map, thief, thief, g('g1'), units)).toBe(REACH.range);
    // (6,3) は壁
    expect(reachProblem(map, thief, { x: 4, y: 3 }, g('g2'), units)).toBe(REACH.wall);
    // 戦士(3,1)越しに g3(5,1)
    expect(reachProblem(map, thief, { x: 1, y: 1 }, g('g3'), units)).toBe(REACH.ally);
    // g3(5,1) 越しに (8,1) の敵
    g('g2').x = 8;
    g('g2').y = 1;
    expect(reachProblem(map, thief, { x: 4, y: 1 }, g('g2'), units)).toBe(REACH.foe);
    expect(reachProblem(map, thief, { x: 4, y: 1 }, g('g3'), units)).toBeNull();
    expect(reachProblem(map, g('p1'), g('p1'), g('g3'), units)).toBe(REACH.adjacent);
  });

  it('遠隔の不発の理由も同じ言い回しになる', () => {
    const s = game([mk('p2', 'thief', 1, 3), mk('g2', 'goblin', 8, 3)]);
    const r = resolveTurn(s, { p2: [{ type: 'attack', target: 'g2' }] });
    expect(r.events.some((e) => e.type === 'fizzle' && e.id === 'p2' && e.reason === REACH.range)).toBe(true);
  });
});

describe('接近攻撃', () => {
  it('経路の目安は、攻撃が届く空いたマスまでの道', () => {
    const w = mk('p1', 'warrior', 1, 1);
    const g = mk('g1', 'goblin', 5, 1);
    const s = game([w, g]);
    const route = chargeRoute(s.map, w, w, g, s.units)!;
    expect(route[0]).toEqual({ x: 1, y: 1 });
    expect(route).toHaveLength(4);
    expect(Math.max(Math.abs(route[3].x - g.x), Math.abs(route[3].y - g.y))).toBe(1);
  });

  it('最後まで届かなかったら、ターンの終わりに理由を残す', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 12, 5)]);
    const r = resolveTurn(s, { p1: [{ type: 'charge', target: 'g1', ticks: 8 }], g1: [] });
    expect(r.events.some((e) => e.type === 'fizzle' && e.id === 'p1' && e.reason === '接近攻撃が届かなかった')).toBe(true);
  });

  it('攻撃まで届けば、理由は残さない', () => {
    const s = game([mk('p1', 'warrior', 1, 1), mk('g1', 'goblin', 4, 1)]);
    const r = resolveTurn(s, { p1: [{ type: 'charge', target: 'g1', ticks: 8 }], g1: [] });
    expect(r.events.some((e) => e.type === 'damage' && e.by === 'p1')).toBe(true);
    expect(r.events.some((e) => e.type === 'fizzle' && e.id === 'p1')).toBe(false);
  });
});

describe('ターン後の要約', () => {
  it('範囲魔法が誰にも当たらなければ「命中 0 体」と出し、経過にも残す', () => {
    const s = game([mk('p3', 'mage', 1, 1), mk('g1', 'goblin', 10, 5)]);
    const r = resolveTurn(s, { p3: [{ type: 'spell', spell: 'fireball', tile: { x: 5, y: 1 } }], g1: [] });
    const lines = turnSummary(r.events, s.units, nameOf);
    expect(lines[0]).toContain('火球: 命中 0 体');
    expect(eventLog(r.events, nameOf, Infinity)).toContain('誰にも当たらなかった');
  });

  it('味方ごとに 1 行で、攻撃の相手とダメージ・撃破・受けたダメージ・不発の理由をまとめる', () => {
    const g = mk('g1', 'goblin', 2, 1);
    g.hp = 1;
    const s = game([mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 1, 3), mk('g2', 'goblin', 12, 3), g]);
    const r = resolveTurn(s, { p1: [{ type: 'attack', target: 'g1' }], p2: [{ type: 'attack', target: 'g2' }], g1: [], g2: [] });
    const lines = turnSummary(r.events, s.units, nameOf);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^p1: 攻撃: g1に \d+\(撃破\)/);
    expect(lines[1]).toBe(`p2: 不発(${REACH.range})`);
  });

  it('気絶していた味方が蘇生されたら「起き上がった」と出す', () => {
    const w = mk('p1', 'warrior', 1, 1);
    w.down = true;
    w.hp = 0;
    const lines = turnSummary([{ tick: 3, type: 'revive', id: 'p1' }], [w], nameOf);
    expect(lines[0]).toBe('p1: 起き上がった');
  });

  it('レベルアップは全体の行に 1 つにまとめる', () => {
    const lines = turnSummary(
      [
        { tick: 8, type: 'levelup', id: 'p1', level: 2 },
        { tick: 8, type: 'levelup', id: 'p2', level: 2 },
      ],
      [mk('p1', 'warrior', 1, 1), mk('p2', 'thief', 2, 1)],
      nameOf,
    );
    expect(lines.at(-1)).toBe('全員がレベル 2 に上がった!');
  });
});
