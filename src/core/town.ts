// 地上(階 0)の城。 中央を縦に貫く幅 3 の大広間(下端が城の入口、上端が地下 1 階への下り階段)の
// 左右に、扉の付いた部屋(中は ROOM_SIZE × ROOM_SIZE)が 3 つずつ並び、それぞれに施設がある
// (宿・馬小屋・道具屋・療養所・銀行・教会)。施設のマスは部屋の中央の目印(通れて、視線も遮らない)。
// 立っている味方が施設の部屋の中(どのマスでもよい)にいて敵が見えなければ使える(controller.ts)。
import { ITEMS } from '../data/units';
import { DIR_LIST, isWalkable, step, tileAt } from './map';
import { stats } from './stats';
import type { FloorMap, GameState, ItemId, Pos, Unit } from './types';

/** 施設の種類と、地図のタイル文字 */
export type FacilityId = 'inn' | 'stable' | 'shop' | 'clinic' | 'bank' | 'church';
export const FACILITY_TILE: Record<FacilityId, string> = { inn: 'I', stable: 'B', shop: 'T', clinic: 'C', bank: 'G', church: 'A' };
const TILE_FACILITY: Record<string, FacilityId> = Object.fromEntries(Object.entries(FACILITY_TILE).map(([id, c]) => [c, id as FacilityId]));

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
  /** 教会: 加護の額(× パーティのレベルの合計) */
  churchPerLevel: 10,
  /** 教会の加護で復帰したときの HP(最大値に対する割合) */
  blessingHpRatio: 0.5,
  /** 銀行: 1 回に預ける・引き出す額(全額の操作もある) */
  bankStep: 50,
  /** 銀行: ゲームを起動するたびに付く利息の率と、暴落する確率・失う割合 */
  bankInterest: 0.05,
  bankCrashChance: 0.01,
  bankCrashLoss: 0.3,
};

/**
 * 城の部屋の並び(上から順に、左・右)。下(入口側)ほどよく使う施設を置く。
 * 上: 教会・銀行、中: 宿・療養所、下: 道具屋・馬小屋
 */
const ROOMS: [FacilityId, FacilityId][] = [
  ['church', 'bank'],
  ['inn', 'clinic'],
  ['shop', 'stable'],
];

/** 施設の部屋の中の広さ(縦横のマス数) */
export const ROOM_SIZE = 5;

export interface Town {
  map: FloorMap;
  /** 城の入口(新しいゲームの開始位置) */
  start: Pos;
  /** 地下 1 階への下り階段 */
  down: Pos;
  facilities: Record<FacilityId, Pos>;
}

/**
 * 地上の城を作る(どのシードでも同じ間取り)。
 * 大広間は地図の中央の 3 列で、上端の中央に下り階段、下端の中央が入口。縦の長さは部屋の並びに合わせ、地図の上下の中ほどに置く。
 * 左右の部屋(中は ROOM_SIZE × ROOM_SIZE)は大広間との間の壁に扉(閉)があり、部屋の中央に施設のマスを置く
 */
export function generateTown(_seed: number, w: number, h: number): Town {
  const tiles = Array.from({ length: h }, () => new Array<string>(w).fill('#'));
  const cx = Math.floor(w / 2) - 1;
  const hall = { x0: cx - 1, x1: cx + 1 };
  // 大広間の縦: 部屋の並び(間に壁 1 マス)の上下に 2 行ずつ(下り階段・入口の行と、余白の行)
  const rows = ROOMS.length;
  const hallH = rows * ROOM_SIZE + (rows - 1) + 4;
  const top = Math.max(1, 1 + Math.floor((h - 2 - hallH) / 2));
  const bottom = Math.min(h - 2, top + hallH - 1);
  for (let y = top; y <= bottom; y++) for (let x = hall.x0; x <= hall.x1; x++) tiles[y][x] = '.';

  // 部屋: 大広間の左右の壁(1 マス)の外側。部屋の間に壁を 1 マス挟む
  const left = { x0: hall.x0 - 1 - ROOM_SIZE, x1: hall.x0 - 2 };
  const right = { x0: hall.x1 + 2, x1: hall.x1 + 1 + ROOM_SIZE };
  const facilities = {} as Record<FacilityId, Pos>;
  ROOMS.forEach(([l, r], i) => {
    const y0 = top + 2 + i * (ROOM_SIZE + 1);
    const y1 = y0 + ROOM_SIZE - 1;
    const mid = Math.floor((y0 + y1) / 2);
    for (const [side, id, doorX] of [
      [left, l, hall.x0 - 1],
      [right, r, hall.x1 + 1],
    ] as const) {
      for (let y = y0; y <= y1; y++) for (let x = side.x0; x <= side.x1; x++) tiles[y][x] = '.';
      tiles[mid][doorX] = 'D';
      const p = { x: Math.floor((side.x0 + side.x1) / 2), y: mid };
      tiles[p.y][p.x] = FACILITY_TILE[id];
      facilities[id] = p;
    }
  });

  const down = { x: cx, y: top };
  tiles[down.y][down.x] = '>';
  const start = { x: cx, y: bottom };
  return { map: { w, h, tiles: tiles.map((r) => r.join('')) }, start, down, facilities };
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

/** 教会の加護の額(パーティ全員のレベルの合計 × TOWN.churchPerLevel) */
export function churchCost(state: GameState): number {
  return state.units.filter((u) => u.side === 'party').reduce((a, u) => a + (u.level ?? 1), 0) * TOWN.churchPerLevel;
}

/** 教会で加護を受ける(すでに受けていれば受けない)。受けられたら true */
export function useChurch(state: GameState): boolean {
  const cost = churchCost(state);
  if (state.blessing || (state.gold ?? 0) < cost) return false;
  state.gold = (state.gold ?? 0) - cost;
  state.blessing = true;
  return true;
}

/** 銀行に預ける(amount が所持金より多ければ所持金の全部)。預けた額を返す */
export function deposit(state: GameState, amount: number): number {
  const n = Math.max(0, Math.min(amount, state.gold ?? 0));
  state.gold = (state.gold ?? 0) - n;
  state.bank = (state.bank ?? 0) + n;
  return n;
}

/** 銀行から引き出す(amount が預金より多ければ預金の全部)。引き出した額を返す */
export function withdraw(state: GameState, amount: number): number {
  const n = Math.max(0, Math.min(amount, state.bank ?? 0));
  state.bank = (state.bank ?? 0) - n;
  state.gold = (state.gold ?? 0) + n;
  return n;
}

/**
 * 起動 1 回ごとの預金の増減。roll(0 以上 1 未満の乱数)が TOWN.bankCrashChance 未満なら暴落して
 * 預金の TOWN.bankCrashLoss を失い、それ以外は TOWN.bankInterest の利息が付く(1 G 以上)。
 * 預金が無ければ null
 */
export function bankDay(state: GameState, roll: number): { crash: boolean; amount: number } | null {
  const bank = state.bank ?? 0;
  if (bank <= 0) return null;
  if (roll < TOWN.bankCrashChance) {
    const loss = Math.round(bank * TOWN.bankCrashLoss);
    state.bank = bank - loss;
    return { crash: true, amount: loss };
  }
  const gain = Math.max(1, Math.floor(bank * TOWN.bankInterest));
  state.bank = bank + gain;
  return { crash: false, amount: gain };
}

/** 道具屋で 1 つ買う。買えたら true */
export function buyItem(state: GameState, k: ItemId): boolean {
  const price = ITEMS[k].price;
  if ((state.gold ?? 0) < price) return false;
  state.gold = (state.gold ?? 0) - price;
  state.items = { ...state.items, [k]: (state.items?.[k] ?? 0) + 1 };
  return true;
}

/**
 * 立っている味方が施設にいれば、その施設(複数あれば最初の 1 つ)。
 * 地上では施設の部屋の中ならどのマスでもよい。ほかの階では施設のマスの上だけ
 */
export function facilityHere(state: GameState): FacilityId | null {
  for (const u of standing(state)) {
    const f = (state.floor ?? 1) === 0 ? roomFacility(state.map, u) : facilityOf(tileAt(state.map, u.x, u.y));
    if (f) return f;
  }
  return null;
}

const isDoor = (c: string) => c === 'D' || c === '+';

/** p を含む部屋(壁と扉で区切られた床のまとまり)にある施設。扉の上・壁・施設の無いまとまり(大広間)なら null */
export function roomFacility(map: FloorMap, p: Pos): FacilityId | null {
  if (!isWalkable(map, p.x, p.y) || isDoor(tileAt(map, p.x, p.y))) return null;
  const seen = new Set([p.y * map.w + p.x]);
  const q: Pos[] = [p];
  for (let i = 0; i < q.length; i++) {
    const f = facilityOf(tileAt(map, q[i].x, q[i].y));
    if (f) return f;
    for (const dir of DIR_LIST) {
      const s = step(q[i], dir);
      const k = s.y * map.w + s.x;
      if (seen.has(k) || !isWalkable(map, s.x, s.y) || isDoor(tileAt(map, s.x, s.y))) continue;
      seen.add(k);
      q.push(s);
    }
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
