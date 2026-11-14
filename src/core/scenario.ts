// 第 1 区間(戦闘検証)用の小さな試験階と初期配置。
// 10 階分の自動生成データに置き換わるまでの暫定シナリオ。
import { CLASSES, MONSTERS } from '../data/units';
import { parseMap } from './map';
import type { AiMemory, GameState, Unit } from './types';
import { updateExplored } from './vision';

export const TEST_FLOOR = [
  '################################',
  '#........#............#........#',
  '#........#............#........#',
  '#........+....#..#....+........#',
  '#........#............#........#',
  '#........#............#........#',
  '####+#########+##+#########+####',
  '#..........#........#..........#',
  '#..........#..#..#..#..........#',
  '#..........+........+..........#',
  '#..........#..#..#..#..........#',
  '#..........#........#..........#',
  '#####+##########+#########+#####',
  '#..............................#',
  '#...##....##........##....##...#',
  '#..............................#',
  '#...##....##........##....##...#',
  '#..............................#',
  '######+#################+#######',
  '#.........#..........#.........#',
  '#..S......+..........+.........#',
  '#.........#..........#.........#',
  '################################',
];

function party(id: string, defId: string, x: number, y: number): Unit {
  const d = CLASSES[defId];
  return { id, side: 'party', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false };
}

function monster(id: string, defId: string, x: number, y: number, ai: AiMemory = { mode: 'idle' }): Unit {
  const d = MONSTERS[defId];
  return { id, side: 'enemy', defId, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false, ai };
}

export function createTestGame(seed: number): GameState {
  const map = parseMap(TEST_FLOOR);
  const units: Unit[] = [
    party('p1', 'warrior', 5, 20),
    party('p2', 'thief', 4, 19),
    party('p3', 'mage', 3, 21),
    party('p4', 'priest', 2, 20),
    monster('g1', 'goblin', 15, 20),
    monster('g2', 'goblin', 17, 19),
    monster('o1', 'orc', 28, 15, { mode: 'patrol', patrol: [{ x: 28, y: 15 }, { x: 3, y: 15 }], patrolIndex: 0 }),
    monster('a1', 'archer', 15, 13),
    monster('g3', 'goblin', 6, 9),
    monster('a2', 'archer', 2, 8),
    monster('b1', 'ogre', 27, 3),
  ];
  const state: GameState = {
    seed,
    rng: seed,
    turn: 1,
    map,
    units,
    explored: new Array(map.w * map.h).fill(0),
    status: 'playing',
  };
  updateExplored(state);
  return state;
}
