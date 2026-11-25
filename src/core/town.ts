// 地上の町(階 0)。通路だけの迷路に、宿・馬小屋・道具屋・療養所と、地下 1 階への下り階段を置く。
// 施設は通れるマス(視線も遮らない)で、立っている味方が施設のマスにいて敵が見えなければ使える(controller.ts)。
import { ITEMS } from '../data/units';
import { DIR_LIST, isWalkable, step } from './map';
import { Rng, hashSeed } from './rng';
import { stats } from './stats';
import type { FloorMap, GameState, ItemId, Pos, Unit } from './types';

/** 施設の種類と、地図のタイル文字 */
export type FacilityId = 'inn' | 'stable' | 'shop' | 'clinic';
export const FACILITY_TILE: Record<FacilityId, string> = { inn: 'I', stable: 'B', shop: 'T', clinic: 'C' };
const TILE_FACILITY: Record<string, FacilityId> = { I: 'inn', B: 'stable', T: 'shop', C: 'clinic' };

/** タイル文字が施設なら、その種類 */
export function facilityOf(tile: string): FacilityId | null {
  return TILE_FACILITY[tile] ?? null;
}

/** 施設の値段など(自動対戦で調整する) */
export const TOWN = {
  /** 宿: 泊まる味方のレベルの合計 × この額 */
  innPerLevel: 5,
  /** 馬小屋: HP をこの割合まで回復する(MP は回復しない) */
  stableHpRatio: 0.5,
  /** 療養所: 気絶した味方 1 人を復帰させる額(× そのキャラのレベル) */
  clinicPerLevel: 30,
  /** 迷路に足す抜け道の数(行き止まりばかりにならないように) */
  loops: 14,
};

export interface Town {
  map: FloorMap;
  /** 町の入口(新しいゲームの開始位置) */
  start: Pos;
  /** 地下 1 階への下り階段 */
  down: Pos;
  facilities: Record<FacilityId, Pos>;
}

/**
 * 地上の迷路を作る。奇数の座標を通路のマスにした穴掘り法の迷路に、抜け道を少し足す。
 * 下り階段は行き止まりの 1 つに置き、町の入口はそこから最も遠い行き止まり、
 * 施設は下り階段からの歩数が中ほど〜遠めの行き止まりに散らす
 */
export function generateTown(seed: number, w: number, h: number): Town {
  const rng = new Rng(hashSeed('town', seed));
  const tiles = Array.from({ length: h }, () => new Array<string>(w).fill('#'));
  const cw = Math.floor((w - 1) / 2);
  const ch = Math.floor((h - 1) / 2);
  const cell = (cx: number, cy: number): Pos => ({ x: cx * 2 + 1, y: cy * 2 + 1 });

  // 穴掘り法(深さ優先)
  const seen = new Set<string>();
  const stack: [number, number][] = [[rng.int(0, cw - 1), rng.int(0, ch - 1)]];
  seen.add(stack[0].join());
  const c0 = cell(...stack[0]);
  tiles[c0.y][c0.x] = '.';
  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const next = ([[1, 0], [-1, 0], [0, 1], [0, -1]] as const)
      .map(([dx, dy]) => [cx + dx, cy + dy] as [number, number])
      .filter(([x, y]) => x >= 0 && y >= 0 && x < cw && y < ch && !seen.has(`${x},${y}`));
    if (next.length === 0) {
      stack.pop();
      continue;
    }
    const [nx, ny] = next[rng.int(0, next.length - 1)];
    seen.add(`${nx},${ny}`);
    const a = cell(cx, cy);
    const b = cell(nx, ny);
    tiles[(a.y + b.y) / 2][(a.x + b.x) / 2] = '.';
    tiles[b.y][b.x] = '.';
    stack.push([nx, ny]);
  }

  // 抜け道: 両側が通路の壁を少し開ける
  for (let i = 0, made = 0; i < 400 && made < TOWN.loops; i++) {
    const x = rng.int(1, w - 2);
    const y = rng.int(1, h - 2);
    if (tiles[y][x] !== '#') continue;
    const horiz = tiles[y][x - 1] === '.' && tiles[y][x + 1] === '.' && tiles[y - 1][x] === '#' && tiles[y + 1][x] === '#';
    const vert = tiles[y - 1][x] === '.' && tiles[y + 1][x] === '.' && tiles[y][x - 1] === '#' && tiles[y][x + 1] === '#';
    if (!horiz && !vert) continue;
    tiles[y][x] = '.';
    made++;
  }

  const map: FloorMap = { w, h, tiles: tiles.map((r) => r.join('')) };
  const deadEnds: Pos[] = [];
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      if (map.tiles[y][x] !== '.') continue;
      const open = DIR_LIST.filter((d) => {
        const n = step({ x, y }, d);
        return isWalkable(map, n.x, n.y);
      }).length;
      if (open === 1) deadEnds.push({ x, y });
    }

  const down = deadEnds[rng.int(0, deadEnds.length - 1)];
  const dist = walkDistances(map, down);
  const d = (p: Pos) => dist[p.y * w + p.x];
  const others = deadEnds.filter((p) => p !== down).sort((a, b) => d(a) - d(b));
  const start = others[others.length - 1];
  const max = d(start);
  // 施設: 歩数が下り階段から最大の 35〜85% 付近の行き止まり(重ならないよう順に選ぶ)
  const used = new Set<Pos>([down, start]);
  const pick = (ratio: number): Pos => {
    const free = others.filter((p) => !used.has(p));
    const p = free.sort((a, b) => Math.abs(d(a) - max * ratio) - Math.abs(d(b) - max * ratio))[0];
    used.add(p);
    return p;
  };
  const facilities: Record<FacilityId, Pos> = { inn: pick(0.85), stable: pick(0.6), shop: pick(0.7), clinic: pick(0.45) };

  const set = (p: Pos, c: string) => {
    const row = map.tiles[p.y];
    map.tiles[p.y] = row.slice(0, p.x) + c + row.slice(p.x + 1);
  };
  set(down, '>');
  for (const [id, p] of Object.entries(facilities) as [FacilityId, Pos][]) set(p, FACILITY_TILE[id]);
  return { map, start, down, facilities };
}

// ---- 施設の利用(状態を直接書き換える。時間は進まない) ----

const standing = (state: GameState) => state.units.filter((u) => u.side === 'party' && !u.down);

/** 宿代: 泊まる(立っている)味方のレベルの合計 × TOWN.innPerLevel */
export function innCost(state: GameState): number {
  return standing(state).reduce((a, u) => a + (u.level ?? 1), 0) * TOWN.innPerLevel;
}

/** 回復する余地がある(HP か MP が減っている)立っている味方がいるか */
export function anyTired(state: GameState): boolean {
  return standing(state).some((u) => u.hp < stats(u).maxHp || u.mp < stats(u).maxMp);
}

/** 宿に泊まる: 立っている全員の HP・MP を全快する。泊まれたら true */
export function useInn(state: GameState): boolean {
  const cost = innCost(state);
  if ((state.gold ?? 0) < cost || !anyTired(state)) return false;
  state.gold = (state.gold ?? 0) - cost;
  for (const u of standing(state)) {
    const d = stats(u);
    u.hp = d.maxHp;
    u.mp = d.maxMp;
  }
  return true;
}

/** 馬小屋で休む(無料): 立っている全員の HP を最大の TOWN.stableHpRatio まで戻す。回復した者がいれば true */
export function useStable(state: GameState): boolean {
  let any = false;
  for (const u of standing(state)) {
    const to = Math.ceil(stats(u).maxHp * TOWN.stableHpRatio);
    if (u.hp >= to) continue;
    u.hp = to;
    any = true;
  }
  return any;
}

/** 療養所の費用(その味方のレベル × TOWN.clinicPerLevel) */
export function clinicCost(u: Unit): number {
  return (u.level ?? 1) * TOWN.clinicPerLevel;
}

/**
 * 療養所: 気絶した味方 1 人を復帰させ、HP・MP を全快する。担がれていれば降ろし、
 * ほかの立っている味方と同じマスにいれば、近くの空いた床へずらす。復帰できたら true
 */
export function useClinic(state: GameState, id: string): boolean {
  const u = state.units.find((x) => x.id === id && x.side === 'party' && x.down);
  if (!u) return false;
  const cost = clinicCost(u);
  if ((state.gold ?? 0) < cost) return false;
  state.gold = (state.gold ?? 0) - cost;
  for (const c of state.units) if (c.carrying === u.id) c.carrying = undefined;
  const d = stats(u);
  u.down = false;
  u.downTurn = undefined;
  u.carriedTurns = undefined;
  u.hp = d.maxHp;
  u.mp = d.maxMp;
  const taken = (p: Pos) => state.units.some((o) => o !== u && !o.down && o.x === p.x && o.y === p.y);
  if (taken(u)) {
    const dist = walkDistances(state.map, u);
    let best: Pos | null = null;
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] <= 0) continue;
      const p = { x: i % state.map.w, y: Math.floor(i / state.map.w) };
      if (taken(p) || (best && dist[i] >= dist[best.y * state.map.w + best.x])) continue;
      best = p;
    }
    if (best) {
      u.x = best.x;
      u.y = best.y;
    }
  }
  return true;
}

/** 道具屋で 1 つ買う。買えたら true */
export function buyItem(state: GameState, k: ItemId): boolean {
  const price = ITEMS[k].price;
  if ((state.gold ?? 0) < price) return false;
  state.gold = (state.gold ?? 0) - price;
  state.items = { ...state.items, [k]: (state.items?.[k] ?? 0) + 1 };
  return true;
}

/** 立っている味方が施設のマスにいれば、その施設(複数あれば最初の 1 つ) */
export function facilityHere(state: GameState): FacilityId | null {
  for (const u of standing(state)) {
    const f = facilityOf(state.map.tiles[u.y]?.[u.x] ?? '#');
    if (f) return f;
  }
  return null;
}

/** 歩数の距離(届かないマスは -1) */
function walkDistances(map: FloorMap, from: Pos): number[] {
  const dist = new Array<number>(map.w * map.h).fill(-1);
  dist[from.y * map.w + from.x] = 0;
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    for (const dir of DIR_LIST) {
      const s = step(q[i], dir);
      if (!isWalkable(map, s.x, s.y) || dist[s.y * map.w + s.x] >= 0) continue;
      dist[s.y * map.w + s.x] = dist[q[i].y * map.w + q[i].x] + 1;
      q.push(s);
    }
  }
  return dist;
}
