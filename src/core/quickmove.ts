// クイック移動: 敵が見えない間、先頭のキャラが行き先へ向かい、残りは隊列を組んで後をついていく 1 ターン分の計画。
import { AP_PER_TURN, type Action, type GameState, type Plans, type Pos, type Unit } from './types';
import { RULES } from './actions';
import { pathTo } from './path';
import { manhattan } from './map';

/**
 * leaderId のキャラを先頭に、target へ向かう全員の計画を返す。先頭がすでに着いている・行けない場合は null。
 * 後続は order(味方の ID の並び)の順に並ぶ。order が無ければ先頭に近い順。
 * 各自は 1 人前の者の出発点へ向かってから同じ経路をなぞる(1 マスずつ遅れてついていく)。
 * すべての移動に「発見で停止」を付けるので、新しい敵が見えたら止まる。
 */
export function quickMovePlans(state: GameState, leaderId: string, target: Pos, order?: string[] | null): Plans | null {
  const { map } = state;
  const party = state.units.filter((u) => u.side === 'party' && !u.down);
  const leader = party.find((u) => u.id === leaderId) ?? party[0];
  if (!leader) return null;
  const leadPath = pathTo(map, leader, target);
  if (!leadPath || leadPath.length === 0) return null;

  const steps = (u: Unit) => Math.floor(AP_PER_TURN / (u.carrying ? RULES.carryMoveCost : 1));
  const moves = (u: Unit, dirs: typeof leadPath): Action[] =>
    dirs.slice(0, steps(u)).map((d) => ({ type: 'move', dir: d, stop: true, slow: u.carrying ? true : undefined }));

  const plans: Plans = { [leader.id]: moves(leader, leadPath) };
  const rest = party.filter((u) => u !== leader).sort((a, b) => manhattan(a, leader) - manhattan(b, leader));
  if (order) {
    // 指定された順に並べ替える(order に無い者は最後、その中では近い順のまま)
    const rank = (u: Unit) => (order.includes(u.id) ? order.indexOf(u.id) : order.length);
    rest.sort((a, b) => rank(a) - rank(b));
  }
  let prev: { start: Pos; dirs: typeof leadPath } = { start: { x: leader.x, y: leader.y }, dirs: leadPath };
  for (const u of rest) {
    const toPrev = pathTo(map, u, prev.start) ?? [];
    const dirs = [...toPrev, ...prev.dirs];
    plans[u.id] = moves(u, dirs);
    prev = { start: { x: u.x, y: u.y }, dirs };
  }
  return plans;
}
