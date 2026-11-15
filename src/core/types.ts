// ルールエンジンの型定義。DOM に依存しない。

export interface Pos {
  x: number;
  y: number;
}

export type Dir = 'N' | 'E' | 'S' | 'W';

export type Side = 'party' | 'enemy';

/** マップのタイル。'#'=壁, '.'=床, '+'=扉(開), 'S'=入口階段, 'H'=回復の泉 */
export type TileChar = '#' | '.' | '+' | 'S' | 'H';

export interface FloorMap {
  w: number;
  h: number;
  /** h 行・各 w 文字 */
  tiles: string[];
}

export type SpellId = 'fireball' | 'heal' | 'revive';

export interface AiMemory {
  mode: 'idle' | 'patrol';
  patrol?: Pos[];
  patrolIndex?: number;
  alerted?: boolean;
  lastSeen?: Pos;
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
  /** 担いでいる気絶した味方の ID */
  carrying?: string;
  /** 気絶中に、担がれたままターンを終えた連続回数(降ろされると 0 に戻る) */
  carriedTurns?: number;
  ai?: AiMemory;
}

export type GameStatus = 'playing' | 'won' | 'lost';

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * ゲームの目的。
 * - annihilate: 敵の全滅
 * - treasure: 宝を拾い、持ったまま入口の階段('S')に戻る。at=床に置かれている位置、holder=持っている味方
 */
export type Objective = { kind: 'annihilate' } | { kind: 'treasure'; at: Pos | null; holder?: string };

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
}

// ---- 行動(予約リストの要素) ----

export type Action =
  /** slow: 担いでいる間の移動(1 マス 2 AP) */
  | { type: 'move'; dir: Dir; stop?: boolean; slow?: boolean }
  | { type: 'attack'; target: string }
  /** 接近攻撃: 届かなければ近づき、届けば構えて攻撃する。残り AP をすべて使い、続けて攻撃する */
  | { type: 'charge'; target: string; ticks: number }
  | { type: 'carry'; target: string }
  | { type: 'drop' }
  | { type: 'guard' }
  | { type: 'wait' }
  | { type: 'spell'; spell: SpellId; target?: string; tile?: Pos }
  | { type: 'overwatch'; ticks: number }
  | { type: 'intercept'; ticks: number }
  | { type: 'follow'; target: string; ticks: number }
  | { type: 'escort'; target: string; ticks: number };

export type Plans = Record<string, Action[]>;

// ---- 解決結果 ----

export type StrikeKind = 'melee' | 'ranged' | 'fireball' | 'heal' | 'revive';

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
      reaction?: boolean;
    }
  | { tick: number; type: 'fizzle'; id: string; reason: string }
  | { tick: number; type: 'damage'; id: string; amount: number; by: string; guarded: boolean }
  | { tick: number; type: 'heal'; id: string; amount: number }
  | { tick: number; type: 'down'; id: string }
  | { tick: number; type: 'revive'; id: string }
  | { tick: number; type: 'rest'; id: string; hp: number; mp: number }
  | { tick: number; type: 'carry'; id: string; target: string }
  | { tick: number; type: 'drop'; id: string; target: string }
  | { tick: number; type: 'spring'; id: string; revived: boolean }
  /** 担がれている間に意識を取り戻した */
  | { tick: number; type: 'wake'; id: string }
  /** 宝を拾った(got=true)/気絶して落とした(got=false) */
  | { tick: number; type: 'treasure'; id: string; got: boolean; at: Pos };

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
  /** 各フレームでの宝の状態(目的が宝探しのときだけ。frames と同じ添字) */
  treasure?: { at: Pos | null; holder?: string }[];
}

export const TICKS_PER_TURN = 8;
export const AP_PER_TURN = 8;
