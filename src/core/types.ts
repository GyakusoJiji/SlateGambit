// ルールエンジンの型定義。DOM に依存しない。

export interface Pos {
  x: number;
  y: number;
}

export type Dir = 'N' | 'E' | 'S' | 'W';

export type Side = 'party' | 'enemy';

/**
 * マップのタイル。'#'=壁, '.'=床, '+'=扉(開), 'D'=扉(閉), 'S'=上り階段(地下 1 階では入口), '>'=下り階段,
 * 'H'=回復の泉, 'h'=枯れた泉(地上から潜り直すと戻る), '$'=宝箱, 'c'=開けた宝箱
 * 閉じた扉は視線を遮るが、通ることはできる(隣に立ったユニットが開けるため)
 */
export type TileChar = '#' | '.' | '+' | 'D' | 'S' | '>' | 'H' | 'h' | '$' | 'c';

export interface FloorMap {
  w: number;
  h: number;
  /** h 行・各 w 文字 */
  tiles: string[];
  /** 開いている扉('+')が自動で閉まるまでの残りターン数("x,y" → ターン数) */
  doors?: Record<string, number>;
}

/** 魔法と特技。cover・power は魔法ではないが、特技のボタンとして同じ枠に並べる */
export type SpellId = 'fireball' | 'heal' | 'revive' | 'breath' | 'smite' | 'trip' | 'cover' | 'power' | 'hellfire';

export interface AiMemory {
  mode: 'idle' | 'patrol';
  patrol?: Pos[];
  patrolIndex?: number;
  alerted?: boolean;
  lastSeen?: Pos;
  /** 眠っている(宝探しのドラゴン)。近くで姿を見られる・攻撃される・宝を拾われると起きる */
  asleep?: boolean;
  /** 最後に炎のブレスを吐いたターン */
  breathTurn?: number;
  /** 警報役: 気付いてから角笛を吹いたターン数(気付く前は未指定) */
  alarm?: number;
  /** 警報役: 増援を呼び終えた */
  alarmRaised?: boolean;
  /** 警報役: 止めた宝を渡し終えた */
  bountyPaid?: boolean;
  /** 野盗: パーティから盗んだゴールド(盗んだ後は逃げる) */
  stolen?: number;
  /** 野盗: 盗んだ後、パーティに見られずに過ごしたターン数 */
  unseen?: number;
  /** 地上の住人に化けた盗人(見かけは住人と同じ。攻撃が当たった時点で野盗の正体を現す) */
  disguise?: boolean;
  /** 住人が最後に噂を話したターン */
  talked?: number;
}

export interface Unit {
  id: string;
  side: Side;
  /** 職業またはモンスターの定義 ID */
  defId: string;
  name: string;
  x: number;
  y: number;
  hp: number;
  mp: number;
  down: boolean;
  /** 倒れたターン(倒れた敵の描画を一定ターン後に消すため) */
  downTurn?: number;
  /** 担いでいる気絶した味方の ID */
  carrying?: string;
  /** 気絶中に、担がれたままターンを終えた連続回数(降ろされると 0 に戻る) */
  carriedTurns?: number;
  ai?: AiMemory;
  /** レベル(パーティのみ。未指定は 1) */
  level?: number;
  /** 累計の経験値(パーティのみ) */
  exp?: number;
  /** レベルアップの二択で選んだ成長(PERKS の ID) */
  perks?: string[];
}

export type GameStatus = 'playing' | 'won' | 'lost';

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * ゲームの目的。
 * - annihilate: 敵の全滅(テスト用の固定マップ)
 * - treasure: 宝(秘宝)を拾い、持ったまま地下 1 階の入口の階段('S')に戻る。
 *   at=床に置かれている位置、floor=その階(未指定は今の階)、holder=持っている味方
 * - escape: who(気絶していても、担がれていてもよい)が出口('S')でターンを終える(固定遭遇の救出)
 */
export type Objective =
  | { kind: 'annihilate' }
  | { kind: 'treasure'; at: Pos | null; floor?: number; holder?: string }
  | { kind: 'escape'; who: string };

/** 今いない階の状態(戻ったときに再現する) */
export interface FloorData {
  map: FloorMap;
  /** その階の敵 */
  enemies: Unit[];
  explored: number[];
}

export interface GameState {
  seed: number;
  /** 未指定は normal 相当(テスト用の固定マップ) */
  difficulty?: Difficulty;
  /** 未指定は敵の全滅 */
  objective?: Objective;
  /** 乱数の内部状態 */
  rng: number;
  turn: number;
  map: FloorMap;
  units: Unit[];
  /** パーティが一度でも見たマス(0/1, y*w+x) */
  explored: number[];
  status: GameStatus;
  /** 今いる階(地下 n 階)。未指定は 1 */
  floor?: number;
  /** 今いない、訪れたことのある階の状態 */
  floors?: Record<number, FloorData>;
  /** 宝箱から得たゴールドの合計 */
  gold?: number;
  /** 訪れた最も深い階 */
  deepest?: number;
  /** 固定遭遇の ID(固定遭遇なら自動保存せず、休憩の物音も起きない) */
  scenario?: string;
  /** パーティ共通の持ち物(回復薬の数)。泉でゴールドを払って買う */
  items?: Partial<Record<ItemId, number>>;
  /** 地上の銀行に預けたゴールド(野盗に盗まれない。地上でしか引き出せない) */
  bank?: number;
  /** 教会の加護。最初に気絶した味方を 1 度だけその場で復帰させる。地上へ戻ると消える */
  blessing?: boolean;
}

/** 持ち物の種類(回復薬と食料)。食料は休憩 1 ターンごとに 1 つ使う */
export type ItemId = PotionId | 'food';
/** 回復薬の種類(戦闘中に使える持ち物) */
export type PotionId = 'hp' | 'mp';

// ---- 行動(予約リストの要素) ----

export type Action =
  /** slow: 担いでいる間の移動(1 マス 2 AP) */
  | { type: 'move'; dir: Dir; stop?: boolean; slow?: boolean }
  /** power: 強攻撃(AP を多く使い、ダメージが増える) */
  | { type: 'attack'; target: string; power?: boolean }
  /** かばう: 3 ティックの間防御し、隣の味方への単体攻撃を代わりに受ける */
  | { type: 'cover' }
  /** 接近攻撃: 届かなければ近づき、届けば構えて攻撃する。残り AP をすべて使い、続けて攻撃する */
  | { type: 'charge'; target: string; ticks: number }
  | { type: 'carry'; target: string }
  | { type: 'drop' }
  /** 階段を使う(0 AP)。ターンの終わりに階段の上にいれば、全員で別の階へ移る。行き先に階段を選んだときだけ予約する */
  | { type: 'stairs' }
  | { type: 'guard' }
  | { type: 'wait' }
  | { type: 'spell'; spell: SpellId; target?: string; tile?: Pos }
  /** 回復薬を飲む・飲ませる(2 AP。自分か隣の立っている味方。2 ティック目に効く) */
  | { type: 'item'; item: PotionId; target: string }
  | { type: 'overwatch'; ticks: number }
  | { type: 'intercept'; ticks: number };

export type Plans = Record<string, Action[]>;

// ---- 解決結果 ----

export type StrikeKind = 'melee' | 'ranged' | 'fireball' | 'breath' | 'heal' | 'revive' | 'smite' | 'trip' | 'hellfire' | 'potion';

export type GameEvent =
  | { tick: number; type: 'move'; id: string; from: Pos; to: Pos }
  | { tick: number; type: 'bump'; id: string; at: Pos }
  | { tick: number; type: 'halt'; id: string }
  | {
      tick: number;
      type: 'strike';
      id: string;
      kind: StrikeKind;
      target?: string;
      tile?: Pos;
      /** 矢などが実際に当たったユニット */
      hitId?: string;
      /** 着弾点(描画用) */
      end: Pos;
      /** 見えないマスを狙った火球の着弾点が、狙ったマス(tile)からずれた */
      scatter?: boolean;
      reaction?: boolean;
    }
  | { tick: number; type: 'fizzle'; id: string; reason: string }
  | { tick: number; type: 'damage'; id: string; amount: number; by: string; guarded: boolean; flank?: boolean }
  /** id が、攻撃されそうだった for の代わりに攻撃を受けた */
  | { tick: number; type: 'cover'; id: string; for: string }
  /** 足払いで、id が数ティック動けなくなった */
  | { tick: number; type: 'stun'; id: string; ticks: number }
  /** 足払いで、id の構えていた攻撃・魔法(詠唱)が取り消された */
  | { tick: number; type: 'interrupt'; id: string; spell?: SpellId }
  /** 警報役が角笛を吹き終え、増援が count 体現れた */
  | { tick: number; type: 'alarm'; id: string; count: number }
  /** 警報役を止め、持っていた宝(gold)を手に入れた */
  | { tick: number; type: 'bounty'; id: string; gold: number }
  /** 休憩の物音で、遠くから敵が現れた(位置は教えない) */
  | { tick: number; type: 'wander'; count: number }
  /** mp=true なら MP の回復(回復薬) */
  | { tick: number; type: 'heal'; id: string; amount: number; mp?: boolean }
  | { tick: number; type: 'down'; id: string }
  | { tick: number; type: 'revive'; id: string }
  | { tick: number; type: 'rest'; id: string; hp: number; mp: number }
  | { tick: number; type: 'carry'; id: string; target: string }
  | { tick: number; type: 'drop'; id: string; target: string }
  | { tick: number; type: 'spring'; id: string; revived: boolean }
  /** 回復の泉が枯れた */
  | { tick: number; type: 'dry'; at: Pos }
  /** 休憩で食料を使った(food=false なら、食料が無くて休憩しても回復しなかった) */
  | { tick: number; type: 'ration'; food: boolean }
  /** 地上の住人(id)が噂を話した */
  | { tick: number; type: 'rumor'; id: string; rumor: Rumor }
  /** 住人に化けていた盗人(id)が正体を現した */
  | { tick: number; type: 'unmask'; id: string }
  /** 地上(城の中)に魔物が入り込んだ */
  | { tick: number; type: 'intrude'; count: number }
  /** 教会の加護で、気絶するはずだった id がその場で持ち直した */
  | { tick: number; type: 'blessing'; id: string }
  /** 倒した敵からゴールドを得た */
  | { tick: number; type: 'loot'; gold: number }
  /** 野盗(id)にゴールドを盗まれた */
  | { tick: number; type: 'steal'; id: string; gold: number }
  /** 盗んだ野盗(id)を倒して、ゴールドを取り返した */
  | { tick: number; type: 'recover'; id: string; gold: number }
  /** 盗んだ野盗(id)に逃げ切られた(盗まれたゴールドは戻らない) */
  | { tick: number; type: 'escape'; id: string; gold: number }
  /** 担がれている間に意識を取り戻した */
  | { tick: number; type: 'wake'; id: string }
  /** 眠っていた敵が目を覚ました */
  | { tick: number; type: 'awaken'; id: string }
  /** 宝を拾った(got=true)/気絶して落とした(got=false) */
  | { tick: number; type: 'treasure'; id: string; got: boolean; at: Pos }
  /** 宝箱を開けた */
  | { tick: number; type: 'chest'; id: string; gold: number; at: Pos }
  /** 敵を倒してパーティ全員が経験値を得た */
  | { tick: number; type: 'exp'; amount: number }
  | { tick: number; type: 'levelup'; id: string; level: number }
  /** 階段で別の階へ移った(id=階段に入った味方) */
  | { tick: number; type: 'stairs'; id: string; from: number; to: number };

/** 住人の噂。truth は本当の話か(画面には出さない。テスト・確認用) */
export type Rumor =
  | { kind: 'stairs'; floor: number; dir: Dir; truth: boolean }
  | { kind: 'monster'; floor: number; monster: string; truth: boolean }
  | { kind: 'chests'; floor: number; n: number; truth: boolean }
  | { kind: 'thief'; claim: boolean; truth: boolean }
  | { kind: 'dragon'; asleep: boolean; truth: boolean };

export interface UnitSnapshot {
  id: string;
  x: number;
  y: number;
  hp: number;
  mp: number;
  down: boolean;
  guard: boolean;
  watch: boolean;
  /** 気絶した味方を担いでいるか */
  carrying: boolean;
}

export interface TurnResult {
  state: GameState;
  events: GameEvent[];
  /** frames[0] がターン開始時、frames[t] が t ティック終了時 */
  frames: UnitSnapshot[][];
  /** 各フレームでの地形(扉の開閉で変わる。frames と同じ添字) */
  tiles?: string[][];
  /** 各フレームでの宝の状態(目的が宝探しのときだけ。frames と同じ添字) */
  treasure?: { at: Pos | null; holder?: string }[];
}

export const TICKS_PER_TURN = 8;
export const AP_PER_TURN = 8;
