// 固定遭遇: 決まった部屋と配置で、同じ判断を何度でも試せる小さな戦場(チュートリアルのレッスンとミニゲームのステージが使う)。
// 地図の文字: '#' 壁、'.' 床、'S' 出口(救出の目的地)、'1'〜'4' 戦士・盗賊・魔法使い・僧侶(小文字 'w' は気絶した戦士)、
// それ以外の英字は ENEMY_MARKS の敵。
import { CLASSES, EXP_TABLE, MONSTERS } from '../data/units';
import { parseMap } from './map';
import { hashSeed } from './rng';
import { stats } from './stats';
import type { GameState, Objective, Unit } from './types';
import { lessonDef } from './tutorial';
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
  h: 'hornblower',
};

export interface EncounterDef {
  id: string;
  title: string;
  desc: string;
  rows: string[];
  objective: Objective;
  /** ミニゲームのステージ: 目安のターン数(これ以内で勝つと評価が上がる) */
  par?: number;
}

/** ミニゲームで次のステージへ持ち越す、味方 1 人の状態 */
export interface CarryUnit {
  hp: number;
  mp: number;
  perks?: string[];
}
/** 味方の ID(p1〜p4)ごとの持ち越し */
export type Carry = Record<string, CarryUnit>;

export function encounterDef(id: string): EncounterDef | undefined {
  return lessonDef(id);
}

/** 固定遭遇を始める。シードは乱数(ダメージの揺れなど)だけに使う */
export function createEncounter(id: string, seed: number): GameState | null {
  const def = encounterDef(id);
  return def ? createFromDef(def, def.id, seed) : null;
}

/**
 * 部屋の定義から遭遇を作る(固定遭遇とミニゲームのステージで共通)。scenario は state.scenario に入れる ID。
 * carry があれば、味方の HP・MP・成長を前のステージから引き継ぐ(気絶して始める戦士は気絶のまま)
 */
export function createFromDef(def: EncounterDef, scenario: string, seed: number, carry?: Carry): GameState {
  const id = scenario;
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
  if (carry) {
    for (const u of party) {
      const c = carry[u.id];
      if (!c) continue;
      if (c.perks) u.perks = [...c.perks];
      const st = stats(u);
      if (!u.down) u.hp = Math.max(1, Math.min(st.maxHp, c.hp));
      u.mp = Math.min(st.maxMp, c.mp);
    }
  }
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
    // 固定遭遇は戦い方を試す場なので、休憩の食料は十分に持たせる
    items: { food: 99 },
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
