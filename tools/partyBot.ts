// バランス検証用のパーティ自動操作。人間の「そこそこ上手い」プレイを素朴に真似る。
// 敵の計画は見ない(プレイヤーと同じく、見えている敵の現在位置だけで判断する)。
import { RULES, apLeft, fillPlan } from '../src/core/actions';
import { hasLos, linePoints } from '../src/core/los';
import { adjacent, chebyshev, DIR_LIST, dist2, isWalkable, manhattan, nearOrSame, step, tileAt } from '../src/core/map';
import { findPath, pathAdjacent, pathTo } from '../src/core/path';
import type { Action, Dir, GameState, Plans, Pos, Unit } from '../src/core/types';
import { visibleFoes } from '../src/core/vision';
import { ITEMS, SPELLS } from '../src/data/units';
import { pendingPerk, spellMp, spellRange, stats } from '../src/core/stats';
import { currentFloor, treasureHere } from '../src/core/floors';
import { FLOORS } from '../src/core/generate';

/** 下り階段を見つけていれば、床のこの割合を探索した時点で降りる(宝箱・経験値と、時間の兼ね合い) */
export const BOT = {
  /** HP の割合がこれ未満なら、戦闘中に HP 回復薬を飲む */
  potionAt: 0.3,
  /** 泉で HP 回復薬をこの数まで買う */
  potionStock: 3,
  /** 泉で食料をこの数まで買う */
  foodStock: 8,
  /** 成長の二択で選ぶもの */
  perk: 'fireMp',
  descendAt: 0.7,
  /** 特技を使うか(比較用に個別に切れる) */
  use: { cover: true, power: true, trip: true, smite: true },
};

const ORDER = ['warrior', 'thief', 'priest', 'mage'];

/**
 * 泉の店: 敵が見えない間に誰かが泉にいれば、食料を BOT.foodStock 個まで、HP 回復薬を BOT.potionStock 個まで買う(状態を直接書き換える)。
 * 自動対戦の進行役が、計画を立てる前に呼ぶ
 */
export function botShop(state: GameState): void {
  if (visibleFoes(state.map, state.units, 'party').size > 0) return;
  if (!state.units.some((u) => u.side === 'party' && !u.down && tileAt(state.map, u.x, u.y) === 'H')) return;
  // 休憩に要る食料を先に買い、残りで HP 回復薬を買う
  const buy = (k: 'hp' | 'food', upTo: number) => {
    while ((state.items?.[k] ?? 0) < upTo && (state.gold ?? 0) >= ITEMS[k].price) {
      state.gold = (state.gold ?? 0) - ITEMS[k].price;
      state.items = { ...state.items, [k]: (state.items?.[k] ?? 0) + 1 };
    }
  };
  buy('food', BOT.foodStock);
  buy('hp', BOT.potionStock);
}

/** 成長の二択: まだ選んでいなければ BOT.perk(無ければ最初の候補)を選ぶ(状態を直接書き換える) */
export function botPerks(state: GameState): void {
  for (const u of state.units) {
    const c = pendingPerk(u);
    if (c) u.perks = [...(u.perks ?? []), c.includes(BOT.perk) ? BOT.perk : c[0]];
  }
}

export function planParty(state: GameState): Plans {
  const { map, units } = state;
  const party = units.filter((u) => u.side === 'party' && !u.down).sort((a, b) => ORDER.indexOf(a.defId) - ORDER.indexOf(b.defId));
  const seenIds = visibleFoes(map, units, 'party');
  // 眠っている敵には手を出さない(宝探しで、起こさずに宝を持ち出すことを狙う)
  const foes = units.filter((u) => seenIds.has(u.id) && !u.down && !u.ai?.asleep);
  const plans: Plans = {};
  if (party.length === 0) return plans;

  if (foes.length === 0) {
    // 倒れた仲間がいて僧侶が蘇生できるなら、まず助けに行く
    const priestU = party.find((u) => u.defId === 'priest');
    const downed = units.some((u) => u.side === 'party' && u.down);
    if (downed && priestU && priestU.mp >= SPELLS.revive.mp) {
      const ctx: Ctx = { state, u: priestU, plan: [], pos: { x: priestU.x, y: priestU.y }, foes: [], endPos: new Map(), reserved: new Set() };
      priest(ctx);
      // 近づけない(敵が上に立っているなど)ときは諦めて、ほかの行動に回す
      if (ctx.plan.some((a) => a.type === 'move' || a.type === 'spell')) return { [priestU.id]: ctx.plan };
    }
    // 傷んでいる、または MP が少なければ休憩する(全員待機)
    const tired = party.some((u) => {
      const d = stats(u);
      return u.hp / d.maxHp < 0.6 || (d.maxMp > 0 && u.mp / d.maxMp < 0.5);
    });
    // 眠っている敵が見えている間・食料が無いときは休憩しても回復しないので、休まずに進む
    if (tired && seenIds.size === 0 && (state.items?.food ?? 0) > 0) return {};
    return explore(state, party);
  }

  /** 先に計画した味方の予定位置(火球の巻き込み回避に使う) */
  const endPos = new Map<string, Pos>();
  const reserved = new Set<string>();
  let potions = state.items?.hp ?? 0;
  for (const u of party) {
    const plan: Action[] = [];
    // HP が少なければ、まず HP 回復薬を飲む
    if (potions > 0 && u.hp / stats(u).maxHp < BOT.potionAt) {
      plan.push({ type: 'item', item: 'hp', target: u.id });
      potions--;
    }
    const ctx: Ctx = { state, u, plan, pos: { x: u.x, y: u.y }, foes, endPos, reserved };
    reserved.add(key(ctx.pos));
    switch (u.defId) {
      case 'warrior':
        melee(ctx);
        break;
      case 'thief':
        archer(ctx);
        break;
      case 'mage':
        mage(ctx);
        break;
      case 'priest':
        priest(ctx);
        break;
    }
    // UI と同じく、戦闘中に余った AP は防御で埋める
    plans[u.id] = fillPlan(plan, 'guard');
    endPos.set(u.id, ctx.pos);
  }
  return plans;
}

interface Ctx {
  state: GameState;
  u: Unit;
  plan: Action[];
  pos: Pos;
  foes: Unit[];
  endPos: Map<string, Pos>;
  /** 先に計画した味方が通る予定のマス */
  reserved: Set<string>;
}

/** 経路で通れないマス。味方のマスは通り抜けられるので、敵だけ */
function occupied(ctx: Ctx): (p: Pos) => boolean {
  return (p) => ctx.state.units.some((o) => o !== ctx.u && !o.down && o.side !== ctx.u.side && o.x === p.x && o.y === p.y);
}

/**
 * 経路に沿って進む(keepAp は残す)。味方のマスは通り抜けられるが止まれないので、
 * 止まる位置に味方(今いる位置か、先に決めた予定位置)がいれば手前まで戻す
 */
function moveAlong(ctx: Ctx, dirs: Dir[], keepAp: number): void {
  const room = Math.max(0, apLeft(ctx.plan) - keepAp);
  const path = dirs.slice(0, room);
  const cells: Pos[] = [];
  let p = ctx.pos;
  for (const d of path) cells.push((p = step(p, d)));
  const ends = [...ctx.endPos.values()];
  const taken = (q: Pos) =>
    ctx.state.units.some((o) => o !== ctx.u && !o.down && o.x === q.x && o.y === q.y) || ends.some((e) => e.x === q.x && e.y === q.y);
  while (cells.length > 0 && taken(cells[cells.length - 1])) {
    cells.pop();
    path.pop();
  }
  for (let i = 0; i < path.length; i++) {
    ctx.plan.push({ type: 'move', dir: path[i] });
    ctx.pos = cells[i];
    ctx.reserved.add(key(ctx.pos));
  }
}

const key = (p: Pos) => `${p.x},${p.y}`;

function fill(ctx: Ctx, a: Action): void {
  while (apLeft(ctx.plan) >= (a.type === 'attack' ? RULES.attackCost : 1)) ctx.plan.push(a);
}

function nearest(from: Pos, list: Unit[]): Unit {
  return [...list].sort((a, b) => manhattan(from, a) - manhattan(from, b) || a.hp - b.hp)[0];
}

function melee(ctx: Ctx): void {
  const f = nearest(ctx.pos, ctx.foes);
  if (!f) return fill(ctx, { type: 'guard' });
  const map = ctx.state.map;
  const canSkill = ctx.u.defId === 'warrior';
  // かばう: 隣に傷んだ仲間がいて、その仲間の近くに敵がいるなら、まず庇う
  if (BOT.use.cover && canSkill) {
    const friend = ctx.state.units.find(
      (o) => o.side === 'party' && !o.down && o !== ctx.u && adjacent(map, ctx.pos, o) && o.hp / stats(o).maxHp < 0.7 && ctx.foes.some((e) => chebyshev(e, o) <= 2),
    );
    if (friend) ctx.plan.push({ type: 'cover' });
  }
  if (!adjacent(map, ctx.pos, f) && !ctx.plan.some((a) => a.type === 'cover')) {
    const path = pathAdjacent(map, ctx.pos, f, occupied(ctx)) ?? [];
    moveAlong(ctx, path, RULES.attackCost);
  }
  if (adjacent(map, ctx.pos, f)) {
    // 敵の体力が多いなら、強攻撃(5AP)+通常攻撃で押し切る
    if (BOT.use.power && canSkill && apLeft(ctx.plan) >= RULES.powerCost && f.hp > stats(ctx.u).atk * 2) {
      ctx.plan.push({ type: 'attack', target: f.id, power: true });
    }
    fill(ctx, { type: 'attack', target: f.id });
  } else if (chebyshev(ctx.pos, f) <= 3 && apLeft(ctx.plan) >= 1) ctx.plan.push({ type: 'intercept', ticks: apLeft(ctx.plan) });
  fill(ctx, { type: 'guard' });
}

function clearShot(state: GameState, from: Pos, f: Unit, self: Unit, reserved?: Set<string>): boolean {
  const r = stats(self).range;
  if (dist2(from, f) > r * r || !hasLos(state.map, from, f)) return false;
  return linePoints(from, f).every(
    (p) => (p.x === f.x && p.y === f.y) || (!reserved?.has(key(p)) && !state.units.some((o) => o !== self && !o.down && o.x === p.x && o.y === p.y)),
  );
}

function archer(ctx: Ctx): void {
  const { state, u } = ctx;
  // 足払い: 仲間に近づいている敵を 1 体止める(止めている間に仲間が攻撃できる)
  if (BOT.use.trip && u.defId === 'thief' && u.mp >= SPELLS.trip.mp && ctx.foes.length >= 2) {
    const allies = state.units.filter((o) => o.side === 'party' && !o.down);
    const reach = (f: Unit) => dist2(ctx.pos, f) <= SPELLS.trip.range ** 2 && hasLos(state.map, ctx.pos, f);
    const t = ctx.foes
      .filter(reach)
      .filter((f) => allies.some((o) => chebyshev(o, f) <= 3))
      .sort((a, b) => stats(b).maxHp - stats(a).maxHp)[0];
    if (t) ctx.plan.push({ type: 'spell', spell: 'trip', target: t.id });
  }
  const shootable = ctx.foes.filter((f) => clearShot(state, ctx.pos, f, u, ctx.reserved));
  if (shootable.length === 0) {
    // 射線の通るマスへ向かう(撃つ分の AP は残す)
    const path = findPath(state.map, ctx.pos, (p) => ctx.foes.some((f) => clearShot(state, p, f, u, ctx.reserved)), occupied(ctx), 2000);
    if (path) moveAlong(ctx, path, RULES.attackCost);
  }
  const now = ctx.foes.filter((f) => clearShot(state, ctx.pos, f, u, ctx.reserved));
  if (now.length > 0) {
    const t = nearest(ctx.pos, now);
    fill(ctx, { type: 'attack', target: t.id });
  }
  if (apLeft(ctx.plan) > 0) ctx.plan.push({ type: 'overwatch', ticks: apLeft(ctx.plan) });
}

function mage(ctx: Ctx): void {
  const { state, u } = ctx;
  const fb = { ...SPELLS.fireball, range: spellRange(u, 'fireball'), mp: spellMp(u, 'fireball') };
  const allies = () =>
    state.units
      .filter((o) => o.side === 'party' && !o.down && o !== u)
      .map((o) => ctx.endPos.get(o.id) ?? { x: o.x, y: o.y });
  const score = (tile: Pos) => {
    const near = (p: Pos) => Math.max(Math.abs(p.x - tile.x), Math.abs(p.y - tile.y)) <= fb.radius;
    const hitFoes = ctx.foes.filter(near).length;
    const hitAllies = allies().filter(near).length + (near(ctx.pos) ? 1 : 0);
    return hitFoes - hitAllies * 3;
  };
  const castable = (from: Pos, tile: Pos) => dist2(from, tile) <= fb.range * fb.range && hasLos(state.map, from, tile);
  if (u.mp >= fb.mp) {
    let best: { tile: Pos; s: number } | null = null;
    for (const f of ctx.foes) {
      const s = score(f);
      if (s > 0 && (!best || s > best.s)) best = { tile: { x: f.x, y: f.y }, s };
    }
    if (best) {
      if (!castable(ctx.pos, best.tile)) {
        const tile = best.tile;
        const path = findPath(state.map, ctx.pos, (p) => castable(p, tile), occupied(ctx), 300);
        if (path) moveAlong(ctx, path, RULES.spellCost);
      }
      if (castable(ctx.pos, best.tile)) ctx.plan.push({ type: 'spell', spell: 'fireball', tile: best.tile });
    }
  }
  // 残りの AP で、その場から射線の通る敵を杖で撃つ
  const shootable = ctx.foes.filter((f) => clearShot(state, ctx.pos, f, u, ctx.reserved));
  if (shootable.length > 0) {
    const t = nearest(ctx.pos, shootable);
    while (apLeft(ctx.plan) >= RULES.attackCost) ctx.plan.push({ type: 'attack', target: t.id });
  }
  retreatOrGuard(ctx);
}

function priest(ctx: Ctx): void {
  const { state, u } = ctx;
  const allies = state.units.filter((o) => o.side === 'party' && o !== u);
  const downed = allies.filter((o) => o.down);
  if (downed.length > 0 && u.mp >= SPELLS.revive.mp) {
    const t = nearest(ctx.pos, downed);
    if (!nearOrSame(state.map, ctx.pos, t)) moveAlong(ctx, pathAdjacent(state.map, ctx.pos, t, occupied(ctx)) ?? [], RULES.spellCost);
    if (nearOrSame(state.map, ctx.pos, t)) {
      ctx.plan.push({ type: 'spell', spell: 'revive', target: t.id });
      return retreatOrGuard(ctx);
    }
  }
  const hurt = allies
    .filter((o) => !o.down && o.hp / stats(o).maxHp < 0.5)
    .filter((o) => dist2(ctx.pos, o) <= SPELLS.heal.range ** 2 && hasLos(state.map, ctx.pos, o))
    .sort((a, b) => a.hp / stats(a).maxHp - b.hp / stats(b).maxHp);
  if (hurt.length > 0 && u.mp >= SPELLS.heal.mp) ctx.plan.push({ type: 'spell', spell: 'heal', target: hurt[0].id });
  else if (BOT.use.smite && u.defId === 'priest' && u.mp >= SPELLS.smite.mp + SPELLS.heal.mp && ctx.foes.length > 0) {
    // 聖光: 敵が 2 体以上固まっている所へ(MP に余裕があれば 1 体でも)。回復の分の MP は残す
    const sm = SPELLS.smite;
    const near = (t: Pos, p: Pos) => chebyshev(t, p) <= sm.radius;
    const best = ctx.foes
      .filter((f) => dist2(ctx.pos, f) <= sm.range ** 2 && hasLos(state.map, ctx.pos, f))
      .map((f) => ({ f, n: ctx.foes.filter((o) => near(f, o)).length }))
      .sort((a, b) => b.n - a.n)[0];
    if (best && (best.n >= 2 || u.mp >= 10)) ctx.plan.push({ type: 'spell', spell: 'smite', tile: { x: best.f.x, y: best.f.y } });
  }
  // 立っている仲間がいなければ、自分で戦うしかない
  if (ctx.plan.length === 0 && allies.every((o) => o.down)) return melee(ctx);
  retreatOrGuard(ctx);
}

/** 敵が近ければ 1〜2 歩下がり、残りは防御 */
function retreatOrGuard(ctx: Ctx): void {
  const f = nearest(ctx.pos, ctx.foes);
  if (f && chebyshev(ctx.pos, f) <= 2 && apLeft(ctx.plan) >= 1) {
    for (let i = 0; i < 2 && apLeft(ctx.plan) > 0; i++) {
      const d = DIR_LIST.find((d) => {
        const n = step(ctx.pos, d);
        return isWalkable(ctx.state.map, n.x, n.y) && !occupied(ctx)(n) && chebyshev(n, f) > chebyshev(ctx.pos, f);
      });
      if (!d) break;
      ctx.plan.push({ type: 'move', dir: d });
      ctx.pos = step(ctx.pos, d);
    }
  }
  fill(ctx, { type: 'guard' });
}

/**
 * 敵が見えない間の移動(蛇行隊列)。
 * 目標に最も近い者が先頭になって進み、残りは 1 人前の者が通った跡をなぞる。
 * 前の者が空けたマスへ同じティックに入るので、同時解決でも詰まらない。全員「発見で停止」付き。
 */
function explore(state: GameState, party: Unit[]): Plans {
  const { map } = state;
  const plans: Plans = {};
  const unexplored = (x: number, y: number) => x >= 0 && y >= 0 && x < map.w && y < map.h && !state.explored[y * map.w + x];
  const frontier = (p: Pos) =>
    DIR_LIST.some((d) => {
      const n = step(p, d);
      return unexplored(n.x, n.y) && isWalkable(map, n.x, n.y);
    });
  const tile = (p: Pos) => map.tiles[p.y][p.x];
  const seen = (p: Pos) => !!state.explored[p.y * map.w + p.x];
  const floorCells = map.tiles.join('').split('').filter((c) => c !== '#').length;
  const exploredCells = state.explored.reduce((a, b) => a + b, 0);
  const anyFrontier = state.explored.some((e, i) => !e && map.tiles[(i / map.w) | 0][i % map.w] !== '#');
  // 全域を探索済みなら、生き残りの敵の隣を目標にする(巡回中の敵を探す代わり)
  const foe = state.units.find((u) => u.side === 'enemy' && !u.down && !u.ai?.asleep);
  let goal: (p: Pos) => boolean = anyFrontier ? frontier : (p: Pos) => !!foe && adjacent(map, p, foe);
  let candidates = party;
  /** 目標の階段('S' か '>')。それ以外の階段は経路で避ける(止まっても移らないが、道をふさがないように) */
  let goalStair: string | null = null;
  const obj = state.objective;
  const holder = obj?.kind === 'treasure' ? party.find((u) => u.id === obj.holder) : undefined;
  const treasure = treasureHere(state);
  const known = (c: string) => {
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) if (map.tiles[y][x] === c && seen({ x, y })) return true;
    return false;
  };
  const escapee = obj?.kind === 'escape' ? party.find((u) => u.id === obj.who) : undefined;
  if (escapee) {
    // 救出: 起きている対象を先頭に出口へ(気絶中は僧侶の蘇生を待つ)
    goal = (p: Pos) => tile(p) === 'S';
    candidates = [escapee];
    goalStair = 'S';
  } else if (holder) {
    // 秘宝を持っていれば、持ち主を先頭に上り階段(地下 1 階では入口)へ
    goal = (p: Pos) => tile(p) === 'S';
    candidates = [holder];
    goalStair = 'S';
  } else if (treasure && seen(treasure)) {
    goal = (p: Pos) => p.x === treasure.x && p.y === treasure.y;
  } else if (known('$')) {
    goal = (p: Pos) => tile(p) === '$' && seen(p);
  } else if (currentFloor(state) < FLOORS && known('>') && (!anyFrontier || exploredCells / floorCells >= BOT.descendAt)) {
    goal = (p: Pos) => tile(p) === '>';
    goalStair = '>';
  }
  const stairBlock = (p: Pos) => (tile(p) === 'S' || tile(p) === '>') && tile(p) !== goalStair;

  // 先頭: 味方を避けた経路が最も短い者
  let leader = candidates[0];
  let best: Dir[] | null = null;
  for (const u of candidates) {
    // 味方のマスは通り抜けられる。止まる位置が重なっても解決時に押し戻されるだけ
    const p = findPath(map, u, goal, stairBlock, 5000) ?? findPath(map, u, goal, undefined, 5000);
    if (p && (!best || p.length < best.length)) {
      best = p;
      leader = u;
    }
  }
  const lead = (best ?? []).slice(0, 8);
  plans[leader.id] = lead.map((d) => ({ type: 'move', dir: d, stop: true }));
  // 目標の階段にこのターンで着くなら、階段を使う(プレイヤーが階段を行き先に選ぶのと同じ)
  if (goalStair && best && best.length <= 8) plans[leader.id].push({ type: 'stairs' });

  // 残りは先頭に近い順に並べ、1 人前の者の出発点へ向かってから、その者と同じ経路をなぞる
  const rest = party.filter((u) => u !== leader).sort((a, b) => manhattan(a, leader) - manhattan(b, leader));
  let prev: { start: Pos; dirs: Dir[] } = { start: { x: leader.x, y: leader.y }, dirs: lead };
  for (const u of rest) {
    const toPrev = pathTo(map, u, prev.start, stairBlock) ?? pathTo(map, u, prev.start) ?? [];
    const dirs = [...toPrev, ...prev.dirs].slice(0, 8);
    plans[u.id] = dirs.map((d) => ({ type: 'move', dir: d, stop: true }));
    prev = { start: { x: u.x, y: u.y }, dirs };
  }
  return plans;
}
