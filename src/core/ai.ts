// 敵の計画生成。各敵は自分の視界と記憶だけを使って判断する。
// 判断の揺らぎは (seed, turn, id) から作る決定的な乱数で行うため、同じ状態からは同じ計画になる。
import { SPELLS } from '../data/units';
import { stats } from './stats';
import { RULES, apLeft } from './actions';
import { hasLos } from './los';
import { adjacent, chebyshev, DIR_LIST, dist2, isWalkable, manhattan, samePos, step } from './map';
import { pathAdjacent, pathTo } from './path';
import { clearShot } from './reactions';
import { Rng, hashSeed } from './rng';
import type { Action, Dir, GameState, Plans, Pos, Unit } from './types';
import { unitSees } from './vision';

export type Intent = 'attack' | 'power' | 'watch' | 'move' | 'guard' | 'idle' | 'sleep' | 'breath' | 'cast' | 'alarm';

export function planEnemies(state: GameState): Plans {
  const plans: Plans = {};
  for (const e of state.units) {
    if (e.side !== 'enemy' || e.down) continue;
    plans[e.id] = planOne(state, e);
  }
  return plans;
}

/** 計画の中で単体の相手を狙う最初の攻撃行動(予兆のターゲットライン用) */
export function plannedTarget(actions: Action[]): { target: string; charge: boolean; power: boolean; tick: number } | null {
  let elapsed = 0;
  for (const a of actions) {
    if (a.type === 'attack') {
      const cost = a.power ? RULES.powerCost : RULES.attackCost;
      return { target: a.target, charge: false, power: !!a.power, tick: elapsed + cost };
    }
    if (a.type === 'charge') {
      return { target: a.target, charge: true, power: false, tick: elapsed + RULES.attackCost };
    }
    elapsed += a.type === 'move' ? (a.slow ? RULES.carryMoveCost : 1) : 1;
  }
  return null;
}

/** 予兆表示用に、計画を大まかな意図に要約する */
export function summarizeIntent(actions: Action[], unit?: Unit): Intent {
  if (unit?.ai?.asleep) return 'sleep';
  if (unit?.defId === 'hornblower' && unit.ai?.alarm !== undefined && !unit.ai.alarmRaised) return 'alarm';
  if (actions.some((a) => a.type === 'spell' && a.spell === 'breath')) return 'breath';
  if (actions.some((a) => a.type === 'spell' && a.spell === 'hellfire')) return 'cast';
  if (actions.some((a) => a.type === 'attack' && a.power)) return 'power';
  if (actions.some((a) => a.type === 'attack' || a.type === 'charge' || a.type === 'spell')) return 'attack';
  if (actions.some((a) => a.type === 'overwatch' || a.type === 'intercept')) return 'watch';
  if (actions.some((a) => a.type === 'move')) return 'move';
  if (actions.some((a) => a.type === 'guard')) return 'guard';
  return 'idle';
}

function planOne(state: GameState, e: Unit): Action[] {
  const rng = new Rng(hashSeed(state.seed, state.turn, e.id));
  const { map, units } = state;
  const def = stats(e);
  const targets = units.filter((p) => p.side === 'party' && !p.down && unitSees(map, e, p));
  const plan: Action[] = [];

  // 住人: うろうろ歩く。化けた盗人は、味方が見えれば普通の敵のように近づいて殴る(当たると正体を現して盗む)
  if (e.defId === 'resident' && !(e.ai?.disguise && targets.length > 0)) return wander(state, e, rng);

  // 眠っている間は何もしない
  if (e.ai?.asleep) {
    while (apLeft(plan) > 0) plan.push({ type: 'wait' });
    return plan;
  }

  // 野盗: 盗んだ後は、パーティから逃げて視界の外へ出る(見られずに 2 ターン過ごすと逃げ切る)
  if (e.defId === 'bandit' && e.ai?.stolen) {
    const party = units.filter((p) => p.side === 'party' && !p.down);
    const blockedBy = (p: Pos) => units.some((o) => o !== e && !o.down && o.x === p.x && o.y === p.y);
    let at: Unit = e;
    // 5 マスずつ、AP の続く限り逃げる
    while (party.length > 0 && apLeft(plan) > 0) {
      const path = retreatPath(state, at, party, blockedBy).slice(0, apLeft(plan));
      if (path.length === 0) break;
      let p: Pos = { x: at.x, y: at.y };
      for (const d of path) {
        plan.push({ type: 'move', dir: d });
        p = step(p, d);
      }
      at = { ...at, x: p.x, y: p.y };
    }
    while (apLeft(plan) > 0) plan.push({ type: 'wait' });
    return plan;
  }

  // 警報役: 角笛を吹き終えるまでは、見えている味方から逃げて距離を取り、守りを固める
  if (e.defId === 'hornblower' && !e.ai?.alarmRaised) {
    const blockedBy = (p: Pos) => units.some((o) => o !== e && !o.down && o.x === p.x && o.y === p.y);
    if (targets.length > 0) for (const d of retreatPath(state, e, targets, blockedBy)) plan.push({ type: 'move', dir: d });
    while (apLeft(plan) > 0) plan.push({ type: 'guard' });
    return plan;
  }

  if (targets.length === 0) {
    const goal = e.ai?.alerted && e.ai.lastSeen ? e.ai.lastSeen : patrolGoal(e);
    if (goal) {
      const path = pathTo(map, e, goal);
      if (path) for (const d of path.slice(0, 8)) plan.push({ type: 'move', dir: d });
    }
    while (apLeft(plan) > 0) plan.push({ type: 'wait' });
    return plan;
  }

  // 狙う相手: 近さだけでなく、弱っている相手を優先する(距離 + HP 割合 × 4 が小さい順)
  const score = (p: Unit) => manhattan(e, p) + 4 * (p.hp / stats(p).maxHp);
  targets.sort((a, b) => score(a) - score(b) || a.id.localeCompare(b.id));
  const target = targets[0];
  const hpRatio = e.hp / def.maxHp;

  let pos: Pos = { x: e.x, y: e.y };
  const blocked = (p: Pos) => units.some((o) => o !== e && !o.down && o.x === p.x && o.y === p.y);

  // 弱ったら、半分は下がって距離を取り、残りの一部は守りを固める
  if (hpRatio < 0.35) {
    const r = rng.next();
    if (r < 0.5) {
      const path = retreatPath(state, e, targets, blocked);
      if (path.length > 0) {
        for (const d of path) plan.push({ type: 'move', dir: d });
        while (apLeft(plan) > 0) plan.push({ type: 'guard' });
        return plan;
      }
    }
    if (r < 0.75) {
      while (apLeft(plan) > 0) plan.push({ type: 'guard' });
      return plan;
    }
  }

  // 炎のブレス(ドラゴン): 間隔が空いていれば、味方を最も多く巻き込むマスへ吐き、残りは接近攻撃
  if (def.spells.includes('breath') && state.turn - (e.ai?.breathTurn ?? -99) >= RULES.breathEvery) {
    const tile = areaTile(state, e, targets, 'breath');
    if (tile) {
      plan.push({ type: 'spell', spell: 'breath', tile });
      plan.push({ type: 'charge', target: target.id, ticks: apLeft(plan) });
      return plan;
    }
  }

  // 業火(呪術師長): MP があれば、味方を最も多く巻き込むマスへ長い詠唱を始め、残りは守りを固める
  if (def.spells.includes('hellfire') && e.mp >= SPELLS.hellfire.mp) {
    const tile = areaTile(state, e, targets, 'hellfire');
    if (tile) {
      plan.push({ type: 'spell', spell: 'hellfire', tile });
      while (apLeft(plan) > 0) plan.push({ type: 'guard' });
      return plan;
    }
  }

  // 火球(呪術師): MP があれば、味方を最も多く巻き込むマスへ撃ち、残りは守りを固める
  if (def.spells.includes('fireball') && e.mp >= SPELLS.fireball.mp) {
    const tile = areaTile(state, e, targets, 'fireball');
    if (tile) {
      plan.push({ type: 'spell', spell: 'fireball', tile });
      while (apLeft(plan) > 0) plan.push({ type: 'guard' });
      return plan;
    }
  }

  // 素早い追跡型の敵(大コウモリ・野盗など)は高確率で、一般の敵は低確率で接近攻撃を選ぶ
  const chargeRate = def.chase ? RULES.aiChaseChargeRate : RULES.aiChargeRate;
  if (rng.next() < chargeRate) {
    plan.push({ type: 'charge', target: target.id, ticks: apLeft(plan) });
    return plan;
  }

  if (def.range > 1) {
    // 仲間が射線上にいる位置からは撃たない
    const canShoot = (p: Pos) => dist2(p, target) <= def.range * def.range && hasLos(map, p, target) && clearShot(units, e, p, target);
    if (!canShoot(pos)) {
      const path = pathTo(map, pos, target, blocked) ?? [];
      for (const d of path) {
        if (apLeft(plan) <= RULES.attackCost || canShoot(pos)) break;
        plan.push({ type: 'move', dir: d });
        pos = step(pos, d);
      }
    }
    if (canShoot(pos) && rng.next() < 0.3) {
      // 待ち構えて撃つ(相手が動いても撃てる)
      plan.push({ type: 'overwatch', ticks: apLeft(plan) });
      return plan;
    }
    if (!canShoot(pos)) {
      // 撃てる位置まで来られなければ、残りは相手の動きに合わせて射線の空く位置を探す
      if (apLeft(plan) > 0) plan.push({ type: 'charge', target: target.id, ticks: apLeft(plan) });
      return plan;
    }
    while (apLeft(plan) >= RULES.attackCost) plan.push({ type: 'attack', target: target.id });
    while (apLeft(plan) > 0) plan.push({ type: 'guard' });
    return plan;
  }

  // 近接: 強攻撃を持つ敵(オークなど)が最初から隣にいれば、一定確率で大振りの強攻撃(5AP)を構える
  if (adjacent(map, pos, target) && def.spells.includes('power') && apLeft(plan) >= RULES.powerCost && rng.next() < RULES.aiPowerRate) {
    plan.push({ type: 'attack', target: target.id, power: true });
    while (apLeft(plan) >= RULES.attackCost) plan.push({ type: 'attack', target: target.id });
    while (apLeft(plan) > 0) plan.push({ type: 'guard' });
    return plan;
  }

  const dist = chebyshev(pos, target);
  if (!adjacent(map, pos, target) && dist <= 3 && rng.next() < 0.3) {
    // 近づいてくるのを待って迎え撃つ
    plan.push({ type: 'intercept', ticks: apLeft(plan) });
    return plan;
  }
  const path = pathAdjacent(map, pos, target, blocked) ?? pathAdjacent(map, pos, target) ?? [];
  for (const d of path) {
    if (apLeft(plan) <= 0) break;
    plan.push({ type: 'move', dir: d });
    pos = step(pos, d);
  }
  while (apLeft(plan) >= RULES.attackCost) plan.push({ type: 'attack', target: target.id });
  while (apLeft(plan) > 0) plan.push({ type: 'guard' });
  return plan;
}

/**
 * マス狙いの範囲魔法(炎のブレス・火球)を撃つマス: 見えている味方の今の位置を中心候補にし、
 * 巻き込む味方の数が最も多いマス。自分や仲間の敵を巻き込むマスは選ばない
 */
function areaTile(state: GameState, e: Unit, targets: Unit[], spell: 'breath' | 'fireball' | 'hellfire'): Pos | null {
  const sd = SPELLS[spell];
  const inArea = (c: Pos, p: Pos) => Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)) <= sd.radius;
  let best: Pos | null = null;
  let bestHits = 0;
  for (const t of targets) {
    const c = { x: t.x, y: t.y };
    if (dist2(e, c) > sd.range * sd.range || !hasLos(state.map, e, c)) continue;
    if (state.units.some((o) => o.side === 'enemy' && !o.down && inArea(c, o))) continue;
    const hits = targets.filter((p) => inArea(c, p)).length;
    if (hits > bestHits) {
      best = c;
      bestHits = hits;
    }
  }
  return best;
}

/** 見えている相手からなるべく離れ、できれば視界の外に出る経路(最大 5 マス) */
function retreatPath(state: GameState, e: Unit, foes: Unit[], blocked: (p: Pos) => boolean): Dir[] {
  const { map } = state;
  const key = (p: Pos) => `${p.x},${p.y}`;
  const start = { x: e.x, y: e.y };
  const prev = new Map<string, { from: string; dir: Dir } | null>([[key(start), null]]);
  const queue: { p: Pos; d: number }[] = [{ p: start, d: 0 }];
  const value = (p: Pos) => {
    const near = Math.min(...foes.map((f) => manhattan(p, f)));
    const seen = foes.some((f) => hasLos(map, f, p)) ? 0 : 3;
    return near + seen;
  };
  let best = start;
  let bestValue = value(start);
  for (let i = 0; i < queue.length; i++) {
    const { p, d } = queue[i];
    if (d >= 5) continue;
    for (const dir of DIR_LIST) {
      const n = step(p, dir);
      if (prev.has(key(n)) || !isWalkable(map, n.x, n.y) || blocked(n)) continue;
      prev.set(key(n), { from: key(p), dir });
      queue.push({ p: n, d: d + 1 });
      const v = value(n);
      if (v > bestValue) {
        best = n;
        bestValue = v;
      }
    }
  }
  const dirs: Dir[] = [];
  let k = key(best);
  for (let link = prev.get(k); link; link = prev.get(k)) {
    dirs.unshift(link.dir);
    k = link.from;
  }
  return dirs;
}

/** 住人の散歩: 0〜3 マス、空いている床をでたらめに歩き、残りは待つ */
function wander(state: GameState, e: Unit, rng: Rng): Action[] {
  const plan: Action[] = [];
  const taken = new Set(state.units.filter((u) => u !== e && !u.down).map((u) => `${u.x},${u.y}`));
  let p: Pos = { x: e.x, y: e.y };
  const steps = rng.int(0, 3);
  for (let i = 0; i < steps; i++) {
    const opts = DIR_LIST.filter((d) => {
      const n = step(p, d);
      return state.map.tiles[n.y]?.[n.x] === '.' && !taken.has(`${n.x},${n.y}`);
    });
    if (opts.length === 0) break;
    const d = opts[rng.int(0, opts.length - 1)];
    plan.push({ type: 'move', dir: d });
    p = step(p, d);
  }
  while (apLeft(plan) > 0) plan.push({ type: 'wait' });
  return plan;
}

function patrolGoal(e: Unit): Pos | null {
  const ai = e.ai;
  if (!ai || ai.mode !== 'patrol' || !ai.patrol || ai.patrol.length === 0) return null;
  // patrolIndex は「次に向かう巡回点」。すでに立っていれば次の点へ
  let i = ai.patrolIndex ?? 0;
  if (samePos(e, ai.patrol[i])) i = (i + 1) % ai.patrol.length;
  return ai.patrol[i];
}
