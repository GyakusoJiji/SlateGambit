// 同時解決エンジン。全ユニットの予約を 1 ティックずつ同時に処理する。
import { ITEMS, SPELLS, unitDef } from '../data/units';
import { applyStairs, applyWander, currentFloor, openChests, treasureHere } from './floors';
import { gainExp, spellBonus, spellMp, spellRange, stats } from './stats';
import { RULES, expandPlan, restTicks, type Step } from './actions';
import { hasLos, linePoints } from './los';
import { adjacent, DIR_LIST, dist2, isWalkable, manhattan, nearOrSame, step, tileAt } from './map';
import { findPath } from './path';
import { clearShot, interceptCandidates, overwatchTarget } from './reactions';
import { Rng } from './rng';
import { applyAlarm } from './alarm';
import { openDoorsNear, tickDoors } from './doors';
import {
  TICKS_PER_TURN,
  type Action,
  type GameEvent,
  type GameState,
  type Plans,
  type Pos,
  type Side,
  type TurnResult,
  type Unit,
  type UnitSnapshot,
} from './types';
import { unitSees, updateExplored, visibleFoes } from './vision';

const key = (p: Pos) => `${p.x},${p.y}`;

export interface MoveIntent {
  unit: Unit;
  from: Pos;
  to: Pos;
  status: 'pending' | 'ok' | 'blocked';
}

interface StrikeIntent {
  unit: Unit;
  action: Extract<Action, { type: 'attack' | 'spell' | 'item' }>;
  reaction: boolean;
}

export function resolveTurn(input: GameState, plans: Plans): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rng);
  const { map, units } = state;
  const byId = new Map(units.map((u) => [u.id, u]));
  const steps = new Map<string, Step[]>(units.map((u) => [u.id, expandPlan(plans[u.id] ?? [])]));
  const seenAtStart: Record<Side, Set<string>> = {
    party: visibleFoes(map, units, 'party'),
    enemy: visibleFoes(map, units, 'enemy'),
  };
  const events: GameEvent[] = [];
  const guard = new Set<string>();
  const cover = new Set<string>();
  const watching = new Set<string>();
  const frames: UnitSnapshot[][] = [snapshot(units, guard, watching)];
  const tiles: string[][] = [map.tiles.slice()];
  /** このターンに攻撃してきた相手(AI の警戒用) */
  const attackedBy = new Map<string, string>();
  /** 接近攻撃で、射程内に入ってから構えたティック数 */
  const chargeWind = new Map<string, number>();
  /** 接近攻撃で攻撃まで届いた者と、狙いが倒れて攻撃しなかった者(ターン後の結果の要約用) */
  const chargeStruck = new Set<string>();
  const chargeLost = new Set<string>();
  const treasure = state.objective?.kind === 'treasure' ? [treasureSnap(state)] : undefined;
  /** ターンの初めに味方を見ていた敵(警報役が気付いたかの判定用) */
  const enemiesSawParty = new Set(
    units.filter((e) => e.side === 'enemy' && !e.down && units.some((p) => p.side === 'party' && !p.down && unitSees(map, e, p))).map((e) => e.id),
  );
  /** ターンの初めに立っていた敵(倒した敵の経験値の計算用) */
  const foesAtStart = units.filter((u) => u.side === 'enemy' && !u.down);

  for (let tick = 1; tick <= TICKS_PER_TURN; tick++) {
    const ti = tick - 1;
    guard.clear();
    cover.clear();
    watching.clear();

    // ① 防御・構えの更新(接近攻撃は、届くなら構え/攻撃、届かなければ移動に読み替える)
    const current = new Map<string, Step>();
    for (const u of units) {
      if (u.down) continue;
      let s = steps.get(u.id)![ti];
      if (s.k === 'charge') {
        const t = byId.get(s.target);
        s = chargeStep(map, u, t, s, chargeWind, units);
        if (s.k === 'strike') chargeStruck.add(u.id);
        if (!t || t.down) chargeLost.add(u.id);
      }
      current.set(u.id, s);
      if (s.k === 'guard' || s.k === 'cover') guard.add(u.id);
      if (s.k === 'cover') cover.add(u.id);
      if (s.k === 'watch') watching.add(u.id);
    }

    // ② 移動
    const intents: MoveIntent[] = [];
    for (const [id, s] of current) {
      const u = byId.get(id)!;
      let to: Pos | null = null;
      if (s.k === 'move') {
        to = step(u, s.action.dir);
      } else if (s.k === 'charge') {
        // ここに来るのは届かない場合だけ。届く位置へ 1 マス近づく
        const t = byId.get(s.target)!;
        const { blocks, taken } = pathRules(units, u, t);
        const p = findPath(map, u, (q) => !taken(q) && inReach(map, u, q, t, units), blocks, 400);
        if (p && p.length > 0) to = step(u, p[0]);
      }
      if (to) intents.push({ unit: u, from: { x: u.x, y: u.y }, to, status: 'pending' });
    }
    for (const m of intents) {
      if (!isWalkable(map, m.to.x, m.to.y)) {
        m.status = 'blocked';
        continue;
      }
      m.status = 'ok';
      m.unit.x = m.to.x;
      m.unit.y = m.to.y;
    }
    // 扉の隣に来たら開ける(開けた先に敵が見えれば、下の「敵を見たら停止」が働く)
    openDoorsNear(map, units);

    // 敵を見たら停止
    for (const m of intents) {
      const s = current.get(m.unit.id);
      if (m.status !== 'ok' || s?.k !== 'move' || !s.action.stop) continue;
      const u = m.unit;
      const newFoe = units.some(
        (f) => f.side !== u.side && !f.down && !seenAtStart[u.side].has(f.id) && unitSees(map, u, f),
      );
      if (newFoe) {
        const list = steps.get(u.id)!;
        for (let i = tick; i < list.length; i++) if (list[i].k === 'move') list[i] = { k: 'guard' };
        events.push({ tick, type: 'halt', id: u.id });
      }
    }

    // 同じマスに止まるユニットが重ならないよう整理し、移動のイベントを出す
    // 通り抜けの途中: このティックに移動できて、次のティックも移動する
    const intentById = new Map(intents.map((m) => [m.unit.id, m]));
    // (接近攻撃は止まれないマスを目的地にしないので、途中のマスは通り抜けとして扱う)
    const MOVING = new Set<Step['k']>(['move', 'charge']);
    const continues = (u: Unit) =>
      intentById.get(u.id)?.status === 'ok' && tick < TICKS_PER_TURN && MOVING.has(steps.get(u.id)![tick].k);
    const displaced = settleMoves(intents, units, map, rng, continues);
    for (const m of intents) {
      if (m.status === 'ok') events.push({ tick, type: 'move', id: m.unit.id, from: m.from, to: m.to });
      else events.push({ tick, type: 'bump', id: m.unit.id, at: m.to });
    }
    for (const d of displaced) events.push({ tick, type: 'move', id: d.unit.id, from: d.from, to: d.to });
    if (displaced.length > 0) openDoorsNear(map, units);
    /** このティックに実際に位置が変わったユニット(条件付き行動の発動条件) */
    const movedNow = new Set([...intents.filter((m) => m.status === 'ok').map((m) => m.unit.id), ...displaced.map((d) => d.unit.id)]);

    // 担ぐ・降ろす
    for (const [id, s] of current) {
      const u = byId.get(id)!;
      if (s.k === 'carry') {
        const t = byId.get(s.target);
        const taken = units.some((o) => o.carrying === s.target);
        if (!u.carrying && t && t.down && t.side === u.side && !taken && nearOrSame(map, u, t)) {
          u.carrying = t.id;
          events.push({ tick, type: 'carry', id, target: t.id });
        } else {
          events.push({ tick, type: 'fizzle', id, reason: '担げない' });
        }
      } else if (s.k === 'drop' && u.carrying) {
        events.push({ tick, type: 'drop', id, target: u.carrying });
        u.carrying = undefined;
      }
    }
    syncCarried(units, byId);

    // ③ 条件付き行動の発動
    const strikes: StrikeIntent[] = [];
    for (const id of watching) {
      const u = byId.get(id)!;
      const s = current.get(id);
      if (s?.k !== 'watch') continue;
      const list = steps.get(id)!;
      let target: Unit | undefined;
      if (s.mode === 'overwatch') {
        target = overwatchTarget(map, u, units, movedNow);
      } else {
        const cands = interceptCandidates(map, u, units);
        if (cands.length === 0) continue;
        if (!cands.some((f) => movedNow.has(f.id))) {
          // 隣に動かない敵しかいない: 通常の攻撃と同じく、このティックから溜めて最後のティックで殴る。
          // 残りの迎撃の AP が攻撃のコストに足りなければ何もしない
          const n = RULES.attackCost;
          const rest = list.slice(tick, tick + n - 1);
          if (rest.length < n - 1 || !rest.every((r) => r.k === 'watch' && r.mode === 'intercept')) continue;
          const action = { type: 'attack', target: cands[rng.int(0, cands.length - 1)].id } as const;
          for (let i = 0; i < n - 2; i++) list[tick + i] = { k: 'windup', action };
          list[tick + n - 2] = { k: 'strike', action };
          continue;
        }
        target = cands[rng.int(0, cands.length - 1)];
      }
      if (!target) continue;
      strikes.push({ unit: u, action: { type: 'attack', target: target.id }, reaction: true });
      // 発動した攻撃の残りコスト(1 ティック)を消費する
      if (tick < list.length) list[tick] = { k: 'recover' };
    }

    // ④ 攻撃・魔法を同時適用
    for (const [id, s] of current) {
      if (s.k === 'strike') strikes.push({ unit: byId.get(id)!, action: s.action, reaction: false });
    }
    const hpDelta = new Map<string, number>();
    const revived = new Set<string>();
    const stuns: string[] = [];
    const ctx: StrikeCtx = { state, tick, turn: state.turn, map, units, byId, rng, guard, cover, events, hpDelta, revived, attackedBy, stuns };
    for (const st of strikes) performStrike(ctx, st);
    // 足払い: 次のティックから数ティック、予約していた行動が消える(構えや移動も中断される)
    for (const id of stuns) {
      const list = steps.get(id)!;
      let interrupted = false;
      for (let i = tick; i < Math.min(list.length, tick + RULES.stunTicks); i++) {
        const cur = list[i];
        list[i] = { k: 'stun' };
        // 構えていた攻撃・魔法が取り消されたことを残す(足払いで何を防げたかが分かるように)
        if (!interrupted && (cur.k === 'windup' || cur.k === 'strike') && (cur.action.type === 'attack' || cur.action.type === 'spell')) {
          interrupted = true;
          events.push({ tick, type: 'interrupt', id, ...(cur.action.type === 'spell' ? { spell: cur.action.spell } : {}) });
        }
        // 構えの途中で止められた攻撃・魔法は、残りの構えと最後の一撃ごと取り消す
        if (cur.k === 'windup') {
          for (let j = i + 1; j < list.length; j++) {
            const nx = list[j];
            if ((nx.k !== 'windup' && nx.k !== 'strike') || nx.action !== cur.action) break;
            list[j] = { k: 'stun' };
            if (nx.k === 'strike') break;
          }
        }
      }
    }

    for (const [id, d] of hpDelta) {
      const u = byId.get(id)!;
      u.hp = Math.max(0, Math.min(stats(u).maxHp, u.hp + d));
    }
    for (const id of revived) {
      const u = byId.get(id)!;
      u.down = false;
      u.hp = Math.max(u.hp, SPELLS.revive.power);
      events.push({ tick, type: 'revive', id });
      standUp(map, units, u, events, tick);
    }

    // ⑤ 戦闘不能判定(相打ちあり)。担いでいた者が倒れたら、その場に落とす
    for (const u of units) {
      if (!u.down && u.hp <= 0) {
        u.down = true;
        u.hp = 0;
        if (u.side === 'enemy') u.downTurn = state.turn;
        events.push({ tick, type: 'down', id: u.id });
      }
    }
    for (const u of units) {
      if (u.down && u.carrying) {
        events.push({ tick, type: 'drop', id: u.id, target: u.carrying });
        u.carrying = undefined;
      }
    }
    updateTreasure(state, byId, events, tick);
    openChests(state, events, tick);

    updateExplored(state);
    frames.push(snapshot(units, guard, watching));
    tiles.push(map.tiles.slice());
    if (treasure) treasure.push(treasureSnap(state));
  }

  // 接近攻撃が一度も攻撃まで届かなかった味方は、理由を残す(敵の分はログが煩わしくなるので出さない)
  for (const u of units) {
    if (u.side !== 'party' || u.down || chargeStruck.has(u.id) || !plans[u.id]?.some((a) => a.type === 'charge')) continue;
    events.push({ tick: TICKS_PER_TURN, type: 'fizzle', id: u.id, reason: chargeLost.has(u.id) ? '狙いが倒れた' : '接近攻撃が届かなかった' });
  }
  applyRest(state, plans, seenAtStart.party.size > 0, events, frames);
  {
    const stand = state.units.filter((u) => u.side === 'party' && !u.down);
    const share = stand.reduce((t, u) => t + restTicks(plans[u.id]) / TICKS_PER_TURN, 0) / Math.max(1, stand.length);
    const inCombat = seenAtStart.party.size > 0 || visibleFoes(state.map, state.units, 'party').size > 0;
    if (!inCombat) applyWander(state, rng, share, events);
  }
  applySpring(state, events, frames);
  applyWakeUp(state, rng, events, frames);
  applyExp(state, foesAtStart, events, frames);
  updateAiMemory(state, attackedBy, events);
  applyAlarm(state, rng, events, new Set(events.filter((e) => e.type === 'stun').map((e) => e.id)), enemiesSawParty);
  // 開いた扉の時間経過(閉まった扉は最後のフレームの地形にも反映する)
  if (tickDoors(map, state.units)) tiles[tiles.length - 1] = map.tiles.slice();
  state.rng = rng.state;
  state.turn += 1;
  // 地下 1 階の入口に秘宝を持ち帰ったら、階段の判定より勝ちを優先する
  state.status = judge(state);
  if (state.status === 'playing') {
    const users = new Set(Object.keys(plans).filter((id) => plans[id]?.some((a) => a.type === 'stairs')));
    applyStairs(state, events, users);
  }
  return { state, events, frames, tiles, treasure };
}

function treasureSnap(state: GameState): { at: Pos | null; holder?: string } {
  const o = state.objective;
  if (o?.kind !== 'treasure') return { at: null };
  const at = treasureHere(state);
  return { at: at && { ...at }, holder: o.holder };
}

/**
 * 宝: 持っている味方が気絶したらその場に落ちる。床の宝に立っている味方は拾う
 * (気絶した持ち主を担いでいる味方は、落ちた宝をそのまま拾う)
 */
function updateTreasure(state: GameState, byId: Map<string, Unit>, events: GameEvent[], tick: number): void {
  const o = state.objective;
  if (o?.kind !== 'treasure') return;
  if (o.holder) {
    const h = byId.get(o.holder)!;
    if (!h.down) return;
    o.at = { x: h.x, y: h.y };
    o.floor = currentFloor(state);
    o.holder = undefined;
    events.push({ tick, type: 'treasure', id: h.id, got: false, at: { ...o.at } });
  }
  const at = treasureHere(state);
  if (!at) return;
  const finder = state.units.find((u) => u.side === 'party' && !u.down && u.x === at.x && u.y === at.y);
  if (!finder) return;
  o.holder = finder.id;
  o.at = null;
  events.push({ tick, type: 'treasure', id: finder.id, got: true, at: { ...at } });
}

function snapshot(units: Unit[], guard: Set<string>, watching: Set<string>): UnitSnapshot[] {
  return units.map((u) => ({
    id: u.id,
    x: u.x,
    y: u.y,
    hp: u.hp,
    mp: u.mp,
    down: u.down,
    guard: guard.has(u.id),
    watch: watching.has(u.id),
    carrying: !!u.carrying,
  }));
}

/**
 * 接近攻撃の経路の条件。
 * blocks: 途中で通れないマス(通り抜け不可の敵がいる)、taken: 止まれないマス(誰かが立っている)
 */
function pathRules(units: Unit[], u: Unit, target: Unit): { blocks: (p: Pos) => boolean; taken: (p: Pos) => boolean } {
  const others = units.filter((o) => o !== u && o !== target && !o.down);
  return {
    blocks: (p) => others.some((o) => o.x === p.x && o.y === p.y && o.side !== u.side && !RULES.passThroughFoes),
    taken: (p) => others.some((o) => o.x === p.x && o.y === p.y),
  };
}

/**
 * 攻撃が届く位置か(近接は斜めを含めて隣接、遠隔は射程内で射線が通る)。
 * units を渡すと、遠隔は味方などが射線上にいない(最初に当たるのが t)ことも条件にする
 */
export function inReach(map: GameState['map'], u: Unit, from: Pos, t: Unit, units?: Unit[]): boolean {
  return reachProblem(map, u, from, t, units) === null;
}

/**
 * from から t へ攻撃が届かない理由(届くなら null)。
 * 近接は「隣にいない」、遠隔は「射程外」「壁に遮られている」「味方が射線上にいる」「別の敵が射線上にいる」
 * (units を渡したときだけ射線上のユニットを見る)
 */
export function reachProblem(map: GameState['map'], u: Unit, from: Pos, t: Unit, units?: Unit[]): string | null {
  const def = stats(u);
  if (def.range <= 1) return adjacent(map, from, t) ? null : REACH.adjacent;
  return rangedProblem(map, from, t, def.range) ?? (units ? blockerProblem(units, u, from, t) : null);
}

/** 届かない理由の言い回し(不発の理由と共通) */
export const REACH = {
  adjacent: '隣にいない',
  range: '射程外',
  wall: '壁に遮られている',
  ally: '味方が射線上にいる',
  foe: '別の敵が射線上にいる',
} as const;

/** 射程と壁だけを見た理由 */
function rangedProblem(map: GameState['map'], from: Pos, to: Pos, range: number): string | null {
  if (dist2(from, to) > range * range) return REACH.range;
  if (!hasLos(map, from, to)) return REACH.wall;
  return null;
}

function blockerProblem(units: Unit[], u: Unit, from: Pos, t: Unit): string | null {
  if (clearShot(units, u, from, t)) return null;
  const hit = linePoints(from, t)
    .map((p) => units.find((o) => o !== u && o !== t && !o.down && o.x === p.x && o.y === p.y))
    .find(Boolean);
  return hit && hit.side !== u.side ? REACH.foe : REACH.ally;
}

/**
 * 接近攻撃の経路の目安: from から、t へ攻撃が届く空いたマスまでの経路(from を含むマスの列)。
 * 予約の時点の位置で求めるので、実行時に相手や味方が動けば変わる。行けなければ null
 */
export function chargeRoute(map: GameState['map'], u: Unit, from: Pos, t: Unit, units: Unit[]): Pos[] | null {
  const mover = { ...u, x: from.x, y: from.y };
  const others = units.filter((o) => o.id !== u.id);
  const { blocks, taken } = pathRules(others, mover, t);
  const dirs = findPath(map, mover, (q) => !taken(q) && inReach(map, u, q, t, others), blocks, 400);
  if (!dirs) return null;
  const out: Pos[] = [{ x: from.x, y: from.y }];
  for (const d of dirs) out.push(step(out[out.length - 1], d));
  return out;
}

/** 接近攻撃の 1 ティック分を、構え・攻撃・移動(charge のまま)・防御のいずれかに読み替える */
function chargeStep(
  map: GameState['map'],
  u: Unit,
  t: Unit | undefined,
  s: Extract<Step, { k: 'charge' }>,
  wind: Map<string, number>,
  units: Unit[],
): Step {
  if (!t || t.down) {
    wind.delete(u.id);
    return { k: 'guard' };
  }
  // 遠隔は、味方が射線上にいる間は撃たずに位置を変える
  if (!inReach(map, u, u, t, units)) {
    wind.delete(u.id);
    return s;
  }
  const action = { type: 'attack' as const, target: t.id };
  const w = wind.get(u.id) ?? 0;
  if (w >= RULES.attackCost - 1) {
    wind.delete(u.id);
    return { k: 'strike', action };
  }
  wind.set(u.id, w + 1);
  return { k: 'windup', action };
}

/** 担がれている味方を、担いでいる者と同じマスに置く */
function syncCarried(units: Unit[], byId: Map<string, Unit>): void {
  for (const u of units) {
    if (u.down || !u.carrying) continue;
    const t = byId.get(u.carrying);
    if (!t || !t.down) {
      u.carrying = undefined;
      continue;
    }
    t.x = u.x;
    t.y = u.y;
  }
}

/** 起き上がったユニット: 担がれていれば降ろし、他と同じマスにいれば最寄りの空きマスへずらす */
function standUp(map: GameState['map'], units: Unit[], u: Unit, events: GameEvent[], tick: number): void {
  for (const c of units) {
    if (c.carrying === u.id) {
      events.push({ tick, type: 'drop', id: c.id, target: u.id });
      c.carrying = undefined;
    }
  }
  if (!units.some((o) => o !== u && !o.down && o.x === u.x && o.y === u.y)) return;
  const from = pos(u);
  const others = units.filter((o) => o !== u);
  const to = nearestFree(map, u, others, () => false);
  if (!to) return;
  u.x = to.x;
  u.y = to.y;
  events.push({ tick, type: 'move', id: u.id, from, to });
}

/**
 * 担がれている気絶者の回復: 担がれたままターンを終えた回数を数え、
 * RULES.carryWakeTurns 回目以降は、ターンの終わりごとに RULES.carryWakeChance の確率で意識を取り戻す。
 * 降ろされている気絶者の回数は 0 に戻す。
 */
function applyWakeUp(state: GameState, rng: Rng, events: GameEvent[], frames: UnitSnapshot[][]): void {
  const { map, units } = state;
  let changed = false;
  for (const u of units) {
    if (!u.down) {
      u.carriedTurns = undefined;
      continue;
    }
    const carried = units.some((c) => !c.down && c.carrying === u.id);
    if (!carried) {
      u.carriedTurns = undefined;
      continue;
    }
    u.carriedTurns = (u.carriedTurns ?? 0) + 1;
    if (u.carriedTurns < RULES.carryWakeTurns || rng.next() >= RULES.carryWakeChance) continue;
    u.down = false;
    u.hp = Math.min(stats(u).maxHp, RULES.carryWakeHp);
    u.carriedTurns = undefined;
    events.push({ tick: TICKS_PER_TURN, type: 'wake', id: u.id });
    standUp(map, units, u, events, TICKS_PER_TURN);
    changed = true;
  }
  if (changed) frames[frames.length - 1] = snapshot(units, new Set(), new Set());
}

/**
 * 回復の泉: ターンの終わりに泉のマスにいる味方は、気絶から復帰し、HP と MP が全回復する。
 * 担がれている味方は、担いでいる者が泉にいれば回復する。
 */
function applySpring(state: GameState, events: GameEvent[], frames: UnitSnapshot[][]): void {
  const { map, units } = state;
  let changed = false;
  for (const u of units) {
    if (u.side !== 'party' || tileAt(map, u.x, u.y) !== 'H') continue;
    const d = stats(u);
    if (!u.down && u.hp === d.maxHp && u.mp === d.maxMp) continue;
    const revived = u.down;
    u.down = false;
    u.hp = d.maxHp;
    u.mp = d.maxMp;
    events.push({ tick: TICKS_PER_TURN, type: 'spring', id: u.id, revived });
    if (revived) standUp(map, units, u, events, TICKS_PER_TURN);
    changed = true;
  }
  if (!changed) return;
  frames[frames.length - 1] = snapshot(units, new Set(), new Set());
}

/**
 * 移動後の位置の整理。移動は他のユニットがいるマスも通り抜けられるが、
 * 同じマスに 2 体以上が「止まる」ことはできない。
 * - 次のティックも移動を続けるユニットは、他と重なっていてよい(通り抜け)
 * - 止まるユニットが重なったら、元からそこにいたユニットを優先し、
 *   いなければ乱数で 1 体を残す。残れなかったユニットは元のマスへ戻る(進めなかった扱い)
 * - 戻る先にも止まるユニットがいる、または通り抜けの途中で止まった場合は、最寄りの空きマスへ押し出す
 * 押し出したユニットの移動を返す。
 */
export function settleMoves(
  intents: MoveIntent[],
  units: Unit[],
  map: GameState['map'],
  rng: Rng,
  continues: (u: Unit) => boolean,
): { unit: Unit; from: Pos; to: Pos }[] {
  const intentOf = new Map(intents.map((m) => [m.unit.id, m]));
  const displaced: { unit: Unit; from: Pos; to: Pos }[] = [];
  const stoppers = () => units.filter((u) => !u.down && !continues(u));

  for (let guardLoop = 0; guardLoop < units.length * 4; guardLoop++) {
    const byTile = new Map<string, Unit[]>();
    for (const u of stoppers()) {
      const g = byTile.get(key(u));
      if (g) g.push(u);
      else byTile.set(key(u), [u]);
    }
    let conflict = [...byTile.values()].find((g) => g.length > 1);
    if (!conflict && !RULES.passThroughFoes) {
      // 敵のいるマスは通り抜けられない: 敵味方が同じマスにいたら整理の対象にする
      const all = new Map<string, Unit[]>();
      for (const u of units) if (!u.down) all.set(key(u), [...(all.get(key(u)) ?? []), u]);
      conflict = [...all.values()].find((g) => g.some((a) => g.some((b) => a.side !== b.side)));
      // 敵との入れ替わり(すれ違い)も通り抜けとみなし、両者を元のマスへ戻す
      if (!conflict) {
        const swap = intents.find((a) =>
          intents.some(
            (b) =>
              a.status === 'ok' && b.status === 'ok' && a.unit.side !== b.unit.side &&
              a.to.x === b.from.x && a.to.y === b.from.y && b.to.x === a.from.x && b.to.y === a.from.y,
          ),
        );
        if (swap) {
          const other = intents.find((b) => b.unit.x === swap.from.x && b.unit.y === swap.from.y && b.status === 'ok' && b.unit.side !== swap.unit.side)!;
          for (const m of [swap, other]) {
            m.status = 'blocked';
            m.unit.x = m.from.x;
            m.unit.y = m.from.y;
          }
          continue;
        }
      }
    }
    if (!conflict) break;

    const moved = (u: Unit) => intentOf.get(u.id)?.status === 'ok';
    // 優先順: 動かなかったユニット → 戻された・押し出されたユニット → 乱数で選んだ移動者
    const keeper =
      conflict.find((u) => !intentOf.has(u.id)) ??
      conflict.find((u) => !moved(u)) ??
      conflict[rng.int(0, conflict.length - 1)];
    for (const u of conflict) {
      if (u === keeper) continue;
      const m = intentOf.get(u.id);
      if (m && m.status === 'ok') {
        m.status = 'blocked';
        u.x = m.from.x;
        u.y = m.from.y;
        continue;
      }
      const from = pos(u);
      const to = nearestFree(map, u, units, continues);
      if (!to) continue;
      u.x = to.x;
      u.y = to.y;
      displaced.push({ unit: u, from, to });
    }
  }
  return displaced;
}

/** 止まるユニットがいない最寄りの床マス */
function nearestFree(map: GameState['map'], start: Pos, units: Unit[], continues: (u: Unit) => boolean): Pos | null {
  const taken = new Set(units.filter((u) => !u.down && !continues(u)).map(key));
  const seen = new Set([key(start)]);
  const queue: Pos[] = [pos(start)];
  for (let i = 0; i < queue.length && i < 400; i++) {
    const p = queue[i];
    for (const d of DIR_LIST) {
      const n = step(p, d);
      const k = key(n);
      if (seen.has(k) || !isWalkable(map, n.x, n.y)) continue;
      if (!taken.has(k)) return n;
      seen.add(k);
      queue.push(n);
    }
  }
  return null;
}

interface StrikeCtx {
  state: GameState;
  tick: number;
  /** 解決中のターン番号 */
  turn: number;
  map: GameState['map'];
  units: Unit[];
  byId: Map<string, Unit>;
  rng: Rng;
  guard: Set<string>;
  /** このティックにかばっている者 */
  cover: Set<string>;
  events: GameEvent[];
  hpDelta: Map<string, number>;
  revived: Set<string>;
  attackedBy: Map<string, string>;
  /** このティックに足払いを受けた者 */
  stuns: string[];
}

function rollDamage(ctx: StrikeCtx, base: number, variance: number, target: Unit, mult = 1): { amount: number; guarded: boolean } {
  const def = stats(target).def;
  let amount = Math.max(1, Math.round((base + ctx.rng.int(0, variance)) * mult) - def);
  const guarded = ctx.guard.has(target.id);
  if (guarded) amount = Math.ceil(amount / 2);
  return { amount, guarded };
}

interface DamageOpts {
  /** ダメージの倍率(強攻撃) */
  mult?: number;
  /** 近接攻撃。かばいで対象が替わった後の相手で、挟み撃ちを判定する */
  melee?: boolean;
  /** 単体攻撃なら、隣でかばっている味方が代わりに受ける */
  single?: boolean;
}

function dealDamage(ctx: StrikeCtx, attacker: Unit, target: Unit, base: number, variance: number, opts: DamageOpts = {}): void {
  if (opts.single) {
    const c = ctx.units.find((o) => o !== target && !o.down && o.side === target.side && ctx.cover.has(o.id) && adjacent(ctx.map, o, target));
    if (c) {
      ctx.events.push({ tick: ctx.tick, type: 'cover', id: c.id, for: target.id });
      target = c;
    }
  }
  const flank = !!opts.melee && RULES.flankMult !== 1 && flanked(ctx.map, ctx.units, attacker, target);
  const { amount, guarded } = rollDamage(ctx, base, variance, target, (opts.mult ?? 1) * (flank ? RULES.flankMult : 1));
  ctx.hpDelta.set(target.id, (ctx.hpDelta.get(target.id) ?? 0) - amount);
  ctx.events.push({ tick: ctx.tick, type: 'damage', id: target.id, amount, by: attacker.id, guarded, ...(flank ? { flank: true } : {}) });
  ctx.attackedBy.set(target.id, attacker.id);
}

function performStrike(ctx: StrikeCtx, st: StrikeIntent): void {
  const { unit: u, action, reaction } = st;
  const { tick, map, units, byId, events } = ctx;
  const def = stats(u);
  const fizzle = (reason: string): void => {
    events.push({ tick, type: 'fizzle', id: u.id, reason });
  };

  if (action.type === 'attack') {
    let target = byId.get(action.target);
    // 狙った敵が先に倒れていたら、届く別の敵に狙いを移す(反応の攻撃は除く)
    if ((!target || target.down) && RULES.retarget && !reaction) target = nextTarget(ctx, u, def.range);
    if (!target || target.down) return fizzle('対象がいない');
    const power = action.power ? RULES.powerMult : 1;
    if (def.range <= 1) {
      if (!adjacent(map, u, target)) return fizzle(REACH.adjacent);
      events.push({ tick, type: 'strike', id: u.id, kind: 'melee', target: target.id, hitId: target.id, end: pos(target), reaction });
      dealDamage(ctx, u, target, def.atk, def.dmgVar, { mult: power, single: true, melee: true });
      return;
    }
    const far = rangedProblem(map, u, target, def.range);
    if (far) return fizzle(far);
    // 射線上で最初に当たったユニットに命中する。
    // ただし撃つ瞬間に味方が射線上にいれば撃たない(AP は消費する)
    let hit: Unit | undefined;
    let end: Pos = pos(target);
    for (const p of linePoints(u, target)) {
      hit = units.find((o) => !o.down && o !== u && o.x === p.x && o.y === p.y);
      if (hit) {
        end = p;
        break;
      }
    }
    if (RULES.holdFireOnAlly && hit && hit !== target && hit.side === u.side) return fizzle(REACH.ally);
    events.push({ tick, type: 'strike', id: u.id, kind: 'ranged', target: target.id, hitId: hit?.id, end, reaction });
    if (hit) dealDamage(ctx, u, hit, def.atk, def.dmgVar, { mult: power, single: true });
    return;
  }

  // 回復薬: 自分か隣の立っている味方に。持ち物が尽きていれば不発
  if (action.type === 'item') {
    const target = byId.get(action.target);
    if (!target || target.down) return fizzle('対象が倒れている');
    if (!nearOrSame(map, u, target)) return fizzle(REACH.adjacent);
    const items = (ctx.state.items ??= {});
    if (!items[action.item]) return fizzle('薬がない');
    items[action.item]! -= 1;
    const it = ITEMS[action.item];
    events.push({ tick, type: 'strike', id: u.id, kind: 'potion', target: target.id, hitId: target.id, end: pos(target), reaction });
    if (action.item === 'hp') {
      ctx.hpDelta.set(target.id, (ctx.hpDelta.get(target.id) ?? 0) + it.amount);
      events.push({ tick, type: 'heal', id: target.id, amount: it.amount });
    } else {
      const gain = Math.min(it.amount, stats(target).maxMp - target.mp);
      target.mp += gain;
      events.push({ tick, type: 'heal', id: target.id, amount: gain, mp: true });
    }
    return;
  }

  // 魔法
  const sd = SPELLS[action.spell];
  const cost = spellMp(u, action.spell);
  const range = spellRange(u, action.spell);
  if (u.mp < cost) return fizzle('MP が足りない');
  u.mp -= cost;
  if (sd.target === 'tile') {
    const aim = action.tile!;
    let tile = aim;
    const far = rangedProblem(map, u, aim, range);
    // 火球は見えない(射線の通らない)マスにも撃てるが、着弾点が最大 1 マスずれる
    if (far === REACH.wall && action.spell === 'fireball') tile = scatterTile(ctx, aim);
    else if (far) return fizzle(far);
    const breath = action.spell === 'breath';
    if (breath && u.ai) u.ai.breathTurn = ctx.turn;
    const kind = breath ? 'breath' : action.spell === 'smite' || action.spell === 'hellfire' ? action.spell : 'fireball';
    const scatter = tile !== aim;
    events.push({ tick, type: 'strike', id: u.id, kind, tile: aim, end: tile, reaction, ...(scatter ? { scatter } : {}) });
    for (const o of units) {
      if (o.down || (sd.foesOnly && o.side === u.side)) continue;
      if (Math.max(Math.abs(o.x - tile.x), Math.abs(o.y - tile.y)) <= sd.radius) dealDamage(ctx, u, o, sd.power + spellBonus(u), sd.powerVar);
    }
    return;
  }
  const target = action.target ? byId.get(action.target) : undefined;
  if (!target) return fizzle('対象がいない');
  if (sd.target === 'foe') {
    // 足払い: 敵 1 体を数ティック動けなくする
    if (target.down || target.side === u.side) return fizzle('対象がいない');
    const far = rangedProblem(map, u, target, range);
    if (far) return fizzle(far);
    events.push({ tick, type: 'strike', id: u.id, kind: 'trip', target: target.id, hitId: target.id, end: pos(target), reaction });
    events.push({ tick, type: 'stun', id: target.id, ticks: RULES.stunTicks });
    ctx.stuns.push(target.id);
    ctx.attackedBy.set(target.id, u.id);
    return;
  }
  if (sd.target === 'ally') {
    if (target.down) return fizzle('対象が倒れている');
    const far = rangedProblem(map, u, target, range);
    if (far) return fizzle(far);
    const amount = sd.power + spellBonus(u) + ctx.rng.int(0, sd.powerVar);
    ctx.hpDelta.set(target.id, (ctx.hpDelta.get(target.id) ?? 0) + amount);
    events.push({ tick, type: 'strike', id: u.id, kind: 'heal', target: target.id, hitId: target.id, end: pos(target), reaction });
    events.push({ tick, type: 'heal', id: target.id, amount });
    return;
  }
  // 蘇生
  if (!target.down) return fizzle('対象が倒れていない');
  if (!nearOrSame(map, u, target)) return fizzle(REACH.adjacent);
  events.push({ tick, type: 'strike', id: u.id, kind: 'revive', target: target.id, hitId: target.id, end: pos(target), reaction });
  ctx.revived.add(target.id);
}

/**
 * 見えないマスを狙った火球の着弾点: 狙ったマスとその周り 8 マスのうち、壁でないマスから乱数で選ぶ
 * (狙ったマスに落ちることもある)。壁でないマスが無ければ狙ったマス
 */
function scatterTile(ctx: StrikeCtx, aim: Pos): Pos {
  const cells: Pos[] = [];
  for (let dy = -RULES.fireballScatter; dy <= RULES.fireballScatter; dy++)
    for (let dx = -RULES.fireballScatter; dx <= RULES.fireballScatter; dx++)
      if (isWalkable(ctx.map, aim.x + dx, aim.y + dy)) cells.push({ x: aim.x + dx, y: aim.y + dy });
  if (cells.length === 0) return aim;
  const p = cells[ctx.rng.int(0, cells.length - 1)];
  return p.x === aim.x && p.y === aim.y ? aim : p;
}

/** 狙いが倒れたときに移る先: 届く敵のうち最も近い者 */
function nextTarget(ctx: StrikeCtx, u: Unit, range: number): Unit | undefined {
  const reach = (f: Unit) => (range <= 1 ? adjacent(ctx.map, u, f) : dist2(u, f) <= range * range && hasLos(ctx.map, u, f));
  return ctx.units
    .filter((f) => f.side !== u.side && !f.down && reach(f))
    .sort((a, b) => dist2(u, a) - dist2(u, b) || a.id.localeCompare(b.id))[0];
}

/** 挟み撃ち: 対象を挟んで反対側(正面・斜め前)に、攻撃者の味方がいる */
function flanked(map: GameState['map'], units: Unit[], a: Unit, t: Unit): boolean {
  return units.some((o) => {
    // 味方も対象に攻撃が届く位置(壁の角越しでない隣接)にいること
    if (o === a || o.down || o.side !== a.side || !adjacent(map, o, t)) return false;
    const dx = o.x - t.x;
    const dy = o.y - t.y;
    return Math.max(Math.abs(dx), Math.abs(dy)) === 1 && dx * (a.x - t.x) + dy * (a.y - t.y) < 0;
  });
}

function pos(p: Pos): Pos {
  return { x: p.x, y: p.y };
}

function updateAiMemory(state: GameState, attackedBy: Map<string, string>, events: GameEvent[]): void {
  const { map, units } = state;
  const treasureTaken = state.objective?.kind === 'treasure' && !!state.objective.holder;
  for (const e of units) {
    if (e.side !== 'enemy' || e.down || !e.ai) continue;
    // 眠っている敵: 近く(射線が通る wakeRange 以内)で姿を見る・攻撃される・宝を拾われると起きる。仲間に呼ばれても起きない
    if (e.ai.asleep) {
      const near = units
        .filter((p) => p.side === 'party' && !p.down && manhattan(e, p) <= RULES.wakeRange && hasLos(map, e, p))
        .sort((a, b) => manhattan(e, a) - manhattan(e, b));
      const by = attackedBy.get(e.id);
      const attacker = by ? units.find((u) => u.id === by) : undefined;
      const holder = treasureTaken ? units.find((u) => u.id === (state.objective as { holder?: string }).holder) : undefined;
      const cause = near[0] ?? attacker ?? holder;
      if (!cause) continue;
      e.ai.asleep = false;
      e.ai.alerted = true;
      e.ai.lastSeen = pos(cause);
      events.push({ tick: TICKS_PER_TURN, type: 'awaken', id: e.id });
      continue;
    }
    const seen = units.filter((p) => p.side === 'party' && !p.down && unitSees(map, e, p));
    if (seen.length > 0) {
      seen.sort((a, b) => dist2(e, a) - dist2(e, b));
      e.ai.alerted = true;
      e.ai.lastSeen = pos(seen[0]);
      continue;
    }
    const by = attackedBy.get(e.id);
    const attacker = by ? units.find((u) => u.id === by) : undefined;
    if (attacker) {
      e.ai.alerted = true;
      e.ai.lastSeen = pos(attacker);
      continue;
    }
    // 最後に見た場所まで来ても誰もいなければ警戒を解く
    if (e.ai.alerted && e.ai.lastSeen && e.x === e.ai.lastSeen.x && e.y === e.ai.lastSeen.y) {
      e.ai.alerted = false;
      e.ai.lastSeen = undefined;
    }
    // 向かっていた巡回点に着いたら、次の巡回点を目標にする
    const patrol = e.ai.patrol;
    if (patrol && patrol.length > 0) {
      const i = e.ai.patrolIndex ?? 0;
      if (e.x === patrol[i].x && e.y === patrol[i].y) e.ai.patrolIndex = (i + 1) % patrol.length;
    }
  }

  // 仲間を呼ぶ: パーティを見た・攻撃された敵の近くにいる、まだ気付いていない敵も同じ場所へ向かう
  if (RULES.aiCallRange <= 0) return;
  const callers = units.filter((e) => e.side === 'enemy' && !e.down && e.ai?.alerted && e.ai.lastSeen);
  for (const e of units) {
    if (e.side !== 'enemy' || e.down || !e.ai || e.ai.alerted || e.ai.asleep) continue;
    const caller = callers.find((c) => c !== e && manhattan(c, e) <= RULES.aiCallRange);
    if (!caller) continue;
    e.ai.alerted = true;
    e.ai.lastSeen = pos(caller.ai!.lastSeen!);
  }
}

/**
 * 休憩: ターンの開始時も終了時も敵が見えず、誰も攻撃を受けていなければ、
 * 立っている味方は待機したティック数に応じて HP と MP が回復する(8 ティック全部で最大 HP の restHpRatio と restMp)。
 * 気絶者は回復しない。
 */
/**
 * 休憩: ターンの終わりに、立っている味方が休憩(待機)したティック数に応じて HP・MP を回復する。
 * 敵が見えていても、ダメージを受けていても回復する(休憩は防御しないので、その分ダメージは減らない)。
 * ただし戦闘中(ターンの初めか終わりに敵が見えている)は、回復量に RULES.combatRestRatio を掛ける
 */
function applyRest(state: GameState, plans: Plans, foesAtStart: boolean, events: GameEvent[], frames: UnitSnapshot[][]): void {
  const party = state.units.filter((u) => u.side === 'party' && !u.down);
  if (party.length === 0) return;
  const combat = foesAtStart || visibleFoes(state.map, state.units, 'party').size > 0;
  const ratio = combat ? RULES.combatRestRatio : 1;
  for (const u of party) {
    const k = (restTicks(plans[u.id]) / TICKS_PER_TURN) * ratio;
    if (k <= 0) continue;
    const d = stats(u);
    const hp = Math.min(d.maxHp - u.hp, Math.max(1, Math.round(d.maxHp * RULES.restHpRatio * k)));
    const mp = Math.min(d.maxMp - u.mp, Math.round(RULES.restMp * k));
    if (hp <= 0 && mp <= 0) continue;
    u.hp += hp;
    u.mp += mp;
    events.push({ tick: TICKS_PER_TURN, type: 'rest', id: u.id, hp, mp });
  }
  // 最終フレームにも回復後の値を反映する
  const last = frames[frames.length - 1];
  for (const s of last) {
    const u = state.units.find((x) => x.id === s.id)!;
    s.hp = u.hp;
    s.mp = u.mp;
  }
}

/** このターンに倒れた敵の経験値を、パーティ全員に配る。レベルが上がれば最終フレームの HP・MP にも反映する */
function applyExp(state: GameState, foesAtStart: Unit[], events: GameEvent[], frames: UnitSnapshot[][]): void {
  const amount = foesAtStart.filter((u) => u.down).reduce((a, u) => a + (unitDef(u.defId).exp ?? 0), 0);
  if (amount <= 0) return;
  gainExp(state.units, amount, events);
  for (const s of frames[frames.length - 1]) {
    const u = state.units.find((x) => x.id === s.id)!;
    s.hp = u.hp;
    s.mp = u.mp;
  }
}

function judge(state: GameState): GameState['status'] {
  if (state.units.filter((u) => u.side === 'party').every((u) => u.down)) return 'lost';
  const o = state.objective;
  if (o?.kind === 'treasure') {
    // 宝を持った味方が、立ったまま地下 1 階の入口の階段に戻れば勝ち
    const h = o.holder ? state.units.find((u) => u.id === o.holder) : undefined;
    return h && !h.down && currentFloor(state) === 1 && tileAt(state.map, h.x, h.y) === 'S' ? 'won' : 'playing';
  }
  if (o?.kind === 'escape') {
    // 救出: 対象(気絶していても、担がれていてもよい)が出口の階段のマスでターンを終えたら勝ち
    const w = state.units.find((u) => u.id === o.who);
    return w && tileAt(state.map, w.x, w.y) === 'S' ? 'won' : 'playing';
  }
  if (state.units.filter((u) => u.side === 'enemy').every((u) => u.down)) return 'won';
  return 'playing';
}
