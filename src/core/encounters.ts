// 固定遭遇: 決まった部屋と配置で、同じ判断を何度でも試せる小さな戦場。
// ランダム生成全体を変える前に、敵の組み合わせや新しい仕組みの面白さを比べるために使う。
// 地図の文字: '#' 壁、'.' 床、'S' 出口(救出の目的地)、'1'〜'4' 戦士・盗賊・魔法使い・僧侶(小文字 'w' は気絶した戦士)、
// それ以外の英字は ENEMY_MARKS の敵。
import { CLASSES, EXP_TABLE, MONSTERS } from '../data/units';
import { parseMap } from './map';
import { hashSeed } from './rng';
import { stats } from './stats';
import type { GameState, Objective, Unit } from './types';
import { updateExplored } from './vision';

/** 固定遭遇のパーティのレベル */
export const ENCOUNTER_LEVEL = 3;

const PARTY_MARKS: Record<string, string> = { '1': 'warrior', '2': 'thief', '3': 'mage', '4': 'priest', w: 'warrior' };

const ENEMY_MARKS: Record<string, string> = {
  g: 'goblin',
  a: 'archer',
  m: 'shaman',
  o: 'orc',
  e: 'darkelf',
  t: 'troll',
  b: 'bat',
  k: 'warlock',
};

export interface EncounterDef {
  id: string;
  title: string;
  desc: string;
  rows: string[];
  objective: Objective;
}

/** 編成の比較に使う部屋(同じ地形に、違う編成を置く) */
const HALL = (marks: Record<string, string>): string[] =>
  [
    '######################',
    '#....................#',
    '#..............R..V..#',
    '#.......##...........#',
    '#1.............P.....#',
    '#2.......#.....Q..X..#',
    '#3.......#.....Y.....#',
    '#4.............T.....#',
    '#.......##...........#',
    '#..............U..Z..#',
    '######################',
  ].map((r) => r.replace(/[PQRTUVXYZ]/g, (c) => marks[c] ?? '.'));

export const ENCOUNTERS: EncounterDef[] = [
  {
    id: 'caster',
    title: '詠唱を止めろ',
    desc: 'オーク 2 体・ゴブリン・骸骨弓兵の奥で、呪術師長が 5 ティック目に 5×5 を焼く業火を唱える。逃げるか、足払いで止めるか、先に倒すか',
    rows: [
      '######################',
      '#....................#',
      '#..........#.....a...#',
      '#1.........o......k..#',
      '#2........g..........#',
      '#3.........o.........#',
      '#4.........#.........#',
      '#....................#',
      '######################',
    ],
    objective: { kind: 'annihilate' },
  },
  {
    id: 'melee',
    title: '編成の比較 A: 前衛だけ',
    desc: 'ゴブリン 5 体とオーク 2 体(18 点)。まとまって押し寄せる',
    rows: HALL({ P: 'g', Q: 'o', T: 'g', Y: 'g', R: 'g', U: 'o', X: 'g' }),
    objective: { kind: 'annihilate' },
  },
  {
    id: 'mixed',
    title: '編成の比較 B: 前衛と後衛',
    desc: 'ゴブリン 2 体とオークが前、骸骨弓兵 2 体と呪術師 2 体が後ろ(18 点)。狙う順番と射線を考える',
    rows: HALL({ P: 'g', Q: 'o', T: 'g', V: 'a', Z: 'a', X: 'm', R: 'm' }),
    objective: { kind: 'annihilate' },
  },
];

export function encounterDef(id: string): EncounterDef | undefined {
  return ENCOUNTERS.find((e) => e.id === id);
}

/** 固定遭遇を始める。シードは乱数(ダメージの揺れなど)だけに使う */
export function createEncounter(id: string, seed: number): GameState | null {
  const def = encounterDef(id);
  if (!def) return null;
  const units: Unit[] = [];
  const counts: Record<string, number> = {};
  const rows = def.rows.map((row, y) =>
    [...row]
      .map((c, x) => {
        if (PARTY_MARKS[c]) {
          units.push(partyUnit(PARTY_MARKS[c], c === 'w', x, y));
          return '.';
        }
        const m = ENEMY_MARKS[c];
        if (m) {
          counts[c] = (counts[c] ?? 0) + 1;
          const d = MONSTERS[m];
          units.push({ id: `${c}${counts[c]}`, side: 'enemy', defId: m, name: d.name, x, y, hp: d.maxHp, mp: d.maxMp, down: false, ai: { mode: 'idle' } });
          return '.';
        }
        return c;
      })
      .join(''),
  );
  const map = parseMap(rows);
  // 味方の ID は職業の順(p1 戦士 〜 p4 僧侶)
  const order = ['warrior', 'thief', 'mage', 'priest'];
  units.sort((a, b) => (a.side === b.side ? 0 : a.side === 'party' ? -1 : 1));
  const party = units.filter((u) => u.side === 'party').sort((a, b) => order.indexOf(a.defId) - order.indexOf(b.defId));
  party.forEach((u, i) => (u.id = `p${i + 1}`));
  const state: GameState = {
    seed,
    difficulty: 'normal',
    objective: def.objective.kind === 'escape' ? { kind: 'escape', who: party.find((u) => u.down)?.id ?? 'p1' } : def.objective,
    rng: hashSeed('encounter', id, seed),
    turn: 1,
    map,
    units: [...party, ...units.filter((u) => u.side === 'enemy')],
    explored: new Array(map.w * map.h).fill(0),
    status: 'playing',
    floor: 1,
    floors: {},
    gold: 0,
    deepest: 1,
    scenario: id,
  };
  updateExplored(state);
  return state;
}

function partyUnit(defId: string, down: boolean, x: number, y: number): Unit {
  const c = CLASSES[defId];
  const level = ENCOUNTER_LEVEL;
  const u: Unit = { id: defId, side: 'party', defId, name: c.name, x, y, hp: 0, mp: 0, down, level, exp: EXP_TABLE[level - 1] };
  const st = stats(u);
  u.hp = down ? 0 : st.maxHp;
  u.mp = st.maxMp;
  return u;
}
