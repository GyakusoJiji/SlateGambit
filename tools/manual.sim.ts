// 手動プレイ用のハーネス(人間や AI がテキストで 1 ターンずつ遊ぶ)。
// 状態は JSON ファイルに保存し、1 回の実行で 1 ターン(または探索を数ターン)進める。
//
//   PLAY=new  SEED=7   STATE=path/to/state.json  npx vitest run --config vitest.playtest.config.ts tools/manual.sim.ts
//   PLAY=auto STATE=... (敵が見えるまで自動で探索)
//   PLAY=turn STATE=... CMD="p1: to 8,20; atk g1 | p2: ow | p3: fb 9,20 | p4: heal p1"
//   PLAY=show STATE=...
//
// コマンド: to X,Y(経路で移動) / mv ENWS(1 マスずつ移動。戦士は小さい敵を押し返す) /
//   atk ID(届かなければ接近攻撃) / pw ID(強攻撃) / chg ID / g(防御) / w(待機) / cv(かばう) /
//   trip ID(足払い) / fb X,Y / sm X,Y(聖光) / heal ID / rev ID / pot hp|mp ID(回復薬) /
//   ow(警戒射撃・残り全部) / ic(迎撃・残り全部) / carry ID / drop / st(階段を使う)
// 予定位置・届くかの判定は、予約画面と同じ見込み(壁・押し返し・踏ん張り・押された敵の位置)を使う
import * as fs from 'node:fs';
import { it } from 'vitest';
import { RULES, apLeft, canAppend, carryingAfter, fillPlan, planCost } from '../src/core/actions';
import { planEnemies, plannedTarget, summarizeIntent } from '../src/core/ai';
import { pathTo } from '../src/core/path';
import { canShove, inReach, resolveTurn } from '../src/core/resolve';
import { createTestGame } from '../src/core/scenario';
import type { Action, Dir, GameEvent, GameState, Plans, PotionId, Pos, Unit } from '../src/core/types';
import { isNeutral, sideVisibleMask, visibleFoes } from '../src/core/vision';
import { previewPlan, shoveDelay, unitsAtTick } from '../src/ui/timeline';
import { stats } from '../src/core/stats';
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
      // 予約画面と同じ見込みの予定位置(壁や押せない敵には入らない。押し返しと踏ん張りを数える)
      const end = (): Pos => previewPlan(state, u, list).end;
      /** この行動を足したとき、それが発動するティックの全ユニットの位置(押された敵は押された先) */
      const unitsAtHit = (cost: number) => unitsAtTick(state, { ...plans, [u.id]: list }, planCost(list) + shoveDelay(state, u, list) + cost);
      const attackOrCharge = (power: boolean) => {
        const cost = power ? RULES.powerCost : RULES.attackCost;
        const units = unitsAtHit(cost);
        const t = units.find((x) => x.id === arg);
        if (!t) return out.push(`  ! ${u.id} ${c}: ${arg} がいない`);
        if (inReach(state.map, u, end(), t, units)) push({ type: 'attack', target: arg, ...(power ? { power: true } : {}) });
        else if (power) out.push(`  ! ${u.id} ${c}: 強攻撃は予定位置から届く敵にしか使えない`);
        else push({ type: 'charge', target: arg, ticks: apLeft(list) });
      };
      switch (op) {
        case 'to': {
          const slow = carryingAfter(u, list);
          // 押し返せない敵のマスは避けて経路を引く(UI と同じ)
          const blockedByFoe = (q: Pos) =>
            state.units.some((o) => o.side !== u.side && !o.down && !isNeutral(o) && o.x === q.x && o.y === q.y && !canShove(u, o));
          const path = pathTo(state.map, end(), xy(), blockedByFoe) ?? pathTo(state.map, end(), xy()) ?? [];
          const room = Math.floor(apLeft(list) / (slow ? RULES.carryMoveCost : 1));
          for (const d of path.slice(0, room)) list.push({ type: 'move', dir: d, slow: slow || undefined });
          if (path.length > room) out.push(`  ・${u.id} の移動は AP 不足で途中まで`);
          break;
        }
        case 'mv':
          for (const d of (arg ?? '').toUpperCase()) {
            if ('NESW'.includes(d)) push({ type: 'move', dir: d as Dir, stop: true });
            else out.push(`  ! ${u.id} ${c}: 方向は N E S W`);
          }
          break;
        case 'atk':
          attackOrCharge(false);
          break;
        case 'pw':
          attackOrCharge(true);
          break;
        case 'cv':
          push({ type: 'cover' });
          break;
        case 'trip':
          push({ type: 'spell', spell: 'trip', target: arg });
          break;
        case 'sm':
          push({ type: 'spell', spell: 'smite', tile: xy() });
          break;
        case 'pot': {
          const [kind, target] = c.split(/\s+/).slice(1);
          if (kind !== 'hp' && kind !== 'mp') out.push(`  ! ${u.id} ${c}: pot hp|mp ID`);
          else push({ type: 'item', item: kind as PotionId, target: target ?? u.id });
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
        case 'st':
          push({ type: 'stairs' });
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
    else if (e.type === 'push') lines.push(`t${e.tick}:${name(e.id)} が ${name(e.target)} を押し返した(${e.from.x},${e.from.y}→${e.to.x},${e.to.y})`);
    else if (e.type === 'bump') lines.push(`t${e.tick}:${name(e.id)} 進めず`);
    else if (e.type === 'stun') lines.push(`${name(e.id)} 足払いで ${e.ticks} ティック動けない`);
    else if (e.type === 'interrupt') lines.push(`${name(e.id)} の構えが止まった`);
    else if (e.type === 'dry') lines.push(`泉(${e.at.x},${e.at.y})が酸の泉に変わった`);
    else if (e.type === 'acid') lines.push(`${name(e.id)} 酸 ${e.amount}`);
    else if (e.type === 'purify') lines.push(`泉(${e.at.x},${e.at.y})が戻った`);
    else if (e.type === 'ration') lines.push(e.food ? '食料を 1 つ使った' : '食料が無く休憩しても回復しない');
  }
  void state;
  return lines.join(', ') || '(戦闘なし)';
}

const LETTER_MAP: Record<string, string> = { warrior: 'W', thief: 'T', mage: 'M', priest: 'P', goblin: 'g', archer: 'a', orc: 'o', ogre: 'B' };
/** 一覧に無い敵は defId の頭文字(小文字)で出す */
const LETTER = new Proxy(LETTER_MAP, { get: (m, k: string) => m[k] ?? k[0].toLowerCase() });

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
      const d = stats(u);
      return `${u.id} ${LETTER[u.defId]} (${u.x},${u.y}) HP${u.hp}/${d.maxHp}${d.maxMp ? ` MP${u.mp}` : ''}${u.down ? ' 気絶' : ''}${u.carrying ? ` 担:${u.carrying}` : ''}`;
    }),
    ...seenFoes
      .filter((u) => !u.down)
      .map((u) => {
        const plan = enemyPlans[u.id] ?? [];
        // 狙っている味方と発動ティック(画面の「!3」「強5」「追6」と同じ。接近攻撃がこのターンに届かない見込みなら「追」だけ)
        const pt = plannedTarget(plan, { unit: u, map, units });
        const aim = pt ? ` 狙い:${pt.target}(${pt.charge ? `追${pt.tick ?? ''}` : `${pt.power ? '強' : '!'}${pt.tick}`})` : '';
        return `${u.id} ${LETTER[u.defId]} (${u.x},${u.y}) HP${u.hp}/${stats(u).maxHp} 予兆:${summarizeIntent(plan, u)}${aim}`;
      }),
  ];
  const remain = units.filter((u) => u.side === 'enemy' && !u.down).length;
  return `ターン ${state.turn} 状態:${state.status} 残り敵:${remain} 食料:${state.items?.food ?? 0}\n${rows.join('\n')}\n${info.join('\n')}`;
}

export type { Unit };
