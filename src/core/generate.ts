// ゲームごとのランダムなダンジョン(地下 1〜5 階)と配置の生成。シード・難易度・階から決定的に作る。
// 部屋を置いて通路でつなぎ(必ず全域がつながる)、上り・下りの階段・泉・宝箱・敵を配置する。
// 階は初めて訪れたときに作る(floors.ts)。地下 5 階の最も奥の部屋には秘宝と、眠っているドラゴンがいる。
import { CLASSES, EXP_TABLE, MONSTERS } from '../data/units';
import { DIR_LIST, isWalkable, manhattan, step } from './map';
import { Rng, hashSeed } from './rng';
import { stats } from './stats';
import type { AiMemory, Difficulty, FloorMap, GameState, Pos, Unit } from './types';
import { updateExplored } from './vision';

export const MAP_W = 40;
export const MAP_H = 30;
/** 最も深い階。ここに秘宝とドラゴンがいる */
export const FLOORS = 5;

/**
 * 敵の出方。cost=点数(強さの目安)、from/to=出てくる階の範囲、weight=出やすさ。
 * ボスのドラゴンは別枠で、地下 5 階に必ず 1 体置く
 */
export const MONSTER_GEN: Record<string, { cost: number; from: number; to?: number; weight: number }> = {
  slime: { cost: 1, from: 1, to: 2, weight: 3 },
  bat: { cost: 2, from: 1, to: 3, weight: 3 },
  goblin: { cost: 2, from: 1, to: 4, weight: 4 },
  archer: { cost: 2, from: 1, to: 4, weight: 3 },
  shaman: { cost: 3, from: 2, weight: 2 },
  orc: { cost: 4, from: 2, weight: 2 },
  darkelf: { cost: 4, from: 3, weight: 2 },
  warlock: { cost: 5, from: 3, weight: 1 },
  troll: { cost: 5, from: 4, weight: 1.5 },
  ogre: { cost: 7, from: 3, weight: 1.5 },
};
const DRAGON_COST = 7;

/** 後衛(射撃・魔法)の敵。編成では部屋の奥に置く */
export const BACK_LINE = new Set(['archer', 'shaman', 'darkelf', 'warlock']);
/** 生成の調整用の値(自動対戦で比べられるよう書き換え可能にしてある) */
export const GEN = {
  /** 部屋の敵を「前衛+後衛」の編成で置く割合(前衛は入口側、後衛は奥) */
  formationRate: 0.6,
};

/**
 * 難易度ごとの敵の量。budget[階 - 1]=その階の敵の点数の合計(地下 5 階はドラゴンを除く)、
 * group=1 部屋の点数の上限(深い階ほど 1 ずつ増える)、ogres=1 つの階のオーガの最大数。
 * 自動対戦の勝率(地下 5 階の秘宝を地上へ持ち帰るまで)が Easy 95% / Normal 75% / Hard 50% 前後になるよう調整する
 */
export const DIFFICULTY: Record<Difficulty, { budget: number[]; group: number; ogres: number; wander: number }> = {
  // wander: 休憩の物音で敵が現れる確率の倍率(RULES.wanderChance に掛ける)
  easy: { budget: [8, 11, 14, 17, 14], group: 6, ogres: 0, wander: 0.4 },
  normal: { budget: [16, 21, 26, 31, 26], group: 11, ogres: 1, wander: 1 },
  hard: { budget: [25, 36, 50, 63, 56], group: 14, ogres: 3, wander: 1 },
};

/** 途中の階から始めるとき(デバッグ・自動対戦用)のパーティのレベル */
export const START_LEVEL = [1, 2, 3, 4, 5];

interface Room {
  x: number;
  y: number;
  w: number;
  h: number;
}

const center = (r: Room): Pos => ({ x: r.x + Math.floor(r.w / 2), y: r.y + Math.floor(r.h / 2) });
const inRoom = (r: Room, p: Pos) => p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;

export interface GeneratedFloor {
  map: FloorMap;
  enemies: Unit[];
  /** 上り階段(地下 1 階では入口) */
  up: Pos;
  /** 下り階段(地下 5 階には無い) */
  down: Pos | null;
  /** 秘宝の位置(地下 5 階だけ) */
  treasureAt: Pos | null;
}

/**
 * 新しいゲーム。startFloor 階の上り階段の周りにパーティを置く。
 * 地下 1 階以外から始めるときは、その階に見合ったレベルにする(デバッグ・自動対戦用)
 */
export function generateGame(seed: number, difficulty: Difficulty = 'normal', startFloor = 1): GameState {
  const f = generateFloor(seed, difficulty, startFloor);
  const level = START_LEVEL[startFloor - 1] ?? 1;
  const party: Unit[] = (['warrior', 'thief', 'mage', 'priest'] as const).map((defId, i) => {
    const c = CLASSES[defId];
    const u: Unit = { id: `p${i + 1}`, side: 'party', defId, name: c.name, x: f.up.x, y: f.up.y, hp: 0, mp: 0, down: false, level, exp: EXP_TABLE[level - 1] };
    const st = stats(u);
    u.hp = st.maxHp;
    u.mp = st.maxMp;
    return u;
  });
  const state: GameState = {
    seed,
    difficulty,
    objective: { kind: 'treasure', at: f.treasureAt, floor: FLOORS },
    rng: hashSeed('play', seed),
    turn: 1,
    map: f.map,
    units: [...party, ...f.enemies],
    explored: new Array(MAP_W * MAP_H).fill(0),
    status: 'playing',
    floor: startFloor,
    floors: {},
    gold: 0,
    deepest: startFloor,
  };
  placeParty(state, f.up);
  updateExplored(state);
  return state;
}

/** 1 つの階を作る */
export function generateFloor(seed: number, difficulty: Difficulty, floor: number): GeneratedFloor {
  const rng = new Rng(floor === 1 ? hashSeed('map', seed) : hashSeed('map', seed, floor));
  const { tiles, rooms } = carveRooms(rng);
  const map: FloorMap = { w: MAP_W, h: MAP_H, tiles: tiles.map((r) => r.join('')) };

  // 上り階段の部屋はランダム。そこからの歩数で、下り階段・秘宝(最も遠い部屋)と泉(中ほどの部屋)を決める
  const startRoom = rooms[rng.int(0, rooms.length - 1)];
  const up = center(startRoom);
  const dist = bfs(map, up);
  const d = (p: Pos) => dist[p.y * MAP_W + p.x];
  const others = rooms.filter((r) => r !== startRoom).sort((a, b) => d(center(a)) - d(center(b)));
  const farRoom = others[others.length - 1];
  const springRoom = others[Math.floor(others.length / 2) - 1] ?? others[0];
  setTile(map, up, 'S');
  const spring = randomCell(rng, springRoom, map, [center(springRoom)]);
  setTile(map, spring, 'H');

  const last = floor >= FLOORS;
  const down = last ? null : center(farRoom);
  if (down) setTile(map, down, '>');
  const treasureAt = last ? center(farRoom) : null;

  // 宝箱: 上り階段と泉の部屋以外に 2〜3 個
  const taken = new Set<string>([key(up)]);
  for (const p of nearestCells(map, up, 4, taken)) taken.add(key(p));
  if (treasureAt) taken.add(key(treasureAt));
  const chestRooms = others.filter((r) => r !== springRoom).sort(() => rng.next() - 0.5).slice(0, rng.int(2, 3));
  for (const r of chestRooms) {
    const p = randomCell(rng, r, map, [center(r)], taken);
    if (!p) continue;
    setTile(map, p, '$');
    taken.add(key(p));
  }

  const enemies = placeEnemies(rng, map, rooms, startRoom, farRoom, floor, difficulty, d, taken);
  return { map, enemies, up, down, treasureAt };
}

/** 宝箱のゴールド(開ける順番に左右されないよう、場所から決める) */
export function chestGold(seed: number, floor: number, p: Pos): number {
  const rng = new Rng(hashSeed('chest', seed, floor, p.x, p.y));
  return 10 * floor + rng.int(0, 10 * floor);
}

/**
 * パーティを at(階段)の周りの空いた床に置く。担がれている気絶者は担いでいる者と同じマスに置く。
 * 階段の上には置かない(着いてすぐ折り返さないように)
 */
export function placeParty(state: GameState, at: Pos): void {
  const taken = new Set<string>([key(at)]);
  for (const u of state.units) if (u.side === 'enemy' && !u.down) taken.add(key(u));
  const party = state.units.filter((u) => u.side === 'party');
  const carried = new Set(party.filter((u) => u.carrying).map((u) => u.carrying!));
  const free = party.filter((u) => !carried.has(u.id));
  const cells = nearestCells(state.map, at, free.length, taken);
  free.forEach((u, i) => {
    const p = cells[i] ?? at;
    u.x = p.x;
    u.y = p.y;
  });
  for (const u of party) {
    if (!u.carrying) continue;
    const t = party.find((o) => o.id === u.carrying);
    if (t) {
      t.x = u.x;
      t.y = u.y;
    }
  }
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
  farRoom: Room,
  floor: number,
  difficulty: Difficulty,
  d: (p: Pos) => number,
  taken: Set<string>,
): Unit[] {
  const cfg = DIFFICULTY[difficulty];
  const group = cfg.group + floor - 1;
  const units: Unit[] = [];
  const counts: Record<string, number> = {};
  const PREFIX: Record<string, string> = {
    slime: 's', bat: 'v', goblin: 'g', archer: 'a', shaman: 'm', orc: 'o', darkelf: 'e', troll: 't', ogre: 'b', dragon: 'd', wyrm: 'd', warlock: 'k',
  };
  const spawn = (defId: string, p: Pos, ai: AiMemory = { mode: 'idle' }) => {
    const m = MONSTERS[defId];
    counts[defId] = (counts[defId] ?? 0) + 1;
    // ID は階をまたいでも重ならないようにする(地下 1 階は g1、地下 2 階は 2g1 など)
    const id = `${floor > 1 ? floor : ''}${PREFIX[defId] ?? 'x'}${counts[defId]}`;
    units.push({ id, side: 'enemy', defId, name: m.name, x: p.x, y: p.y, hp: m.maxHp, mp: m.maxMp, down: false, ai });
    taken.add(key(p));
  };

  // 上り階段から近すぎる部屋には置かない
  const candidates = rooms.filter((r) => r !== startRoom && d(center(r)) >= 8);
  let budget = cfg.budget[Math.min(floor, cfg.budget.length) - 1];
  let ogres = 0;
  const kinds = Object.keys(MONSTER_GEN).filter((t) => floor >= MONSTER_GEN[t].from && floor <= (MONSTER_GEN[t].to ?? 99));
  const pickType = (room: number, pool?: (t: string) => boolean): string | null => {
    const opts = kinds.filter((t) => MONSTER_GEN[t].cost <= room && MONSTER_GEN[t].cost <= budget && (t !== 'ogre' || ogres < cfg.ogres) && (!pool || pool(t)));
    if (opts.length === 0) return null;
    const weights = opts.map((t) => MONSTER_GEN[t].weight);
    let x = rng.next() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < opts.length; i++) if ((x -= weights[i]) < 0) return opts[i];
    return opts[opts.length - 1];
  };
  const place = (t: string, p: Pos) => {
    spawn(t, p);
    if (t === 'ogre') ogres++;
    budget -= MONSTER_GEN[t].cost;
  };
  const fillRoom = (r: Room, points: number) => {
    let room = Math.min(points, budget);
    // 編成: 後衛を 1 体、部屋の最も奥(上り階段からの歩数が最も多いマス)に置き、残りは前衛を入口側に並べる
    if (rng.next() < GEN.formationRate) {
      const back = pickType(room - 2, (t) => BACK_LINE.has(t));
      const p = back && extremeCell(r, map, d, taken, 'far');
      if (back && p) {
        place(back, p);
        room -= MONSTER_GEN[back].cost;
        while (room >= 1 && budget >= 1) {
          const t = pickType(room, (x) => !BACK_LINE.has(x));
          const q = t && extremeCell(r, map, d, taken, 'near');
          if (!t || !q) break;
          place(t, q);
          room -= MONSTER_GEN[t].cost;
        }
        return;
      }
    }
    while (room >= 1 && budget >= 1) {
      const t = pickType(room);
      if (!t) break;
      const p = randomCell(rng, r, map, [], taken);
      if (!p) break;
      place(t, p);
      room -= MONSTER_GEN[t].cost;
    }
  };

  if (floor >= FLOORS) {
    // ボスのドラゴンは秘宝の部屋に 1 体。眠っていて、こっそり秘宝を持ち出すこともできる。
    // 秘宝(部屋の中央)からなるべく離れたマスに置き、起こさずに秘宝へ近づける余地を残す。Easy は若いドラゴン
    const lair = farthestCell(farRoom, map, center(farRoom), taken);
    if (lair) spawn(difficulty === 'easy' ? 'wyrm' : 'dragon', lair, { mode: 'idle', asleep: true });
    // ドラゴン以外の番人も置く
    fillRoom(farRoom, group - DRAGON_COST);
  }
  const order = [...candidates].sort(() => rng.next() - 0.5);
  for (let i = 0; budget >= 1 && i < order.length * 3; i++) {
    const r = order[i % order.length];
    fillRoom(r, rng.int(2, group));
  }

  // 一部の敵は部屋の間を巡回する
  const movers = units.filter((u) => ['goblin', 'orc', 'bat', 'troll'].includes(u.defId));
  for (const u of movers.slice(0, Math.max(1, Math.floor(movers.length / 4)))) {
    const home = rooms.find((r) => inRoom(r, u))!;
    const away = candidates.filter((r) => r !== home)[rng.int(0, Math.max(0, candidates.length - 2))] ?? home;
    u.ai = { mode: 'patrol', patrol: [{ x: u.x, y: u.y }, center(away)], patrolIndex: 1 };
  }
  return units;
}

/** 部屋の中の空いた床のうち、上り階段からの歩数 d が最も少ない('near')/多い('far')マス */
function extremeCell(r: Room, map: FloorMap, d: (p: Pos) => number, taken: Set<string>, which: 'near' | 'far'): Pos | null {
  let best: Pos | null = null;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const p = { x, y };
      if (map.tiles[y][x] !== '.' || taken.has(key(p)) || d(p) < 0) continue;
      if (!best || (which === 'near' ? d(p) < d(best) : d(p) > d(best))) best = p;
    }
  return best;
}

/** 部屋の中で from から最も遠い(マンハッタン距離)空いた床 */
function farthestCell(r: Room, map: FloorMap, from: Pos, taken: Set<string>): Pos | null {
  let best: Pos | null = null;
  let bd = -1;
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++) {
      const p = { x, y };
      if (map.tiles[y][x] !== '.' || taken.has(key(p))) continue;
      const d = manhattan(p, from);
      if (d > bd) {
        bd = d;
        best = p;
      }
    }
  return best;
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
