// 職業とモンスターの定義。数値調整はここで行う。
import type { ItemId, SpellId } from '../core/types';

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
  /** 倒したときにパーティ全員が得る経験値(モンスターのみ) */
  exp?: number;
  /** 倒したときにパーティが得るゴールド(モンスターのみ) */
  gold?: number;
  /** レベルが 1 上がるごとの成長量(職業のみ) */
  growth?: { hp: number; mp: number; atk: number };
}

export const CLASSES: Record<string, UnitDef> = {
  warrior: { id: 'warrior', name: '戦士', icon: 'warrior', maxHp: 48, maxMp: 0, atk: 7, dmgVar: 3, def: 2, range: 1, sight: 7, spells: ['cover', 'power'], growth: { hp: 6, mp: 0, atk: 1 } },
  thief: { id: 'thief', name: '盗賊', icon: 'thief', maxHp: 30, maxMp: 8, atk: 5, dmgVar: 3, def: 1, range: 6, sight: 8, spells: ['trip', 'power'], growth: { hp: 4, mp: 1, atk: 1 } },
  mage: { id: 'mage', name: '魔法使い', icon: 'mage', maxHp: 24, maxMp: 14, atk: 3, dmgVar: 2, def: 0, range: 6, sight: 7, spells: ['fireball'], growth: { hp: 3, mp: 2, atk: 0 } },
  priest: { id: 'priest', name: '僧侶', icon: 'priest', maxHp: 33, maxMp: 14, atk: 4, dmgVar: 2, def: 1, range: 1, sight: 7, spells: ['heal', 'revive', 'smite'], growth: { hp: 4, mp: 2, atk: 1 } },
};

export const MONSTERS: Record<string, UnitDef> = {
  slime: { id: 'slime', name: 'スライム', icon: 'slime', maxHp: 12, maxMp: 0, atk: 5, dmgVar: 2, def: 0, range: 1, sight: 5, spells: [], exp: 3, gold: 2 },
  bat: { id: 'bat', name: '大コウモリ', icon: 'bat', maxHp: 10, maxMp: 0, atk: 6, dmgVar: 2, def: 0, range: 1, sight: 9, spells: [], exp: 4, gold: 2 },
  goblin: { id: 'goblin', name: 'ゴブリン', icon: 'goblin', maxHp: 20, maxMp: 0, atk: 7, dmgVar: 2, def: 0, range: 1, sight: 6, spells: [], exp: 6, gold: 3 },
  archer: { id: 'archer', name: '骸骨弓兵', icon: 'archer', maxHp: 18, maxMp: 0, atk: 7, dmgVar: 2, def: 0, range: 6, sight: 7, spells: [], exp: 6, gold: 3 },
  /** 火球を使う。MP が尽きたら杖で殴る */
  shaman: { id: 'shaman', name: 'ゴブリン呪術師', icon: 'shaman', maxHp: 16, maxMp: 6, atk: 4, dmgVar: 2, def: 0, range: 1, sight: 7, spells: ['fireball'], exp: 9, gold: 5 },
  orc: { id: 'orc', name: 'オーク', icon: 'orc', maxHp: 39, maxMp: 0, atk: 10, dmgVar: 3, def: 1, range: 1, sight: 6, spells: [], exp: 12, gold: 6 },
  darkelf: { id: 'darkelf', name: 'ダークエルフ', icon: 'darkelf', maxHp: 28, maxMp: 0, atk: 10, dmgVar: 3, def: 1, range: 7, sight: 8, spells: [], exp: 14, gold: 7 },
  /** 警報役。パーティに気付くと逃げながら角笛を吹き、止められなければ増援を呼ぶ(alarm.ts) */
  hornblower: { id: 'hornblower', name: '角笛ゴブリン', icon: 'hornblower', maxHp: 14, maxMp: 0, atk: 4, dmgVar: 2, def: 0, range: 1, sight: 8, spells: [], exp: 8, gold: 4 },
  /** 業火(5 ティック詠唱の大技)を使う。打たれ弱い */
  warlock: { id: 'warlock', name: '呪術師長', icon: 'warlock', maxHp: 22, maxMp: 8, atk: 4, dmgVar: 2, def: 0, range: 1, sight: 7, spells: ['hellfire'], exp: 14, gold: 7 },
  troll: { id: 'troll', name: 'トロル', icon: 'troll', maxHp: 55, maxMp: 0, atk: 11, dmgVar: 3, def: 2, range: 1, sight: 6, spells: [], exp: 18, gold: 9 },
  ogre: { id: 'ogre', name: 'オーガ', icon: 'ogre', maxHp: 70, maxMp: 0, atk: 11, dmgVar: 4, def: 2, range: 1, sight: 6, spells: [], exp: 24, gold: 12 },
  /** ボス。地下 5 階の最も奥の部屋で秘宝を守る。炎のブレスを吐く */
  dragon: { id: 'dragon', name: 'ドラゴン', icon: 'dragon', maxHp: 90, maxMp: 0, atk: 13, dmgVar: 4, def: 3, range: 1, sight: 6, spells: ['breath'], exp: 80, gold: 100 },
  /** Easy 用のボス(若いドラゴン)。HP だけ低い */
  wyrm: { id: 'wyrm', name: '若いドラゴン', icon: 'dragon', maxHp: 55, maxMp: 0, atk: 13, dmgVar: 4, def: 3, range: 1, sight: 6, spells: ['breath'], exp: 60, gold: 80 },
};

/**
 * レベルごとの必要経験値(累計)。EXP_TABLE[n] = レベル n+1 になるのに必要な累計経験値。
 * 長さ + 1 がレベルの上限
 */
export const EXP_TABLE = [0, 20, 50, 95, 155, 235, 335, 460, 610, 790];
export const MAX_LEVEL = EXP_TABLE.length;
/** 魔法使い・僧侶の魔法の威力が、レベル 1 つごとに上がる量 */
export const SPELL_GROWTH = 1;

export interface SpellDef {
  id: SpellId;
  name: string;
  mp: number;
  range: number;
  /** 'tile'=マス狙い, 'ally'=味方(生存), 'downed'=気絶した味方, 'foe'=敵 1 体, 'self'=自分(対象を選ばない) */
  target: 'tile' | 'ally' | 'downed' | 'foe' | 'self';
  power: number;
  powerVar: number;
  /** 範囲(チェビシェフ距離) */
  radius: number;
  /** true なら、範囲内の敵だけに当たる(味方は巻き込まない) */
  foesOnly?: boolean;
  /** AP(未指定は RULES.spellCost)。最後のティックで発動し、それまでは詠唱(構え) */
  cost?: number;
}

export const SPELLS: Record<SpellId, SpellDef> = {
  fireball: { id: 'fireball', name: '火球', mp: 3, range: 6, target: 'tile', power: 8, powerVar: 4, radius: 1 },
  heal: { id: 'heal', name: '回復', mp: 3, range: 4, target: 'ally', power: 10, powerVar: 3, radius: 0 },
  revive: { id: 'revive', name: '蘇生', mp: 6, range: 1, target: 'downed', power: 8, powerVar: 0, radius: 0 },
  /** 僧侶の聖光。範囲内の敵だけに当たる小さな攻撃魔法 */
  smite: { id: 'smite', name: '聖光', mp: 3, range: 5, target: 'tile', power: 5, powerVar: 3, radius: 1, foesOnly: true },
  /** 盗賊の足払い。敵 1 体を数ティック動けなくする(ダメージは無い) */
  trip: { id: 'trip', name: '足払い', mp: 2, range: 5, target: 'foe', power: 0, powerVar: 0, radius: 0 },
  /** 戦士のかばう。MP は使わない。3 ティックの間防御し、隣の味方への単体攻撃を代わりに受ける */
  cover: { id: 'cover', name: 'かばう', mp: 0, range: 0, target: 'self', power: 0, powerVar: 0, radius: 0 },
  /** 強攻撃。通常攻撃より AP を多く使い、ダメージが増える(戦士・盗賊) */
  power: { id: 'power', name: '強攻撃', mp: 0, range: 0, target: 'foe', power: 0, powerVar: 0, radius: 0 },
  /** ドラゴンの炎のブレス。火球と同じく 3×3 のマス狙い。2 ターンに 1 回(RULES.breathEvery) */
  breath: { id: 'breath', name: '炎のブレス', mp: 0, range: 4, target: 'tile', power: 10, powerVar: 4, radius: 1 },
  /**
   * 呪術師長の業火。5 ティック詠唱して 5×5 を焼く遅い大技。着弾範囲と発動のティックは予兆で見える。
   * 逃げる・足払いで詠唱を止める・先に倒す、のどれかで対処する
   */
  hellfire: { id: 'hellfire', name: '業火', mp: 4, range: 6, target: 'tile', power: 12, powerVar: 4, radius: 2, cost: 5 },
};

/**
 * レベルアップの二択(成長)。class の職業が level に達したとき、choices から 1 つ選ぶ。
 * 今は魔法使いの Lv 2 だけで試している
 */
export const PERK_CHOICES: { class: string; level: number; choices: string[] }[] = [{ class: 'mage', level: 2, choices: ['fireRange', 'fireMp'] }];

export const PERKS: Record<string, { name: string; desc: string; spell: SpellId; range?: number; mp?: number }> = {
  fireRange: { name: '遠くまで届く火球', desc: '火球の射程 +1(6 → 7)。危ない位置に立たずに撃てる', spell: 'fireball', range: 1 },
  fireMp: { name: '軽い火球', desc: '火球の MP 消費 −1(3 → 2)。撃てる回数が増える', spell: 'fireball', mp: -1 },
};

/**
 * 持ち物。回復薬は戦闘中も使える(2 AP・自分か隣の味方)。食料は休憩 1 ターンごとに 1 つ使う(amount は使わない)。
 * どれも店で買う
 */
export const ITEMS: Record<ItemId, { id: ItemId; name: string; short: string; price: number; amount: number; icon: string }> = {
  hp: { id: 'hp', name: 'HP 回復薬', short: 'HP薬', price: 40, amount: 25, icon: '🧪' },
  mp: { id: 'mp', name: 'MP 回復薬', short: 'MP薬', price: 40, amount: 8, icon: '🧪' },
  food: { id: 'food', name: '食料', short: '食料', price: 8, amount: 1, icon: '🍞' },
};

export function unitDef(defId: string): UnitDef {
  const d = CLASSES[defId] ?? MONSTERS[defId];
  if (!d) throw new Error(`unknown unit def: ${defId}`);
  return d;
}
