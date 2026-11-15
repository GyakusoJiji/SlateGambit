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
  mage: { id: 'mage', name: '魔法使い', icon: 'mage', maxHp: 24, maxMp: 14, atk: 3, dmgVar: 2, def: 0, range: 1, sight: 7, spells: ['fireball'] },
  priest: { id: 'priest', name: '僧侶', icon: 'priest', maxHp: 33, maxMp: 14, atk: 4, dmgVar: 2, def: 1, range: 1, sight: 7, spells: ['heal', 'revive'] },
};

export const MONSTERS: Record<string, UnitDef> = {
  goblin: { id: 'goblin', name: 'ゴブリン', icon: 'goblin', maxHp: 17, maxMp: 0, atk: 6, dmgVar: 2, def: 0, range: 1, sight: 6, spells: [] },
  archer: { id: 'archer', name: '骸骨弓兵', icon: 'archer', maxHp: 15, maxMp: 0, atk: 6, dmgVar: 2, def: 0, range: 6, sight: 7, spells: [] },
  orc: { id: 'orc', name: 'オーク', icon: 'orc', maxHp: 33, maxMp: 0, atk: 9, dmgVar: 3, def: 1, range: 1, sight: 6, spells: [] },
  ogre: { id: 'ogre', name: 'オーガ', icon: 'ogre', maxHp: 60, maxMp: 0, atk: 10, dmgVar: 4, def: 2, range: 1, sight: 6, spells: [] },
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
};

export function unitDef(defId: string): UnitDef {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  if (!d) throw new Error(`unknown unit def: ${defId}`);
  return d;
}
