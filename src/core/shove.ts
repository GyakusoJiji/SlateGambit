// 押し返し(重装ユニットが自分より小さい敵を 1 マス押して前進する)の共通ルール。
// 同時解決のエンジン(resolve.ts)・敵の経路(ai.ts)・予約画面の予測(ui/timeline.ts)が同じ判定を使う。
import { unitDef } from '../data/units';
import { RULES, type Step } from './actions';
import type { Unit } from './types';
import { isNeutral } from './vision';

/** u が target を移動で押し返せる体格関係か(地上の住人は押さない) */
export function canShove(u: Unit, target: Unit): boolean {
  if (!RULES.shoveSmaller || u.side === target.side || isNeutral(target)) return false;
  const du = unitDef(u.defId);
  const dt = unitDef(target.defId);
  return !!du.shove && (du.size ?? 2) > (dt.size ?? 2);
}

/**
 * 押し返した直後の踏ん張り: 次のティック(添字 at)に踏ん張りを差し込み、残りの予約を 1 ティック後ろへずらす。
 * ターンの長さは変えないので、最後の 1 ティック分の予約はこのターンには入らない。
 * 移動・防御・攻撃のどれが続いても同じように遅れる(押し続けられるのは 1 ターンに最大 4 回)
 */
export function delayAfterShove(list: Step[], at: number): void {
  if (at >= list.length) return;
  const n = list.length;
  list.splice(at, 0, { k: 'recover' });
  list.length = n;
}
