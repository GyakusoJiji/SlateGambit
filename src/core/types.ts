// ルールエンジンの型定義。DOM に依存しない。

export interface Pos {
  x: number;
  y: number;
}

export type Dir = 'N' | 'E' | 'S' | 'W';

export type Side = 'party' | 'enemy';

/** マップのタイル。'#'=壁, '.'=床, '+'=扉(開), 'S'=入口階段 */
export type TileChar = '#' | '.' | '+' | 'S';

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
  ai?: AiMemory;
}

export type GameStatus = 'playing' | 'won' | 'lost';

export interface GameState {
  seed: number;
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
  | { type: 'move'; dir: Dir; stop?: boolean }
  | { type: 'attack'; target: string }
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
  | { tick: number; type: 'rest'; id: string; hp: number; mp: number };

export interface UnitSnapshot {
  id: string;
  x: number;
  y: number;
  hp: number;
  mp: number;
  down: boolean;
  guard: boolean;
  watch: boolean;
}

export interface TurnResult {
  state: GameState;
  events: GameEvent[];
  /** frames[0] がターン開始時、frames[t] が t ティック終了時 */
  frames: UnitSnapshot[][];
}

export const TICKS_PER_TURN = 8;
export const AP_PER_TURN = 8;
