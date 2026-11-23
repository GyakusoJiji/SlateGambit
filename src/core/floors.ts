// 階の移動。階段を行き先に選んだ誰か 1 人が階段でターンを終えると、パーティ全員(気絶者を含む)がその階へ移る。
// 今の階の地形・敵・探索済み範囲は state.floors に退避し、戻ってきたときにそのまま再現する。
import { MONSTERS } from '../data/units';
import { RULES } from './actions';
import { chestGold, DIFFICULTY, FLOORS, generateFloor, MONSTER_GEN, placeParty } from './generate';
import { chebyshev, manhattan, tileAt } from './map';
import type { Rng } from './rng';
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
 * p の階段を使ったときに移る先の階。下り階段('>')なら下の階、上り階段('S')なら上の階。
 * 階段でない、または地下 1 階の 'S'(地上への出口。秘宝を持っていれば勝ち)なら null
 */
export function stairsDest(state: GameState, p: Pos): number | null {
  const cur = currentFloor(state);
  const t = tileAt(state.map, p.x, p.y);
  return t === '>' && cur < FLOORS ? cur + 1 : t === 'S' && cur > 1 ? cur - 1 : null;
}

/**
 * ターンの終わりの階段の判定。階段を使う予約(users)をした立っている味方が階段の上にいれば、全員で移る。
 * 階段を通り過ぎた・たまたま止まっただけの味方では移らない。移ったら true
 */
export function applyStairs(state: GameState, events: GameEvent[], users: ReadonlySet<string>): boolean {
  const cur = currentFloor(state);
  for (const u of state.units) {
    if (u.side !== 'party' || u.down || !users.has(u.id)) continue;
    const to = stairsDest(state, u);
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

/**
 * 休憩の物音: 戦闘中でなく、休憩で実際に回復したターンに、一定の確率で遠くから敵が現れる。
 * 現れた敵は、すでにパーティの居場所へ向かっている(警戒状態)。休憩するほど危険が近づく。
 * 確率は、その階の休憩に使った割合(休憩のティック数 ÷ 全ティック)に比例する
 */
export function applyWander(state: GameState, rng: Rng, restShare: number, events: GameEvent[]): void {
  // 固定遭遇では起きない(部屋の中だけで比べるため)
  if (RULES.wanderChance <= 0 || restShare <= 0 || state.scenario) return;
  if (!events.some((e) => e.type === 'rest' && (e.hp > 0 || e.mp > 0))) return;
  const k = DIFFICULTY[state.difficulty ?? 'normal'].wander;
  if (rng.next() >= RULES.wanderChance * k * restShare) return;
  const count = spawnFoes(state, rng, RULES.wanderBudget + currentFloor(state), `w${state.turn}_`, RULES.wanderDistance);
  if (count > 0) events.push({ tick: TICKS_PER_TURN, type: 'wander', count });
}

/**
 * 遠く(どの味方からもマンハッタン距離 minDistance 以上。無ければなるべく遠く)の 1 か所の周りに、
 * 点数 budget 分の敵を出す。敵はすでにパーティの居場所へ向かっている(警戒状態)。出した数を返す
 */
export function spawnFoes(state: GameState, rng: Rng, budget: number, idTag: string, minDistance: number): number {
  const floor = currentFloor(state);
  const party = state.units.filter((u) => u.side === 'party' && !u.down);
  if (party.length === 0) return 0;
  const { map } = state;
  const taken = new Set(state.units.filter((u) => !u.down).map((u) => `${u.x},${u.y}`));
  const cells: { p: Pos; d: number }[] = [];
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      if (tileAt(map, x, y) !== '.' || taken.has(`${x},${y}`)) continue;
      cells.push({ p: { x, y }, d: Math.min(...party.map((m) => manhattan(m, { x, y }))) });
    }
  }
  let far = cells.filter((c) => c.d >= minDistance).map((c) => c.p);
  // 狭い地図(固定遭遇など)では、最も遠いマスの近くから出す
  if (far.length === 0 && cells.length > 0) {
    const max = Math.max(...cells.map((c) => c.d));
    far = cells.filter((c) => c.d >= max - 2).map((c) => c.p);
  }
  if (far.length === 0) return 0;
  const kinds = Object.keys(MONSTER_GEN).filter((t) => floor >= MONSTER_GEN[t].from && floor <= (MONSTER_GEN[t].to ?? 99) && t !== 'ogre');
  const origin = far[rng.int(0, far.length - 1)];
  const target = [...party].sort((a, b) => manhattan(a, origin) - manhattan(b, origin))[0];
  let count = 0;
  while (budget >= 1) {
    const opts = kinds.filter((t) => MONSTER_GEN[t].cost <= budget);
    if (opts.length === 0) break;
    const weights = opts.map((t) => MONSTER_GEN[t].weight);
    let x = rng.next() * weights.reduce((a, b) => a + b, 0);
    let t = opts[opts.length - 1];
    for (let i = 0; i < opts.length; i++) if ((x -= weights[i]) < 0) { t = opts[i]; break; }
    // 最初の位置の近く(2 マス以内)の空いた床に置く
    const near = far.filter((p) => !taken.has(`${p.x},${p.y}`) && chebyshev(p, origin) <= 2);
    if (near.length === 0) break;
    const p = near[rng.int(0, near.length - 1)];
    const m = MONSTERS[t];
    count++;
    state.units.push({
      id: `${floor > 1 ? floor : ''}${idTag}${count}`,
      side: 'enemy',
      defId: t,
      name: m.name,
      x: p.x,
      y: p.y,
      hp: m.maxHp,
      mp: m.maxMp,
      down: false,
      ai: { mode: 'idle', alerted: true, lastSeen: { x: target.x, y: target.y } },
    });
    taken.add(`${p.x},${p.y}`);
    budget -= MONSTER_GEN[t].cost;
  }
  return count;
}
