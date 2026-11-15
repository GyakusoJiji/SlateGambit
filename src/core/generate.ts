// ゲームごとのランダムなマップと配置の生成。シードと難易度から決定的に作る。
// 部屋を置いて通路でつなぎ(必ず全域がつながる)、入口・泉・宝・敵を配置する。
import { CLASSES, MONSTERS } from '../data/units';
import { DIR_LIST, isWalkable, manhattan, step } from './map';
import { Rng, hashSeed } from './rng';
import type { AiMemory, Difficulty, FloorMap, GameState, Objective, Pos, Unit } from './types';
import { updateExplored } from './vision';

export const MAP_W = 40;
export const MAP_H = 30;

/** 敵の点数(強さの目安)。ボスのドラゴンは別枠で必ず 1 体置く */
const COST: Record<string, number> = { goblin: 2, archer: 2, orc: 4, ogre: 7 };
const DRAGON_COST = 7;

/**
 * 難易度ごとの敵の量。budget=敵の点数の合計、group=1 部屋の点数の上限、ogres=オーガの最大数、
 * callRange=敵が仲間を呼ぶ範囲。自動対戦の勝率が Easy 95% / Normal 75% / Hard 50% 前後になるよう調整する
 */
export const DIFFICULTY: Record<Difficulty, { budget: number; group: number; ogres: number }> = {
  easy: { budget: 13, group: 7, ogres: 0 },
  normal: { budget: 25, group: 9, ogres: 1 },
  hard: { budget: 34, group: 12, ogres: 2 },
};

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

const center = (r: Room): Pos => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });
const inRoom = (r: Room, p: Pos) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

export function generateGame(seed: number, difficulty: Difficulty = 'normal', objectiveKind?: Objective['kind']): GameState {
  const rng = new Rng(hashSeed('map', seed));
  const { tiles, rooms } = carveRooms(rng);
  const map: FloorMap = { w: MAP_W, h: MAP_H, tiles: tiles.map((r) => r.join('')) };

  // 入口の部屋はランダム。そこからの歩数で、宝(最も遠い部屋)と泉(中ほどの部屋)を決める
  const startRoom = rooms[rng.int(0, rooms.length - 1)];
  const entrance = center(startRoom);
  const dist = bfs(map, entrance);
  const d = (p: Pos) => dist[p.y * MAP_W + p.x];
  const others = rooms.filter((r) => r !== startRoom).sort((a, b) => d(center(a)) - d(center(b)));
  const treasureRoom = others[others.length - 1];
  const springRoom = others[Math.floor(others.length / 2) - 1] ?? others[0];
  setTile(map, entrance, 'S');
  const spring = randomCell(rng, springRoom, map, [center(springRoom)]);
  setTile(map, spring, 'H');

  const kind = objectiveKind ?? (rng.next() < 0.5 ? 'annihilate' : 'treasure');
  const treasureAt = center(treasureRoom);
  const objective: Objective = kind === 'treasure' ? { kind, at: treasureAt } : { kind };

  // パーティは入口の周り
  const taken = new Set<string>([key(entrance)]);
  const partyCells = nearestCells(map, entrance, 4, taken);
  const party: Unit[] = (['warrior', 'thief', 'mage', 'priest'] as const).map((defId, i) => {
    const c = CLASSES[defId];
    const p = partyCells[i];
    taken.add(key(p));
    return { id: `p${i + 1}`, side: 'party', defId, name: c.name, x: p.x, y: p.y, hp: c.maxHp, mp: c.maxMp, down: false };
  });

  const enemies = placeEnemies(rng, map, rooms, startRoom, treasureRoom, kind, difficulty, d, taken);

  const state: GameState = {
    seed,
    difficulty,
    objective,
    rng: hashSeed('play', seed),
    turn: 1,
    map,
    units: [...party, ...enemies],
    explored: new Array(MAP_W * MAP_H).fill(0),
    status: 'playing',
  };
  updateExplored(state);
  return state;
}

// ---- 地形 ----

function carveRooms(rng: Rng): { tiles: string[][]; rooms: Room[] } {
  for (;;) {
    const tiles = Array.from({ length: MAP_H }, () => new Array<string>(MAP_W).fill('#'));
    const rooms: Room[] = [];
    for (let tries = 0; tries < 400 && rooms.length < 10; tries++) {
      const w = rng.int(5, 10);
      const h = rng.int(4, 7);
      const r = { x: rng.int(1, MAP_W - w - 1), y: rng.int(1, MAP_H - h - 1), w, h };
      // 部屋どうしは壁 2 マス以上離す(間に通路が通れるように)
      if (rooms.some((o) => r.x < o.x + o.w + 2 && o.x < r.x + r.w + 2 && r.y < o.y + o.h + 2 && o.y < r.y + r.h + 2)) continue;
      rooms.push(r);
    }
    if (rooms.length < 7) continue;
    for (const r of rooms) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) tiles[y][x] = '.';

    // 最小全域木でつなぎ、さらに近い部屋どうしを 2 本つないで回り道を作る
    const edges: [number, number][] = [];
    const inTree = new Set([0]);
    while (inTree.size < rooms.length) {
      let best: [number, number] | null = null;
      let bd = Infinity;
      for (const a of inTree)
        for (let b = 0; b < rooms.length; b++) {
          if (inTree.has(b)) continue;
          const dd = manhattan(center(rooms[a]), center(rooms[b]));
          if (dd < bd) {
            bd = dd;
            best = [a, b];
          }
        }
      edges.push(best!);
      inTree.add(best![1]);
    }
    for (let k = 0; k < 2; k++) {
      const a = rng.int(0, rooms.length - 1);
      const near = rooms
        .map((r, i) => ({ i, dd: manhattan(center(r), center(rooms[a])) }))
        .filter((o) => o.i !== a && !edges.some(([p, q]) => (p === a && q === o.i) || (p === o.i && q === a)))
        .sort((p, q) => p.dd - q.dd)[0];
      if (near) edges.push([a, near.i]);
    }
    for (const [a, b] of edges) corridor(tiles, center(rooms[a]), center(rooms[b]), rng.next() < 0.5);

    addPillars(rng, tiles, rooms);
    addDoors(tiles, rooms);
    return { tiles, rooms };
  }
}

function corridor(tiles: string[][], a: Pos, b: Pos, horizontalFirst: boolean): void {
  const dig = (x: number, y: number) => {
    if (tiles[y][x] === '#') tiles[y][x] = '.';
  };
  let { x, y } = a;
  const moveX = () => {
    while (x !== b.x) {
      x += Math.sign(b.x - x);
      dig(x, y);
    }
  };
  const moveY = () => {
    while (y !== b.y) {
      y += Math.sign(b.y - y);
      dig(x, y);
    }
  };
  if (horizontalFirst) {
    moveX();
    moveY();
  } else {
    moveY();
    moveX();
  }
}

/** 広い部屋に柱(遮蔽物)を置く。通れなくなる柱は置かない */
function addPillars(rng: Rng, tiles: string[][], rooms: Room[]): void {
  for (const r of rooms) {
    if (r.w < 7 || r.h < 5) continue;
    const n = rng.int(0, 2);
    for (let i = 0; i < n; i++) {
      const p = { x: rng.int(r.x + 1, r.x + r.w - 2), y: rng.int(r.y + 1, r.y + r.h - 2) };
      const c = center(r);
      if (p.x === c.x || p.y === c.y || tiles[p.y][p.x] !== '.') continue;
      tiles[p.y][p.x] = '#';
      if (!connected(tiles)) tiles[p.y][p.x] = '.';
    }
  }
}

function connected(tiles: string[][]): boolean {
  const map: FloorMap = { w: MAP_W, h: MAP_H, tiles: tiles.map((r) => r.join('')) };
  let start: Pos | null = null;
  let floors = 0;
  for (let y = 0; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++)
      if (tiles[y][x] !== '#') {
        floors++;
        start ??= { x, y };
      }
  if (!start) return false;
  return bfs(map, start).filter((v) => v >= 0).length === floors;
}

/** 部屋の外周で、通路が部屋へまっすぐ入るマスを扉にする */
function addDoors(tiles: string[][], rooms: Room[]): void {
  const open = (x: number, y: number) => x >= 0 && y >= 0 && x < MAP_W && y < MAP_H && tiles[y][x] !== '#';
  for (const r of rooms) {
    for (let y = r.y - 1; y <= r.y + r.h; y++)
      for (let x = r.x - 1; x <= r.x + r.w; x++) {
        if (inRoom(r, { x, y }) || tiles[y][x] !== '.') continue;
        const horiz = open(x - 1, y) && open(x + 1, y) && !open(x, y - 1) && !open(x, y + 1);
        const vert = open(x, y - 1) && open(x, y + 1) && !open(x - 1, y) && !open(x + 1, y);
        if (horiz || vert) tiles[y][x] = '+';
      }
  }
}

// ---- 配置 ----

function placeEnemies(
  rng: Rng,
  map: FloorMap,
  rooms: Room[],
  startRoom: Room,
  treasureRoom: Room,
  kind: Objective['kind'],
  difficulty: Difficulty,
  d: (p: Pos) => number,
  taken: Set<string>,
): Unit[] {
  const cfg = DIFFICULTY[difficulty];
  const units: Unit[] = [];
  const counts: Record<string, number> = {};
  const spawn = (defId: string, p: Pos, ai: AiMemory = { mode: 'idle' }) => {
    const m = MONSTERS[defId];
    counts[defId] = (counts[defId] ?? 0) + 1;
    const prefix = { goblin: 'g', archer: 'a', orc: 'o', ogre: 'b', dragon: 'd' }[defId] ?? 'e';
    units.push({ id: `${prefix}${counts[defId]}`, side: 'enemy', defId, name: m.name, x: p.x, y: p.y, hp: m.maxHp, mp: m.maxMp, down: false, ai });
    taken.add(key(p));
  };

  // 入口から近すぎる部屋には置かない
  const candidates = rooms.filter((r) => r !== startRoom && d(center(r)) >= 8);
  let budget = cfg.budget;
  let ogres = 0;
  const pickType = (room: number): string | null => {
    const opts = Object.keys(COST).filter((t) => COST[t] <= room && COST[t] <= budget && (t !== 'ogre' || ogres < cfg.ogres));
    if (opts.length === 0) return null;
    // 弱い敵ほど出やすい
    const weights = opts.map((t) => ({ goblin: 4, archer: 3, orc: 2, ogre: 1.5 })[t] ?? 1);
    let x = rng.next() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < opts.length; i++) if ((x -= weights[i]) < 0) return opts[i];
    return opts[opts.length - 1];
  };
  const fillRoom = (r: Room, points: number) => {
    let room = Math.min(points, budget);
    while (room >= 2 && budget >= 2) {
      const t = pickType(room);
      if (!t) break;
      const p = randomCell(rng, r, map, [], taken);
      if (!p) break;
      spawn(t, p);
      if (t === 'ogre') ogres++;
      room -= COST[t];
      budget -= COST[t];
    }
  };

  // ボスのドラゴンは入口から最も遠い部屋(宝探しでは宝の部屋)に 1 体。点数は予算から引く
  const lair = randomCell(rng, treasureRoom, map, [center(treasureRoom)], taken);
  if (lair) {
    spawn('dragon', lair);
    budget -= DRAGON_COST;
  }
  // 宝探しでは宝の部屋にドラゴン以外の番人も置く
  if (kind === 'treasure') fillRoom(treasureRoom, cfg.group - DRAGON_COST);
  const order = [...candidates].sort(() => rng.next() - 0.5);
  for (let i = 0; budget >= 2 && i < order.length * 3; i++) {
    const r = order[i % order.length];
    fillRoom(r, rng.int(2, cfg.group));
  }

  // 一部の敵は部屋の間を巡回する
  const movers = units.filter((u) => u.defId === 'goblin' || u.defId === 'orc');
  for (const u of movers.slice(0, Math.max(1, Math.floor(movers.length / 4)))) {
    const home = rooms.find((r) => inRoom(r, u))!;
    const away = candidates.filter((r) => r !== home)[rng.int(0, Math.max(0, candidates.length - 2))] ?? home;
    u.ai = { mode: 'patrol', patrol: [{ x: u.x, y: u.y }, center(away)], patrolIndex: 1 };
  }
  return units;
}

function randomCell(rng: Rng, r: Room, map: FloorMap, avoid: Pos[], taken?: Set<string>): Pos {
  for (let i = 0; i < 60; i++) {
    const p = { x: rng.int(r.x, r.x + r.w - 1), y: rng.int(r.y, r.y + r.h - 1) };
    if (map.tiles[p.y][p.x] !== '.' || avoid.some((a) => a.x === p.x && a.y === p.y) || taken?.has(key(p))) continue;
    return p;
  }
  return null as unknown as Pos;
}

function nearestCells(map: FloorMap, from: Pos, n: number, taken: Set<string>): Pos[] {
  const out: Pos[] = [];
  const seen = new Set([key(from)]);
  const q = [from];
  while (q.length && out.length < n) {
    const p = q.shift()!;
    for (const dir of DIR_LIST) {
      const s = step(p, dir);
      if (seen.has(key(s)) || !isWalkable(map, s.x, s.y)) continue;
      seen.add(key(s));
      q.push(s);
      if (!taken.has(key(s)) && map.tiles[s.y][s.x] === '.') out.push(s);
    }
  }
  return out;
}

/** 歩数の距離(届かないマスは -1) */
function bfs(map: FloorMap, from: Pos): number[] {
  const dist = new Array<number>(map.w * map.h).fill(-1);
  dist[from.y * map.w + from.x] = 0;
  const q = [from];
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    for (const dir of DIR_LIST) {
      const s = step(p, dir);
      if (!isWalkable(map, s.x, s.y) || dist[s.y * map.w + s.x] >= 0) continue;
      dist[s.y * map.w + s.x] = dist[p.y * map.w + p.x] + 1;
      q.push(s);
    }
  }
  return dist;
}

function setTile(map: FloorMap, p: Pos, c: string): void {
  const row = map.tiles[p.y];
  map.tiles[p.y] = row.slice(0, p.x) + c + row.slice(p.x + 1);
}

const key = (p: Pos) => `${p.x},${p.y}`;
