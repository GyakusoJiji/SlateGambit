// 自動保存: ターン終了ごとに、進行中のゲームの状態をブラウザ内(localStorage)へ保存する。
// 開き直したときにこれがあれば、続きから遊べる。決着したゲームは消す。
import type { GameState } from '../core/types';

const SAVE_KEY = 'slate-gambit/save';
/** 保存形式の版。GameState の形を互換性なく変えたら上げる(古い保存は読まずに捨てる) */
const SAVE_VERSION = 1;

interface SaveData {
  version: number;
  savedAt: number;
  state: GameState;
}

export function saveGame(state: GameState): void {
  try {
    if (state.status !== 'playing') {
      localStorage.removeItem(SAVE_KEY);
      return;
    }
    const data: SaveData = { version: SAVE_VERSION, savedAt: Date.now(), state };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // 保存できない環境(プライベートモードなど)では保存しない
  }
}

/** 続きから遊べる保存があれば返す */
export function loadGame(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    if (data.version !== SAVE_VERSION || !isGameState(data.state) || data.state.status !== 'playing') {
      localStorage.removeItem(SAVE_KEY);
      return null;
    }
    return data.state;
  } catch {
    return null;
  }
}

export function clearSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // 何もしない
  }
}

/** 壊れた保存で落ちないよう、最低限の形だけ確かめる */
function isGameState(s: unknown): s is GameState {
  const g = s as GameState;
  return (
    !!g &&
    typeof g.seed === 'number' &&
    typeof g.turn === 'number' &&
    typeof g.rng === 'number' &&
    !!g.map &&
    Array.isArray(g.map.tiles) &&
    g.map.tiles.length === g.map.h &&
    Array.isArray(g.units) &&
    Array.isArray(g.explored) &&
    g.explored.length === g.map.w * g.map.h
  );
}
