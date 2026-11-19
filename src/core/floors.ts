// 階の移動。誰か 1 人が階段に入ると、パーティ全員(気絶者を含む)がその階へ移る。
// 今の階の地形・敵・探索済み範囲は state.floors に退避し、戻ってきたときにそのまま再現する。
import { chestGold, FLOORS, generateFloor, placeParty } from './generate';
import { tileAt } from './map';
import { TICKS_PER_TURN, type GameEvent, type GameState, type Pos } from './types';
import { updateExplored } from './vision';

export function currentFloor(state: GameState): number {
  return state.floor ?? 1;
}

/** 今の階で、床に置かれている秘宝の位置(誰かが持っている・別の階にある・まだ無いときは null) */
export function treasureHere(state: GameState): Pos | null {
  const o = state.objective;
  if (o?.kind !== 'treasure' || !o.at) return null;
  return (o.floor ?? currentFloor(state)) === currentFloor(state) ? o.at : null;
}

export function findTile(map: GameState['map'], c: string): Pos | null {
  for (let y = 0; y < map.h; y++) {
    const x = map.tiles[y].indexOf(c);
    if (x >= 0) return { x, y };
  }
  return null;
}

/**
 * ターンの終わりの階段の判定。立っている味方が下り階段('>')にいれば下の階へ、
 * 上り階段('S')にいれば上の階へ移る。地下 1 階の 'S' は地上への出口なので移らない(秘宝を持っていれば勝ち)。
 * 移ったら true
 */
export function applyStairs(state: GameState, events: GameEvent[]): boolean {
  const cur = currentFloor(state);
  for (const u of state.units) {
    if (u.side !== 'party' || u.down) continue;
    const t = tileAt(state.map, u.x, u.y);
    const to = t === '>' && cur < FLOORS ? cur + 1 : t === 'S' && cur > 1 ? cur - 1 : null;
    if (to === null) continue;
    events.push({ tick: TICKS_PER_TURN, type: 'stairs', id: u.id, from: cur, to });
    changeFloor(state, to);
    return true;
  }
  return false;
}

/** パーティを別の階へ移す。下りなら上り階段の周り、上りなら下り階段の周りに着く */
export function changeFloor(state: GameState, to: number): void {
  const cur = currentFloor(state);
  const party = state.units.filter((u) => u.side === 'party');
  state.floors ??= {};
  state.floors[cur] = { map: state.map, enemies: state.units.filter((u) => u.side === 'enemy'), explored: state.explored };

  const saved = state.floors[to];
  if (saved) {
    delete state.floors[to];
    state.map = saved.map;
    state.units = [...party, ...saved.enemies];
    state.explored = saved.explored;
  } else {
    const g = generateFloor(state.seed, state.difficulty ?? 'normal', to);
    state.map = g.map;
    state.units = [...party, ...g.enemies];
    state.explored = new Array(g.map.w * g.map.h).fill(0);
    // 秘宝は地下 5 階を初めて作ったときに置く
    const o = state.objective;
    if (g.treasureAt && o?.kind === 'treasure' && !o.at && !o.holder) {
      o.at = g.treasureAt;
      o.floor = to;
    }
  }
  state.floor = to;
  state.deepest = Math.max(state.deepest ?? 1, to);
  const arrive = findTile(state.map, to > cur ? 'S' : '>');
  if (arrive) placeParty(state, arrive);
  updateExplored(state);
}

/** 立っている味方が宝箱('$')の上にいれば開けて('c' にする)、ゴールドを得る(通り抜けでも開く) */
export function openChests(state: GameState, events: GameEvent[], tick: number): void {
  for (const u of state.units) {
    if (u.side !== 'party' || u.down || tileAt(state.map, u.x, u.y) !== '$') continue;
    const at = { x: u.x, y: u.y };
    const gold = chestGold(state.seed, currentFloor(state), at);
    const row = state.map.tiles[at.y];
    state.map.tiles[at.y] = row.slice(0, at.x) + 'c' + row.slice(at.x + 1);
    state.gold = (state.gold ?? 0) + gold;
    events.push({ tick, type: 'chest', id: u.id, gold, at });
  }
}
