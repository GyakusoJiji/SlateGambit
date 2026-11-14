// 同時解決エンジン。全ユニットの予約を 1 ティックずつ同時に処理する。
import { SPELLS, unitDef } from '../data/units';
import { expandPlan, type Step } from './actions';
import { hasLos, linePoints } from './los';
import { dist2, isWalkable, manhattan, step } from './map';
import { pathAdjacent } from './path';
import { triggerReaction } from './reactions';
import { Rng } from './rng';
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
  action: Extract<Action, { type: 'attack' | 'spell' }>;
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
  const watching = new Set<string>();
  const frames: UnitSnapshot[][] = [snapshot(units, guard, watching)];
  /** このターンに攻撃してきた相手(AI の警戒用) */
  const attackedBy = new Map<string, string>();

  for (let tick = 1; tick <= TICKS_PER_TURN; tick++) {
    const ti = tick - 1;
    guard.clear();
    watching.clear();

    // ① 防御・構えの更新
    const current = new Map<string, Step>();
    for (const u of units) {
      if (u.down) continue;
      const s = steps.get(u.id)![ti];
      current.set(u.id, s);
      if (s.k === 'guard') guard.add(u.id);
      if (s.k === 'watch') watching.add(u.id);
    }

    // ② 移動
    const intents: MoveIntent[] = [];
    for (const [id, s] of current) {
      const u = byId.get(id)!;
      let to: Pos | null = null;
      if (s.k === 'move') {
        to = step(u, s.action.dir);
      } else if (s.k === 'follow' || s.k === 'escort') {
        const t = byId.get(s.target);
        if (t && manhattan(u, t) > 1 && !(s.k === 'follow' && t.down)) {
          // 他のユニットを避けて回り込む。空いた隣接マスが無ければその場で待つ
          const occupied = (p: Pos) => units.some((o) => o !== u && o !== t && !o.down && o.x === p.x && o.y === p.y);
          const p = pathAdjacent(map, u, t, occupied);
          if (p && p.length > 0) to = step(u, p[0]);
        }
      }
      if (to) intents.push({ unit: u, from: { x: u.x, y: u.y }, to, status: 'pending' });
    }
    resolveMoves(intents, units, map, rng);
    for (const m of intents) {
      if (m.status === 'ok') {
        m.unit.x = m.to.x;
        m.unit.y = m.to.y;
        events.push({ tick, type: 'move', id: m.unit.id, from: m.from, to: m.to });
      } else {
        events.push({ tick, type: 'bump', id: m.unit.id, at: m.to });
      }
    }

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
        for (let i = tick; i < list.length; i++) {
          const k = list[i].k;
          if (k === 'move' || k === 'follow' || k === 'escort') list[i] = { k: 'guard' };
        }
        events.push({ tick, type: 'halt', id: u.id });
      }
    }

    // ③ 条件付き行動の発動
    const strikes: StrikeIntent[] = [];
    for (const id of watching) {
      const u = byId.get(id)!;
      const s = current.get(id);
      if (s?.k !== 'watch') continue;
      const target = triggerReaction(map, u, s.mode, units);
      if (!target) continue;
      strikes.push({ unit: u, action: { type: 'attack', target: target.id }, reaction: true });
      // 発動した攻撃の残りコスト(1 ティック)を消費する
      const list = steps.get(id)!;
      if (tick < list.length) list[tick] = { k: 'recover' };
    }

    // ④ 攻撃・魔法を同時適用
    for (const [id, s] of current) {
      if (s.k === 'strike') strikes.push({ unit: byId.get(id)!, action: s.action, reaction: false });
    }
    const hpDelta = new Map<string, number>();
    const revived = new Set<string>();
    const ctx: StrikeCtx = { tick, map, units, byId, rng, guard, events, hpDelta, revived, attackedBy };
    for (const st of strikes) performStrike(ctx, st);

    for (const [id, d] of hpDelta) {
      const u = byId.get(id)!;
      u.hp = Math.max(0, Math.min(unitDef(u.defId).maxHp, u.hp + d));
    }
    for (const id of revived) {
      const u = byId.get(id)!;
      u.down = false;
      u.hp = Math.max(u.hp, SPELLS.revive.power);
      events.push({ tick, type: 'revive', id });
    }

    // ⑤ 戦闘不能判定(相打ちあり)
    for (const u of units) {
      if (!u.down && u.hp <= 0) {
        u.down = true;
        u.hp = 0;
        events.push({ tick, type: 'down', id: u.id });
      }
    }

    updateExplored(state);
    frames.push(snapshot(units, guard, watching));
  }

  updateAiMemory(state, attackedBy);
  state.rng = rng.state;
  state.turn += 1;
  state.status = judge(state);
  return { state, events, frames };
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
  }));
}

/**
 * 移動の競合解決。
 * - 同じマスへの同時進入は乱数で 1 体だけ成功
 * - 入れ替わり(すれ違い)は両者失敗
 * - 動かない・失敗したユニットのいるマスへは入れない
 * - 3 体以上の循環も失敗とする
 */
export function resolveMoves(intents: MoveIntent[], units: Unit[], map: GameState['map'], rng: Rng): void {
  for (const m of intents) {
    if (!isWalkable(map, m.to.x, m.to.y)) m.status = 'blocked';
  }
  const groups = new Map<string, MoveIntent[]>();
  for (const m of intents) {
    if (m.status !== 'pending') continue;
    const k = key(m.to);
    const g = groups.get(k);
    if (g) g.push(m);
    else groups.set(k, [m]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const win = rng.int(0, g.length - 1);
    g.forEach((m, i) => {
      if (i !== win) m.status = 'blocked';
    });
  }

  const occupant = new Map<string, Unit>();
  for (const u of units) if (!u.down) occupant.set(key(u), u);
  const intentOf = new Map(intents.map((m) => [m.unit.id, m]));

  let changed = true;
  while (changed) {
    changed = false;
    for (const m of intents) {
      if (m.status !== 'pending') continue;
      const occ = occupant.get(key(m.to));
      let next: MoveIntent['status'] | null = null;
      if (!occ) next = 'ok';
      else {
        const oi = intentOf.get(occ.id);
        if (!oi || oi.status === 'blocked') next = 'blocked';
        else if (oi.status === 'ok') next = 'ok';
        else if (oi.to.x === m.from.x && oi.to.y === m.from.y) next = 'blocked';
      }
      if (next) {
        m.status = next;
        changed = true;
      }
    }
  }
  for (const m of intents) if (m.status === 'pending') m.status = 'blocked';
}

interface StrikeCtx {
  tick: number;
  map: GameState['map'];
  units: Unit[];
  byId: Map<string, Unit>;
  rng: Rng;
  guard: Set<string>;
  events: GameEvent[];
  hpDelta: Map<string, number>;
  revived: Set<string>;
  attackedBy: Map<string, string>;
}

function rollDamage(ctx: StrikeCtx, base: number, variance: number, target: Unit): { amount: number; guarded: boolean } {
  const def = unitDef(target.defId).def;
  let amount = Math.max(1, base + ctx.rng.int(0, variance) - def);
  const guarded = ctx.guard.has(target.id);
  if (guarded) amount = Math.ceil(amount / 2);
  return { amount, guarded };
}

function dealDamage(ctx: StrikeCtx, attacker: Unit, target: Unit, base: number, variance: number): void {
  const { amount, guarded } = rollDamage(ctx, base, variance, target);
  ctx.hpDelta.set(target.id, (ctx.hpDelta.get(target.id) ?? 0) - amount);
  ctx.events.push({ tick: ctx.tick, type: 'damage', id: target.id, amount, by: attacker.id, guarded });
  ctx.attackedBy.set(target.id, attacker.id);
}

function performStrike(ctx: StrikeCtx, st: StrikeIntent): void {
  const { unit: u, action, reaction } = st;
  const { tick, map, units, byId, events } = ctx;
  const def = unitDef(u.defId);
  const fizzle = (reason: string): void => {
    events.push({ tick, type: 'fizzle', id: u.id, reason });
  };

  if (action.type === 'attack') {
    const target = byId.get(action.target);
    if (!target || target.down) return fizzle('対象がいない');
    if (def.range <= 1) {
      if (manhattan(u, target) !== 1) return fizzle('届かない');
      events.push({ tick, type: 'strike', id: u.id, kind: 'melee', target: target.id, hitId: target.id, end: pos(target), reaction });
      dealDamage(ctx, u, target, def.atk, def.dmgVar);
      return;
    }
    if (dist2(u, target) > def.range * def.range || !hasLos(map, u, target)) return fizzle('射線が通らない');
    // 射線上で最初に当たったユニットに命中する(味方でも)
    let hit: Unit | undefined;
    let end: Pos = pos(target);
    for (const p of linePoints(u, target)) {
      hit = units.find((o) => !o.down && o !== u && o.x === p.x && o.y === p.y);
      if (hit) {
        end = p;
        break;
      }
    }
    events.push({ tick, type: 'strike', id: u.id, kind: 'ranged', target: target.id, hitId: hit?.id, end, reaction });
    if (hit) dealDamage(ctx, u, hit, def.atk, def.dmgVar);
    return;
  }

  // 魔法
  const sd = SPELLS[action.spell];
  if (u.mp < sd.mp) return fizzle('MP が足りない');
  u.mp -= sd.mp;
  if (sd.target === 'tile') {
    const tile = action.tile!;
    if (dist2(u, tile) > sd.range * sd.range || !hasLos(map, u, tile)) return fizzle('射線が通らない');
    events.push({ tick, type: 'strike', id: u.id, kind: 'fireball', tile, end: tile, reaction });
    for (const o of units) {
      if (o.down) continue;
      if (Math.max(Math.abs(o.x - tile.x), Math.abs(o.y - tile.y)) <= sd.radius) dealDamage(ctx, u, o, sd.power, sd.powerVar);
    }
    return;
  }
  const target = action.target ? byId.get(action.target) : undefined;
  if (!target) return fizzle('対象がいない');
  if (sd.target === 'ally') {
    if (target.down) return fizzle('対象が倒れている');
    if (dist2(u, target) > sd.range * sd.range || !hasLos(map, u, target)) return fizzle('届かない');
    const amount = sd.power + ctx.rng.int(0, sd.powerVar);
    ctx.hpDelta.set(target.id, (ctx.hpDelta.get(target.id) ?? 0) + amount);
    events.push({ tick, type: 'strike', id: u.id, kind: 'heal', target: target.id, hitId: target.id, end: pos(target), reaction });
    events.push({ tick, type: 'heal', id: target.id, amount });
    return;
  }
  // 蘇生
  if (!target.down) return fizzle('対象が倒れていない');
  if (manhattan(u, target) > sd.range) return fizzle('届かない');
  events.push({ tick, type: 'strike', id: u.id, kind: 'revive', target: target.id, hitId: target.id, end: pos(target), reaction });
  ctx.revived.add(target.id);
}

function pos(p: Pos): Pos {
  return { x: p.x, y: p.y };
}

function updateAiMemory(state: GameState, attackedBy: Map<string, string>): void {
  const { map, units } = state;
  for (const e of units) {
    if (e.side !== 'enemy' || e.down || !e.ai) continue;
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
}

function judge(state: GameState): GameState['status'] {
  if (state.units.filter((u) => u.side === 'party').every((u) => u.down)) return 'lost';
  // 第 1 区間の暫定条件: 敵の全滅で勝利(宝と帰還は探索要素の実装時に置き換える)
  if (state.units.filter((u) => u.side === 'enemy').every((u) => u.down)) return 'won';
  return 'playing';
}
