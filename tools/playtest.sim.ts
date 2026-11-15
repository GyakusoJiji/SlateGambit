// 自動対戦によるバランス検証。`npm run playtest` で実行する。
//   GAMES=回数(既定 300)
//   TRACE=シード  … 1 戦の経過をターンごとに表示
import { it } from 'vitest';
import { RULES } from '../src/core/actions';
import { planEnemies } from '../src/core/ai';
import { resolveTurn } from '../src/core/resolve';
import { createTestGame } from '../src/core/scenario';
import type { GameEvent, GameState } from '../src/core/types';
import { CLASSES, MONSTERS, unitDef, type UnitDef } from '../src/data/units';
import { planParty } from './partyBot';

declare const process: { env: Record<string, string | undefined> };

const GAMES = Number(process.env.GAMES ?? 300);
const TRACE = process.env.TRACE;
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 100);

/** 比較する調整案。setup で数値を書き換え、終了後に元へ戻す */
const VARIANTS: { name: string; setup: () => void }[] = [
  { name: '現行', setup: () => {} },
  { name: '敵 攻撃-1', setup: () => strengthen(-1, 1) },
  { name: '敵 攻撃+1', setup: () => strengthen(1, 1) },
  { name: '仲間を呼ばない', setup: () => (RULES.aiCallRange = 0) },
  { name: '敵の接近攻撃なし', setup: () => (RULES.aiChargeRate = 0) },
  { name: '休憩なし', setup: () => rest(0, 0) },
];

function strengthen(atk: number, hp: number): void {
  addAtk(Object.values(MONSTERS), atk);
  scaleHp(Object.values(MONSTERS), hp);
}

function rest(hpRatio: number, mp: number): void {
  RULES.restHpRatio = hpRatio;
  RULES.restMp = mp;
}

function addAtk(defs: UnitDef[], n: number): void {
  for (const d of defs) d.atk += n;
}

function scaleHp(defs: UnitDef[], k: number): void {
  for (const d of defs) d.maxHp = Math.round(d.maxHp * k);
}

function snapshotDefs(): string {
  return JSON.stringify({ CLASSES, MONSTERS, RULES });
}
function restoreDefs(json: string): void {
  const o = JSON.parse(json);
  for (const k of Object.keys(CLASSES)) Object.assign(CLASSES[k], o.CLASSES[k]);
  for (const k of Object.keys(MONSTERS)) Object.assign(MONSTERS[k], o.MONSTERS[k]);
  Object.assign(RULES, o.RULES);
}

interface Stats {
  result: Record<'won' | 'lost' | 'timeout', number>;
  turns: number[];
  dealt: Record<string, number>;
  taken: Record<string, number>;
  friendlyFire: Record<string, number>;
  downs: Record<string, number>;
  kills: Record<string, number>;
  attacks: Record<string, number>;
  reactions: Record<string, number>;
  fizzles: Record<string, number>;
  revives: number;
  heals: number;
  hpLeftWin: number[];
  /** HP 75% 以上から 1 ターンで気絶した回数(味方) */
  oneTurnKos: number;
  /** 近接攻撃の試行と、相手が離れて空振りした回数 */
  meleeTries: number;
  meleeWhiffs: number;
  timeoutSeeds: number[];
}

const add = (o: Record<string, number>, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function runBatch(games: number): Stats {
  const s: Stats = {
    result: { won: 0, lost: 0, timeout: 0 },
    turns: [],
    dealt: {},
    taken: {},
    friendlyFire: {},
    downs: {},
    kills: {},
    attacks: {},
    reactions: {},
    fizzles: {},
    revives: 0,
    heals: 0,
    hpLeftWin: [],
    oneTurnKos: 0,
    meleeTries: 0,
    meleeWhiffs: 0,
    timeoutSeeds: [],
  };
  for (let g = 0; g < games; g++) {
    let state: GameState = createTestGame(1000 + g);
    const defOf = new Map(state.units.map((u) => [u.id, u.defId]));
    const sideOf = new Map(state.units.map((u) => [u.id, u.side]));
    while (state.status === 'playing' && state.turn <= MAX_TURNS) {
      const hpBefore = new Map(state.units.map((u) => [u.id, u.hp / unitDef(u.defId).maxHp]));
      const r = resolveTurn(state, { ...planEnemies(state), ...planParty(state) });
      const lastHit = new Map<string, string>();
      for (const e of r.events) collect(e, lastHit, hpBefore);
      state = r.state;
    }
    const res = state.status === 'playing' ? 'timeout' : state.status;
    s.result[res]++;
    if (res === 'timeout') s.timeoutSeeds.push(1000 + g);
    s.turns.push(state.turn - 1);
    if (res === 'won') {
      const p = state.units.filter((u) => u.side === 'party');
      s.hpLeftWin.push(p.reduce((a, u) => a + u.hp, 0) / p.reduce((a, u) => a + unitDef(u.defId).maxHp, 0));
    }

    function collect(e: GameEvent, lastHit: Map<string, string>, hpBefore: Map<string, number>) {
      switch (e.type) {
        case 'damage': {
          const a = defOf.get(e.by)!;
          add(s.dealt, a, e.amount);
          add(s.taken, defOf.get(e.id)!, e.amount);
          if (sideOf.get(e.by) === sideOf.get(e.id)) add(s.friendlyFire, a, e.amount);
          lastHit.set(e.id, e.by);
          break;
        }
        case 'down': {
          add(s.downs, defOf.get(e.id)!);
          const by = lastHit.get(e.id);
          if (by) add(s.kills, defOf.get(by)!);
          if (sideOf.get(e.id) === 'party' && (hpBefore.get(e.id) ?? 0) >= 0.75) s.oneTurnKos++;
          break;
        }
        case 'fizzle':
          add(s.fizzles, `${defOf.get(e.id)}:${e.reason}`);
          if (e.reason === '届かない' && unitDef(defOf.get(e.id)!).range <= 1) {
            s.meleeWhiffs++;
            s.meleeTries++;
          }
          break;
        case 'strike':
          add(s.attacks, defOf.get(e.id)!);
          if (e.reaction) add(s.reactions, defOf.get(e.id)!);
          if (e.kind === 'melee') s.meleeTries++;
          break;
        case 'revive':
          s.revives++;
          break;
        case 'heal':
          s.heals++;
          break;
      }
    }
  }
  return s;
}

function summaryRow(name: string, s: Stats, games: number): string {
  const pct = (n: number) => `${((n / games) * 100).toFixed(0)}%`.padStart(4);
  const partyDowns = Object.entries(s.downs)
    .filter(([k]) => CLASSES[k])
    .reduce((a, [, v]) => a + v, 0);
  return [
    name.padEnd(22, '　'),
    pct(s.result.won),
    pct(s.result.lost),
    pct(s.result.timeout),
    avg(s.turns).toFixed(1).padStart(5),
    `${(avg(s.hpLeftWin) * 100).toFixed(0)}%`.padStart(5),
    (partyDowns / games).toFixed(2).padStart(5),
    (s.oneTurnKos / games).toFixed(2).padStart(5),
    `${((s.meleeWhiffs / Math.max(1, s.meleeTries)) * 100).toFixed(0)}%`.padStart(5),
  ].join(' ');
}

function detail(s: Stats, games: number): string {
  const lines: string[] = [];
  lines.push('ユニット別(1 戦あたり): 与ダメ / 被ダメ / 気絶 / 撃破 / 攻撃 / 条件付き発動 / 同士討ち');
  const ids = [...Object.keys(CLASSES), ...Object.keys(MONSTERS)].filter((id) => s.dealt[id] || s.taken[id]);
  for (const id of ids) {
    const per = (o: Record<string, number>) => ((o[id] ?? 0) / games).toFixed(1).padStart(6);
    lines.push(`  ${unitDef(id).name.padEnd(5, '　')} ${per(s.dealt)} ${per(s.taken)} ${per(s.downs)} ${per(s.kills)} ${per(s.attacks)} ${per(s.reactions)} ${per(s.friendlyFire)}`);
  }
  lines.push(`時間切れのシード例: ${s.timeoutSeeds.slice(0, 6).join(', ')}`);
  lines.push(`蘇生 ${(s.revives / games).toFixed(2)} 回/戦、回復 ${(s.heals / games).toFixed(2)} 回/戦`);
  lines.push('不発(1 戦あたり、多い順):');
  for (const [k, v] of Object.entries(s.fizzles)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)) {
    const [id, why] = k.split(':');
    lines.push(`  ${unitDef(id).name}: ${why} ${(v / games).toFixed(2)}`);
  }
  return lines.join('\n');
}

it.runIf(TRACE === undefined)(`調整案の比較(各 ${GAMES} 戦)`, () => {
  const original = snapshotDefs();
  const out: string[] = [
    `=== 自動対戦 各 ${GAMES} 戦(上限 ${MAX_TURNS} ターン)===`,
    `${'調整案'.padEnd(22, '　')} 勝利 全滅 時間  平均T 残HP 気絶/戦 即死/戦 近接空振り`,
  ];
  const details: string[] = [];
  for (const v of VARIANTS) {
    v.setup();
    const s = runBatch(GAMES);
    out.push(summaryRow(v.name, s, GAMES));
    details.push(`--- ${v.name} ---\n${detail(s, GAMES)}`);
    restoreDefs(original);
  }
  console.log([...out, '', ...details].join('\n'));
});

it.runIf(TRACE !== undefined)('1 戦の経過', () => {
  let state = createTestGame(Number(TRACE));
  const out: string[] = [];
  while (state.status === 'playing' && state.turn <= MAX_TURNS) {
    const party = planParty(state);
    const r = resolveTurn(state, { ...planEnemies(state), ...party });
    const pos = state.units.map((u) => `${u.id}${u.down ? 'x' : ''}(${u.x},${u.y})${u.hp}`).join(' ');
    const plans = Object.entries(party)
      .map(([id, a]) => `${id}:${a.map((x) => x.type[0] + ('dir' in x ? x.dir : '')).join('')}`)
      .join(' ');
    const bumps = r.events.filter((e) => e.type === 'bump').map((e) => e.id).join(',');
    out.push(`T${state.turn} ${pos}\n    ${plans}  bump:${bumps}`);
    state = r.state;
  }
  out.push(`結果: ${state.status}`);
  console.log(out.join('\n'));
});
