// レベルによる能力値の補正と、経験値・レベルアップの処理。
import { EXP_TABLE, MAX_LEVEL, SPELL_GROWTH, unitDef, type UnitDef } from '../data/units';
import { TICKS_PER_TURN, type GameEvent, type Unit } from './types';

const cache = new Map<string, UnitDef>();

/**
 * レベルの補正を加えた能力値。最大 HP・MP・攻撃力が変わる。
 * 名前・射程・視界などレベルで変わらない値だけを使うなら unitDef でよい
 */
export function stats(u: { defId: string; level?: number }): UnitDef {
  const d = unitDef(u.defId);
  const lv = (u.level ?? 1) - 1;
  if (lv <= 0 || !d.growth) return d;
  const k = `${u.defId}:${lv}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const s = { ...d, maxHp: d.maxHp + d.growth.hp * lv, maxMp: d.maxMp + d.growth.mp * lv, atk: d.atk + d.growth.atk * lv };
  cache.set(k, s);
  return s;
}

/** 魔法の威力の補正(パーティの魔法だけがレベルで強くなる) */
export function spellBonus(u: { side: string; level?: number }): number {
  return u.side === 'party' ? ((u.level ?? 1) - 1) * SPELL_GROWTH : 0;
}

/** 累計経験値から決まるレベル */
export function levelFor(exp: number): number {
  let lv = 1;
  while (lv < MAX_LEVEL && exp >= EXP_TABLE[lv]) lv++;
  return lv;
}

/** 次のレベルまでの進み具合(0〜1)。上限なら 1 */
export function expProgress(u: Unit): { level: number; ratio: number; toNext: number } {
  const level = u.level ?? 1;
  if (level >= MAX_LEVEL) return { level, ratio: 1, toNext: 0 };
  const exp = u.exp ?? 0;
  const lo = EXP_TABLE[level - 1];
  const hi = EXP_TABLE[level];
  return { level, ratio: Math.max(0, Math.min(1, (exp - lo) / (hi - lo))), toNext: hi - exp };
}

/**
 * 経験値を全員(気絶者を含む)に加え、しきい値を超えたらレベルを上げる。
 * 最大 HP・MP が増えた分だけ、立っている者の現在値も増やす
 */
export function gainExp(units: Unit[], amount: number, events: GameEvent[]): void {
  if (amount <= 0) return;
  events.push({ tick: TICKS_PER_TURN, type: 'exp', amount });
  for (const u of units) {
    if (u.side !== 'party') continue;
    const before = stats(u);
    u.exp = (u.exp ?? 0) + amount;
    const lv = levelFor(u.exp);
    if (lv <= (u.level ?? 1)) continue;
    u.level = lv;
    const after = stats(u);
    if (!u.down) {
      u.hp += after.maxHp - before.maxHp;
      u.mp += after.maxMp - before.maxMp;
    }
    events.push({ tick: TICKS_PER_TURN, type: 'levelup', id: u.id, level: lv });
  }
}
