import { beforeEach, describe, expect, it } from 'vitest';
import { generateGame } from '../src/core/generate';
import { resolveTurn } from '../src/core/resolve';
import { planEnemies } from '../src/core/ai';
import { clearSave, loadGame, saveGame } from '../src/ui/save';

// テスト環境には localStorage が無いので、メモリ上の代わりを置く
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};

describe('自動保存', () => {
  beforeEach(() => store.clear());

  it('保存した状態をそのまま読み戻せ、続きを同じように解決できる', () => {
    const s0 = generateGame(42, 'normal');
    const s1 = resolveTurn(s0, planEnemies(s0)).state;
    saveGame(s1);
    const loaded = loadGame();
    expect(loaded).toEqual(s1);
    // 読み戻した状態から進めても、元の状態から進めたのと同じ結果になる
    const a = resolveTurn(s1, planEnemies(s1)).state;
    const b = resolveTurn(loaded!, planEnemies(loaded!)).state;
    expect(b).toEqual(a);
  });

  it('決着したゲームは保存を消す', () => {
    const s = generateGame(1, 'easy');
    saveGame(s);
    expect(loadGame()).not.toBeNull();
    saveGame({ ...s, status: 'won' });
    expect(loadGame()).toBeNull();
  });

  it('壊れた保存・版の違う保存は読まずに捨てる', () => {
    store.set('slate-gambit/save', '{broken');
    expect(loadGame()).toBeNull();
    store.set('slate-gambit/save', JSON.stringify({ version: 0, state: generateGame(1, 'easy') }));
    expect(loadGame()).toBeNull();
    expect(store.has('slate-gambit/save')).toBe(false);
    store.set('slate-gambit/save', JSON.stringify({ version: 1, state: { seed: 1 } }));
    expect(loadGame()).toBeNull();
    saveGame(generateGame(1, 'easy'));
    clearSave();
    expect(loadGame()).toBeNull();
  });
});
