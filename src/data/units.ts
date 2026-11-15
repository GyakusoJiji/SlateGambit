// 職業とモンスターの定義。数値調整はここで行う。
import type { SpellId } from '../core/types';

export interface UnitDef {
  id: string;
  name: string;
  /** icons.ts のアイコン名 */
  icon: string;
  maxHp: number;
  maxMp: number;
  /** 通常攻撃の基本ダメージ */
  atk: number;
  /** ダメージの振れ幅(0〜dmgVar を加算) */
  dmgVar: number;
  def: number;
  /** 通常攻撃の射程。1 は近接 */
  range: number;
  sight: number;
  spells: SpellId[];
}

export const CLASSES: Record<string, UnitDef> = {
  warrior: { id: 'warrior', name: '戦士', icon: 'warrior', maxHp: 48, maxMp: 0, atk: 7, dmgVar: 3, def: 2, range: 1, sight: 7, spells: [] },
  thief: { id: 'thief', name: '盗賊', icon: 'thief', maxHp: 30, maxMp: 0, atk: 5, dmgVar: 3, def: 1, range: 6, sight: 8, spells: [] },
  mage: { id: 'mage', name: '魔法使い', icon: 'mage', maxHp: 24, maxMp: 14, atk: 3, dmgVar: 2, def: 0, range: 6, sight: 7, spells: ['fireball'] },
  priest: { id: 'priest', name: '僧侶', icon: 'priest', maxHp: 33, maxMp: 14, atk: 4, dmgVar: 2, def: 1, range: 1, sight: 7, spells: ['heal', 'revive'] },
};

export const MONSTERS: Record<string, UnitDef> = {
  goblin: { id: 'goblin', name: 'ゴブリン', icon: 'goblin', maxHp: 20, maxMp: 0, atk: 7, dmgVar: 2, def: 0, range: 1, sight: 6, spells: [] },
  archer: { id: 'archer', name: '骸骨弓兵', icon: 'archer', maxHp: 18, maxMp: 0, atk: 7, dmgVar: 2, def: 0, range: 6, sight: 7, spells: [] },
  orc: { id: 'orc', name: 'オーク', icon: 'orc', maxHp: 39, maxMp: 0, atk: 10, dmgVar: 3, def: 1, range: 1, sight: 6, spells: [] },
  ogre: { id: 'ogre', name: 'オーガ', icon: 'ogre', maxHp: 70, maxMp: 0, atk: 11, dmgVar: 4, def: 2, range: 1, sight: 6, spells: [] },
  /** ボス。マップに 1 体、入口から最も遠い部屋にいる。強さはオーガと同じで、炎のブレスを吐く */
  dragon: { id: 'dragon', name: 'ドラゴン', icon: 'dragon', maxHp: 70, maxMp: 0, atk: 11, dmgVar: 4, def: 2, range: 1, sight: 6, spells: ['breath'] },
  /** Easy 用のボス(若いドラゴン)。HP だけ低い */
  wyrm: { id: 'wyrm', name: '若いドラゴン', icon: 'dragon', maxHp: 55, maxMp: 0, atk: 11, dmgVar: 4, def: 2, range: 1, sight: 6, spells: ['breath'] },
};

export interface SpellDef {
  id: SpellId;
  name: string;
  mp: number;
  range: number;
  /** 'tile'=マス狙い, 'ally'=味方(生存), 'downed'=気絶した味方 */
  target: 'tile' | 'ally' | 'downed';
  power: number;
  powerVar: number;
  /** 範囲(チェビシェフ距離) */
  radius: number;
}

export const SPELLS: Record<SpellId, SpellDef> = {
  fireball: { id: 'fireball', name: '火球', mp: 3, range: 6, target: 'tile', power: 8, powerVar: 4, radius: 1 },
  heal: { id: 'heal', name: '回復', mp: 3, range: 4, target: 'ally', power: 10, powerVar: 3, radius: 0 },
  revive: { id: 'revive', name: '蘇生', mp: 6, range: 1, target: 'downed', power: 8, powerVar: 0, radius: 0 },
  /** ドラゴンの炎のブレス。火球と同じく 3×3 のマス狙い。2 ターンに 1 回(RULES.breathEvery) */
  breath: { id: 'breath', name: '炎のブレス', mp: 0, range: 4, target: 'tile', power: 10, powerVar: 4, radius: 1 },
};

export function unitDef(defId: string): UnitDef {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  if (!d) throw new Error(`unknown unit def: ${defId}`);
  return d;
}
