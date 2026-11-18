// 手動プレイ用のハーネス(人間や AI がテキストで 1 ターンずつ遊ぶ)。
// 状態は JSON ファイルに保存し、1 回の実行で 1 ターン(または探索を数ターン)進める。
//
//   PLAY=new  SEED=7   STATE=path/to/state.json  npx vitest run --config vitest.playtest.config.ts tools/manual.sim.ts
//   PLAY=auto STATE=... (敵が見えるまで自動で探索)
//   PLAY=turn STATE=... CMD="p1: to 8,20; atk g1 | p2: ow | p3: fb 9,20 | p4: heal p1"
//   PLAY=show STATE=...
//
// コマンド: to X,Y(経路で移動) / atk ID(届かなければ接近攻撃) / chg ID / g(防御) / w(待機) /
//   fb X,Y / heal ID / rev ID / ow(警戒射撃・残り全部) / ic(迎撃・残り全部) / carry ID / drop
import * as fs from 'node:fs';
import { it } from 'vitest';
import { RULES, apLeft, canAppend, carryingAfter, fillPlan } from '../src/core/actions';
import { planEnemies, summarizeIntent } from '../src/core/ai';
import { step } from '../src/core/map';
import { pathTo } from '../src/core/path';
import { inReach, resolveTurn } from '../src/core/resolve';
import { createTestGame } from '../src/core/scenario';
import type { Action, GameEvent, GameState, Plans, Pos, Unit } from '../src/core/types';
import { sideVisibleMask, visibleFoes } from '../src/core/vision';
import { unitDef } from '../src/data/units';
import { planParty } from './partyBot';

declare const process: { env: Record<string, string | undefined> };
const env = process.env;

it.runIf(env.PLAY !== undefined)('手動プレイ', () => {
  const file = env.STATE!;
  let state: GameState = env.PLAY === 'new' ? createTestGame(Number(env.SEED ?? 1)) : JSON.parse(fs.readFileSync(file, 'utf8'));
  const out: string[] = [];

  if (env.PLAY === 'auto') {
    for (let i = 0; i < Number(env.MAX ?? 10) && state.status === 'playing'; i++) {
      if (visibleFoes(state.map, state.units, 'party').size > 0) break;
      const r = resolveTurn(state, { ...planEnemies(state), ...planParty(state) });
      out.push(`T${state.turn} 自動探索 ${summarize(r.events, state)}`);
      state = r.state;
    }
  } else if (env.PLAY === 'turn') {
    const plans = parseCmd(state, env.CMD ?? '', out);
    const filled: Plans = {};
    // UI と同じく、敵が見えていれば残りの AP は防御、見えなければ休憩(待機)で埋める
    const combat = visibleFoes(state.map, state.units, 'party').size > 0;
    for (const u of state.units) if (u.side === 'party' && !u.down) filled[u.id] = fillPlan(plans[u.id] ?? [], combat ? 'guard' : 'wait');
    const r = resolveTurn(state, { ...planEnemies(state), ...filled });
    out.push(`T${state.turn} ${summarize(r.events, state)}`);
    state = r.state;
  }

  fs.writeFileSync(file, JSON.stringify(state));
  out.push(view(state));
  console.log(out.join('\n'));
});

function parseCmd(state: GameState, cmd: string, out: string[]): Plans {
  const plans: Plans = {};
  for (const part of cmd.split('|')) {
    const [idRaw, rest] = part.split(':');
    if (!rest) continue;
    const u = state.units.find((x) => x.id === idRaw.trim())!;
    const list: Action[] = (plans[u.id] = []);
    for (const c of rest.split(';').map((s) => s.trim()).filter(Boolean)) {
      const [op, arg] = c.split(/\s+/);
      const xy = (): Pos => {
        const [x, y] = arg.split(',').map(Number);
        return { x, y };
      };
      const push = (a: Action) => {
        const err = canAppend(u, list, a);
        if (err) out.push(`  ! ${u.id} ${c}: ${err}`);
        else list.push(a);
      };
      const end = (): Pos => {
        let p: Pos = { x: u.x, y: u.y };
        for (const a of list) if (a.type === 'move') p = step(p, a.dir);
        return p;
      };
      switch (op) {
        case 'to': {
          const slow = carryingAfter(u, list);
          const path = pathTo(state.map, end(), xy()) ?? [];
          const room = Math.floor(apLeft(list) / (slow ? RULES.carryMoveCost : 1));
          for (const d of path.slice(0, room)) list.push({ type: 'move', dir: d, slow: slow || undefined });
          if (path.length > room) out.push(`  ・${u.id} の移動は AP 不足で途中まで`);
          break;
        }
        case 'atk': {
          const t = state.units.find((x) => x.id === arg)!;
          if (inReach(state.map, u, end(), t, state.units)) push({ type: 'attack', target: arg });
          else push({ type: 'charge', target: arg, ticks: apLeft(list) });
          break;
        }
        case 'chg':
          push({ type: 'charge', target: arg, ticks: apLeft(list) });
          break;
        case 'g':
          push({ type: 'guard' });
          break;
        case 'w':
          push({ type: 'wait' });
          break;
        case 'fb':
          push({ type: 'spell', spell: 'fireball', tile: xy() });
          break;
        case 'heal':
          push({ type: 'spell', spell: 'heal', target: arg });
          break;
        case 'rev':
          push({ type: 'spell', spell: 'revive', target: arg });
          break;
        case 'ow':
          push({ type: 'overwatch', ticks: apLeft(list) });
          break;
        case 'ic':
          push({ type: 'intercept', ticks: apLeft(list) });
          break;
        case 'carry':
          push({ type: 'carry', target: arg });
          break;
        case 'drop':
          push({ type: 'drop' });
          break;
        default:
          out.push(`  ! 不明なコマンド ${c}`);
      }
    }
  }
  return plans;
}

function summarize(events: GameEvent[], state: GameState): string {
  const name = (id: string) => id;
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === 'damage') lines.push(`${name(e.by)}→${name(e.id)} ${e.amount}${e.guarded ? '(防)' : ''}`);
    else if (e.type === 'down') lines.push(`${name(e.id)} 気絶`);
    else if (e.type === 'revive') lines.push(`${name(e.id)} 蘇生`);
    else if (e.type === 'heal') lines.push(`${name(e.id)} +${e.amount}`);
    else if (e.type === 'fizzle') lines.push(`${name(e.id)} 不発(${e.reason})`);
    else if (e.type === 'halt') lines.push(`${name(e.id)} 停止`);
    else if (e.type === 'rest') lines.push(`${name(e.id)} 休憩`);
    else if (e.type === 'spring') lines.push(`${name(e.id)} 泉${e.revived ? '復活' : '全快'}`);
    else if (e.type === 'wake') lines.push(`${name(e.id)} 意識を取り戻した`);
    else if (e.type === 'carry' || e.type === 'drop') lines.push(`${name(e.id)} ${e.type}`);
  }
  void state;
  return lines.join(', ') || '(戦闘なし)';
}

const LETTER: Record<string, string> = { warrior: 'W', thief: 'T', mage: 'M', priest: 'P', goblin: 'g', archer: 'a', orc: 'o', ogre: 'B' };

function view(state: GameState): string {
  const { map, units } = state;
  const vis = sideVisibleMask(map, units, 'party');
  const party = units.filter((u) => u.side === 'party');
  const seenFoes = units.filter((u) => u.side === 'enemy' && vis[u.y * map.w + u.x]);
  const xs = [...party, ...seenFoes].map((u) => u.x);
  const ys = [...party, ...seenFoes].map((u) => u.y);
  const x0 = Math.max(0, Math.min(...xs) - 6);
  const x1 = Math.min(map.w - 1, Math.max(...xs) + 6);
  const y0 = Math.max(0, Math.min(...ys) - 4);
  const y1 = Math.min(map.h - 1, Math.max(...ys) + 4);
  const rows: string[] = [`     ${Array.from({ length: x1 - x0 + 1 }, (_, i) => ((x0 + i) % 10).toString()).join('')}`];
  for (let y = y0; y <= y1; y++) {
    let line = `${String(y).padStart(3)}  `;
    for (let x = x0; x <= x1; x++) {
      const i = y * map.w + x;
      const here = units.filter((u) => u.x === x && u.y === y && (u.side === 'party' || vis[i]));
      const live = here.find((u) => !u.down);
      if (live) line += LETTER[live.defId];
      else if (here.length) line += LETTER[here[0].defId].toLowerCase() === LETTER[here[0].defId] ? 'x' : LETTER[here[0].defId].toLowerCase();
      else if (!state.explored[i] && !vis[i]) line += ' ';
      else if (!vis[i]) line += map.tiles[y][x] === '#' ? '#' : ',';
      else line += map.tiles[y][x];
    }
    rows.push(line);
  }
  const enemyPlans = planEnemies(state);
  const info = [
    ...party.map((u) => {
      const d = unitDef(u.defId);
      return `${u.id} ${LETTER[u.defId]} (${u.x},${u.y}) HP${u.hp}/${d.maxHp}${d.maxMp ? ` MP${u.mp}` : ''}${u.down ? ' 気絶' : ''}${u.carrying ? ` 担:${u.carrying}` : ''}`;
    }),
    ...seenFoes
      .filter((u) => !u.down)
      .map((u) => `${u.id} ${LETTER[u.defId]} (${u.x},${u.y}) HP${u.hp}/${unitDef(u.defId).maxHp} 予兆:${summarizeIntent(enemyPlans[u.id] ?? [])}`),
  ];
  const remain = units.filter((u) => u.side === 'enemy' && !u.down).length;
  return `ターン ${state.turn} 状態:${state.status} 残り敵:${remain}\n${rows.join('\n')}\n${info.join('\n')}`;
}

export type { Unit };
