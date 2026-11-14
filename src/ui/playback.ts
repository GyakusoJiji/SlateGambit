// 同時解決結果(TurnResult)の再生。速度変更・一時停止・コマ送り・スキップ・再視聴に対応する。
import { TICKS_PER_TURN, type GameEvent, type GameState, type TurnResult, type UnitSnapshot } from '../core/types';
import { sideVisibleMask } from '../core/vision';
import type { Effect } from './renderer';

/** 1 ティックの再生時間(等速, ms) */
const TICK_MS = 650;

export class Playback {
  /** 0〜TICKS_PER_TURN の連続値 */
  t = 0;
  speed = 1;
  paused = false;
  /** 各フレーム時点のパーティ視界と、それまでの探索済み範囲 */
  readonly visible: Uint8Array[];
  readonly explored: Uint8Array[];

  constructor(
    readonly before: GameState,
    readonly result: TurnResult,
  ) {
    const map = before.map;
    this.visible = result.frames.map((f) => {
      const units = before.units.map((u) => {
        const s = f.find((x) => x.id === u.id)!;
        return { ...u, x: s.x, y: s.y, down: s.down };
      });
      return sideVisibleMask(map, units, 'party');
    });
    let acc = Uint8Array.from(before.explored);
    this.explored = this.visible.map((v) => {
      acc = acc.map((e, i) => e | v[i]);
      return acc;
    });
  }

  get done(): boolean {
    return this.t >= TICKS_PER_TURN;
  }

  update(dtMs: number): void {
    if (this.paused || this.done) return;
    this.t = Math.min(TICKS_PER_TURN, this.t + (dtMs * this.speed) / TICK_MS);
  }

  stepOnce(): void {
    this.paused = true;
    this.t = Math.min(TICKS_PER_TURN, Math.floor(this.t + 1e-6) + 1);
  }

  skip(): void {
    this.t = TICKS_PER_TURN;
  }

  restart(): void {
    this.t = 0;
    this.paused = false;
  }

  /** 現在のティック番号(1 始まり)と、そのティック内の進み具合 */
  private phase(): { tick: number; frac: number } {
    if (this.done) return { tick: TICKS_PER_TURN, frac: 1 };
    const i = Math.floor(this.t);
    return { tick: i + 1, frac: this.t - i };
  }

  /** 表示用のユニット状態(移動はティック前半、攻撃の結果は後半に反映) */
  units(): (UnitSnapshot & { fx: number; fy: number })[] {
    const { tick, frac } = this.phase();
    const a = this.result.frames[tick - 1];
    const b = this.result.frames[tick];
    const m = ease(Math.min(1, frac * 2));
    return a.map((s, i) => {
      const e = b[i];
      const late = frac >= 0.5;
      return {
        ...(late ? e : { ...s, guard: e.guard, watch: e.watch }),
        x: e.x,
        y: e.y,
        fx: s.x + (e.x - s.x) * m,
        fy: s.y + (e.y - s.y) * m,
      };
    });
  }

  frameIndex(): number {
    const { tick, frac } = this.phase();
    return frac >= 0.5 ? tick : tick - 1;
  }

  effects(): Effect[] {
    const { tick, frac } = this.phase();
    if (frac < 0.5) return [];
    const k = (frac - 0.5) * 2;
    const alpha = 1 - k * 0.8;
    const out: Effect[] = [];
    const posOf = (id: string) => {
      const s = this.result.frames[tick].find((x) => x.id === id)!;
      return { x: s.x, y: s.y };
    };
    for (const e of this.result.events) {
      if (e.tick !== tick) continue;
      if (e.type === 'strike') {
        const from = posOf(e.id);
        if (e.kind === 'ranged') out.push({ kind: 'line', from, to: e.end, color: '#ffe080', alpha });
        if (e.kind === 'melee') out.push({ kind: 'slash', at: e.end, alpha });
        if (e.kind === 'fireball') out.push({ kind: 'burst', at: e.end, radius: 1, color: '#ff7a20', alpha });
        if (e.kind === 'heal' || e.kind === 'revive') out.push({ kind: 'burst', at: e.end, radius: 0, color: '#60ff90', alpha });
      } else if (e.type === 'damage') {
        out.push({ kind: 'text', at: posOf(e.id), text: `-${e.amount}`, color: e.guarded ? '#9fd0ff' : '#ff6060', rise: 0.3 + k * 0.5, alpha: 1 });
      } else if (e.type === 'heal') {
        out.push({ kind: 'text', at: posOf(e.id), text: `+${e.amount}`, color: '#70ff90', rise: 0.3 + k * 0.5, alpha: 1 });
      } else if (e.type === 'fizzle') {
        out.push({ kind: 'text', at: posOf(e.id), text: 'miss', color: '#c0c0c0', rise: 0.3 + k * 0.4, alpha });
      } else if (e.type === 'halt') {
        out.push({ kind: 'text', at: posOf(e.id), text: '!', color: '#ffd24d', rise: 0.5, alpha: 1 });
      }
    }
    return out;
  }

  /** 現在までに起きた出来事 */
  eventsSoFar(): GameEvent[] {
    const { tick, frac } = this.phase();
    return this.result.events.filter((e) => e.tick < tick || (e.tick === tick && frac >= 0.5));
  }

  currentTick(): number {
    return this.phase().tick;
  }
}

function ease(x: number): number {
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
}
