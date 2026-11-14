// 敵の計画生成。各敵は自分の視界と記憶だけを使って判断する。
// 判断の揺らぎは (seed, turn, id) から作る決定的な乱数で行うため、同じ状態からは同じ計画になる。
import { unitDef } from '../data/units';
import { RULES, apLeft } from './actions';
import { hasLos } from './los';
import { dist2, manhattan, samePos, step } from './map';
import { pathAdjacent, pathTo } from './path';
import { Rng, hashSeed } from './rng';
import type { Action, GameState, Plans, Pos, Unit } from './types';
import { unitSees } from './vision';

export type Intent = 'attack' | 'move' | 'guard' | 'idle';

export function planEnemies(state: GameState): Plans {
  const plans: Plans = {};
  for (const e of state.units) {
    if (e.side !== 'enemy' || e.down) continue;
    plans[e.id] = planOne(state, e);
  }
  return plans;
}

/** 予兆表示用に、計画を大まかな意図に要約する */
export function summarizeIntent(actions: Action[]): Intent {
  if (actions.some((a) => a.type === 'attack' || a.type === 'spell' || a.type === 'overwatch' || a.type === 'intercept')) return 'attack';
  if (actions.some((a) => a.type === 'move' || a.type === 'follow')) return 'move';
  if (actions.some((a) => a.type === 'guard')) return 'guard';
  return 'idle';
}

function planOne(state: GameState, e: Unit): Action[] {
  const rng = new Rng(hashSeed(state.seed, state.turn, e.id));
  const { map, units } = state;
  const def = unitDef(e.defId);
  const targets = units.filter((p) => p.side === 'party' && !p.down && unitSees(map, e, p));
  const plan: Action[] = [];

  if (targets.length === 0) {
    const goal = e.ai?.alerted && e.ai.lastSeen ? e.ai.lastSeen : patrolGoal(e);
    if (goal) {
      const path = pathTo(map, e, goal);
      if (path) for (const d of path.slice(0, 8)) plan.push({ type: 'move', dir: d });
    }
    while (apLeft(plan) > 0) plan.push({ type: 'wait' });
    return plan;
  }

  targets.sort((a, b) => dist2(e, a) - dist2(e, b) || a.hp - b.hp);
  const target = targets[0];
  const hpRatio = e.hp / def.maxHp;

  // 弱ったら守りを固める
  if (hpRatio < 0.35 && rng.next() < 0.5) {
    while (apLeft(plan) > 0) plan.push({ type: 'guard' });
    return plan;
  }

  let pos: Pos = { x: e.x, y: e.y };
  const blocked = (p: Pos) => units.some((o) => o !== e && !o.down && o.x === p.x && o.y === p.y);

  if (def.range > 1) {
    const canShoot = (p: Pos) => dist2(p, target) <= def.range * def.range && hasLos(map, p, target);
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
    while (apLeft(plan) >= RULES.attackCost) plan.push({ type: 'attack', target: target.id });
    while (apLeft(plan) > 0) plan.push({ type: 'guard' });
    return plan;
  }

  // 近接
  const dist = manhattan(pos, target);
  if (dist > 1 && dist <= 3 && rng.next() < 0.3) {
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

function patrolGoal(e: Unit): Pos | null {
  const ai = e.ai;
  if (!ai || ai.mode !== 'patrol' || !ai.patrol || ai.patrol.length === 0) return null;
  // patrolIndex は「次に向かう巡回点」。すでに立っていれば次の点へ
  let i = ai.patrolIndex ?? 0;
  if (samePos(e, ai.patrol[i])) i = (i + 1) % ai.patrol.length;
  return ai.patrol[i];
}
