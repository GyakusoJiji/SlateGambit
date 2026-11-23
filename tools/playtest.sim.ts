// 自動対戦によるバランス検証。`npm run playtest` で実行する。
// 1 戦 = 地下 1 階から潜り、地下 5 階の秘宝を地下 1 階の入口へ持ち帰るまで(または全滅・時間切れ)。
//   GAMES=回数(既定 100)、MAX_TURNS=1 戦の上限ターン(既定 600)
//   TRACE=シード DIFF=normal START=1 … 1 戦の経過をターンごとに表示
//   VARIANTS=all  … 難易度ごとに加えて、途中の階から始める場合
//   VARIANTS=budget BUDGET="normal.3=20,22 hard.5=30"
//                 … ある階の敵の点数の合計を差し替えて比べる(難易度.階=点数,点数,…)
//   VARIANTS=enc     … 固定遭遇をボットで遊ぶ
//   VARIANTS=descend … ボットが下り階段へ向かう探索率を変えて比べる
import { it } from 'vitest';
import { planEnemies } from '../src/core/ai';
import { resolveTurn } from '../src/core/resolve';
import { DIFFICULTY, FLOORS, generateGame } from '../src/core/generate';
import { createTestGame } from '../src/core/scenario';
import { createEncounter, ENCOUNTERS } from '../src/core/encounters';
import type { Difficulty, GameEvent, GameState } from '../src/core/types';
import { visibleFoes } from '../src/core/vision';
import { CLASSES, MONSTERS, unitDef, type UnitDef } from '../src/data/units';
import { stats } from '../src/core/stats';
import { RULES } from '../src/core/actions';
import { BOT, botShop, planParty } from './partyBot';

declare const process: { env: Record<string, string | undefined> };

const GAMES = Number(process.env.GAMES ?? 100);
const TRACE = process.env.TRACE;
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 600);

/** 比較する調整案。setup で数値を書き換え、終了後に元へ戻す。game は 1 戦の初期状態を作る */
type Variant = { name: string; setup: () => void; game: (seed: number) => GameState; teardown?: () => void };
const gen = (d: Difficulty, start = 1) => (seed: number) => generateGame(seed, d, start);
const cap = (d: string) => d[0].toUpperCase() + d.slice(1);
/** BUDGET の指定から、ある階の点数を差し替えた調整案を作る */
function budgetVariants(spec: string): Variant[] {
  const out: Variant[] = [];
  for (const part of spec.trim().split(/\s+/)) {
    const [target, values] = part.split('=');
    const [d, f] = target.split('.') as [Difficulty, string];
    if (f === undefined) {
      // 階を省くと全階の点数をまとめて差し替える(例: normal=15/20/25/30/25,16/21/26/31/26)
      for (const arr of values.split(',').map((v) => v.split('/').map(Number))) {
        let saved: number[] = [];
        out.push({
          name: `${cap(d)} 点数${arr.join('/')}`,
          setup: () => {
            saved = [...DIFFICULTY[d].budget];
            DIFFICULTY[d].budget.splice(0, arr.length, ...arr);
          },
          game: gen(d),
          teardown: () => {
            DIFFICULTY[d].budget.splice(0, saved.length, ...saved);
          },
        });
      }
      continue;
    }
    const i = Number(f) - 1;
    for (const v of values.split(',').map(Number)) {
      let saved = 0;
      out.push({
        name: `${cap(d)} B${f} 点数${v}`,
        setup: () => {
          saved = DIFFICULTY[d].budget[i];
          DIFFICULTY[d].budget[i] = v;
        },
        game: gen(d),
        teardown: () => {
          DIFFICULTY[d].budget[i] = saved;
        },
      });
    }
  }
  return out;
}

const BASE: Variant[] = [
  { name: 'Easy', setup: () => {}, game: gen('easy') },
  { name: 'Normal', setup: () => {}, game: gen('normal') },
  { name: 'Hard', setup: () => {}, game: gen('hard') },
];

/** 新ルールを 1 つずつ足して比べる(DIFF で難易度を選ぶ。既定 normal) */
function featureVariants(d: Difficulty): Variant[] {
  const none = { retarget: false, flankMult: 1, wanderChance: 0 };
  const off = { cover: false, power: false, trip: false, smite: false };
  const on = { cover: true, power: true, trip: true, smite: true };
  const mk = (name: string, rules: Partial<typeof RULES>, use: Partial<typeof BOT.use>): Variant => {
    let savedRules: typeof RULES;
    let savedUse: typeof BOT.use;
    return {
      name: `${cap(d)} ${name}`,
      setup: () => {
        savedRules = { ...RULES };
        savedUse = { ...BOT.use };
        Object.assign(RULES, none, rules);
        Object.assign(BOT.use, off, use);
      },
      game: gen(d),
      teardown: () => {
        Object.assign(RULES, savedRules);
        Object.assign(BOT.use, savedUse);
      },
    };
  };
  const f = { retarget: true };
  const ff = { retarget: true, flankMult: 1.25 };
  return [
    mk('0 追加なし', {}, {}),
    mk('1 狙い移し', f, {}),
    mk('2 +挟み撃ち', ff, {}),
    mk('3 +特技(全部)', ff, on),
    mk('3a  特技:かばう', ff, { cover: true }),
    mk('3b  特技:強攻撃', ff, { power: true }),
    mk('3c  特技:足払い', ff, { trip: true }),
    mk('3d  特技:聖光', ff, { smite: true }),
    mk('5 +休憩の物音', { ...ff, wanderChance: 0.07 }, on),
  ];
}

const VARIANTS: Variant[] = (process.env.VARIANTS === 'feat'
  ? featureVariants((process.env.DIFF ?? 'normal') as Difficulty)
  : process.env.VARIANTS === 'budget'
  ? budgetVariants(process.env.BUDGET ?? '')
  : process.env.VARIANTS === 'descend'
  ? [0.4, 0.7, 1].map((k) => {
      let saved = 0;
      return {
        name: `Normal 探索${Math.round(k * 100)}%で降りる`,
        setup: () => {
          saved = BOT.descendAt;
          BOT.descendAt = k;
        },
        game: gen('normal'),
        teardown: () => {
          BOT.descendAt = saved;
        },
      };
    })
  : process.env.VARIANTS === 'enc'
  ? // 固定遭遇をボットで遊ぶ(編成や新しい仕組みの比べ方の目安。ボットは足払いなどを狙って使わない)
    ENCOUNTERS.map((e) => ({ name: e.title.slice(0, 20), setup: () => {}, game: (seed: number) => createEncounter(e.id, seed)! }))
  : process.env.VARIANTS === 'all'
  ? [
      ...BASE,
      { name: 'Normal B3 から', setup: () => {}, game: gen('normal', 3) },
      { name: 'Normal B5 から', setup: () => {}, game: gen('normal', 5) },
      { name: 'Hard B5 から', setup: () => {}, game: gen('hard', 5) },
      { name: '固定マップ(旧・全滅)', setup: () => {}, game: createTestGame },
    ]
  : BASE) as Variant[];
void strengthen;
void rest;

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
  /** ターンの内訳(戦闘=開始時に敵が見えている / 休憩=休憩イベントあり / 探索=それ以外) */
  phase: Record<string, number>;
  /** 敵が見えているのに誰もダメージ・回復をしなかった戦闘ターン(膠着) */
  stallTurns: number;
  /** 膠着が 5 ターン以上続いた戦闘(1 戦で 1 回まで数える) */
  longStalls: number;
  bumps: Record<string, number>;
  treasureDrops: number;
  /** ドラゴンと戦った(ダメージを与えた)戦の数、倒した戦の数 */
  dragonFought: number;
  dragonKilled: number;
  /** 全滅させたユニットの最後の一撃(負けの原因) */
  lastBlow: Record<string, number>;
  /** 1 戦ごとの最も深い階・ゴールド・終了時の平均レベル */
  deepest: number[];
  gold: number[];
  level: number[];
  /** 秘宝を拾った戦の数 */
  gotTreasure: number;
  /** 全滅した階 */
  lostFloor: Record<string, number>;
  /** 各階に初めて着いたときのターンと平均レベル(階 → 値の配列) */
  arriveTurn: Record<number, number[]>;
  arriveLevel: Record<number, number[]>;
}

const add = (o: Record<string, number>, k: string, n = 1) => (o[k] = (o[k] ?? 0) + n);
const pct = (n: number, d: number) => `${Math.round((n / Math.max(1, d)) * 100)}%`;
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function runBatch(games: number, makeGame: (seed: number) => GameState): Stats {
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
    phase: {},
    stallTurns: 0,
    longStalls: 0,
    bumps: {},
    treasureDrops: 0,
    dragonFought: 0,
    dragonKilled: 0,
    lastBlow: {},
    deepest: [],
    gold: [],
    level: [],
    gotTreasure: 0,
    lostFloor: {},
    arriveTurn: {},
    arriveLevel: {},
  };
  const partyLevel = (st: GameState) => avg(st.units.filter((u) => u.side === 'party').map((u) => u.level ?? 1));
  for (let g = 0; g < games; g++) {
    let state: GameState = makeGame(1000 + g);
    const defOf = new Map(state.units.map((u) => [u.id, u.defId]));
    const sideOf = new Map(state.units.map((u) => [u.id, u.side]));
    let stallRun = 0;
    let longStallCounted = false;
    let dragonHit = false;
    let lastPartyBlow = '';
    let got = false;
    const arrived = new Set<number>([state.floor ?? 1]);
    while (state.status === 'playing' && state.turn <= MAX_TURNS) {
      const hpBefore = new Map(state.units.map((u) => [u.id, u.hp / stats(u).maxHp]));
      const fight = visibleFoes(state.map, state.units, 'party').size > 0;
      botShop(state);
      const r = resolveTurn(state, { ...planEnemies(state), ...planParty(state) });
      const lastHit = new Map<string, string>();
      for (const e of r.events) collect(e, lastHit, hpBefore);
      const active = r.events.some((e) => e.type === 'damage' || e.type === 'heal' || e.type === 'revive');
      add(s.phase, fight ? '戦闘' : r.events.some((e) => e.type === 'rest') ? '休憩' : '探索');
      if (fight && !active) {
        s.stallTurns++;
        if (++stallRun >= 5 && !longStallCounted) {
          s.longStalls++;
          longStallCounted = true;
        }
      } else stallRun = 0;
      for (const e of r.events) {
        if (e.type === 'damage' && /^(dragon|wyrm)$/.test(defOf.get(e.id)!)) dragonHit = true;
        if (e.type === 'damage' && sideOf.get(e.id) === 'party') lastPartyBlow = defOf.get(e.by)!;
        if (e.type === 'treasure' && e.got) got = true;
      }
      state = r.state;
      // 新しい階の敵を表に足す
      for (const u of state.units) {
        defOf.set(u.id, u.defId);
        sideOf.set(u.id, u.side);
      }
      const f = state.floor ?? 1;
      if (!arrived.has(f)) {
        arrived.add(f);
        (s.arriveTurn[f] ??= []).push(state.turn - 1);
        (s.arriveLevel[f] ??= []).push(partyLevel(state));
      }
    }
    if (got) s.gotTreasure++;
    s.deepest.push(state.deepest ?? 1);
    s.gold.push(state.gold ?? 0);
    s.level.push(partyLevel(state));
    if (state.status === 'lost') add(s.lostFloor, `B${state.floor ?? 1}`);
    if (dragonHit) s.dragonFought++;
    if (state.units.some((u) => (u.defId === 'dragon' || u.defId === 'wyrm') && u.down)) s.dragonKilled++;
    if (state.status === 'lost') add(s.lastBlow, lastPartyBlow);
    const res = state.status === 'playing' ? 'timeout' : state.status;
    s.result[res]++;
    if (res === 'timeout') s.timeoutSeeds.push(1000 + g);
    s.turns.push(state.turn - 1);
    if (res === 'won') {
      const p = state.units.filter((u) => u.side === 'party');
      s.hpLeftWin.push(p.reduce((a, u) => a + u.hp, 0) / p.reduce((a, u) => a + stats(u).maxHp, 0));
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
          if (e.reason === '隣にいない' && unitDef(defOf.get(e.id)!).range <= 1) {
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
        case 'bump':
          add(s.bumps, sideOf.get(e.id)!);
          break;
        case 'treasure':
          if (!e.got) s.treasureDrops++;
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
    avg(s.deepest).toFixed(1).padStart(5),
    pct(s.gotTreasure),
    avg(s.level).toFixed(1).padStart(4),
    Math.round(avg(s.gold)).toString().padStart(5),
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
  const ph = Object.entries(s.phase).map(([k, v]) => `${k} ${(v / games).toFixed(1)}`).join(' / ');
  lines.push(`ターンの内訳(1 戦あたり): ${ph}`);
  lines.push(`膠着ターン ${(s.stallTurns / games).toFixed(1)}/戦、5 ターン以上の膠着 ${pct(s.longStalls, games)} の戦`);
  lines.push(`進めなかった移動(1 戦あたり): 味方 ${((s.bumps.party ?? 0) / games).toFixed(1)}、敵 ${((s.bumps.enemy ?? 0) / games).toFixed(1)}`);
  lines.push(`ドラゴン: 戦った ${pct(s.dragonFought, games)}、倒した ${pct(s.dragonKilled, games)}。宝を落とした ${(s.treasureDrops / games).toFixed(2)} 回/戦`);
  const lb = Object.entries(s.lastBlow).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${unitDef(k).name} ${v}`).join('、');
  lines.push(`全滅したときの最後の一撃: ${lb || 'なし'}`);
  const lf = Object.entries(s.lostFloor).sort().map(([k, v]) => `${k} ${v}`).join('、');
  lines.push(`全滅した階: ${lf || 'なし'}。近接の空振り ${pct(s.meleeWhiffs, s.meleeTries)}`);
  const arr: string[] = [];
  for (let f = 2; f <= FLOORS; f++) {
    const t = s.arriveTurn[f];
    if (t) arr.push(`B${f} ${pct(t.length, games)}·T${avg(t).toFixed(0)}·Lv${avg(s.arriveLevel[f]).toFixed(1)}`);
  }
  lines.push(`各階に着いた割合・ターン・平均レベル: ${arr.join(' / ') || 'なし'}`);
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
    `${'調整案'.padEnd(22, '　')} 勝利 全滅 時間  平均T 残HP 気絶/戦 即死/戦 最深階 秘宝 Lv  ゴールド`,
  ];
  const details: string[] = [];
  for (const v of VARIANTS) {
    v.setup();
    const s = runBatch(GAMES, v.game);
    out.push(summaryRow(v.name, s, GAMES));
    details.push(`--- ${v.name} ---\n${detail(s, GAMES)}`);
    restoreDefs(original);
    v.teardown?.();
  }
  console.log([...out, '', ...details].join('\n'));
});

it.runIf(TRACE !== undefined)('1 戦の経過', () => {
  let state = generateGame(Number(TRACE), (process.env.DIFF ?? 'normal') as Difficulty, Number(process.env.START ?? 1));
  console.log(state.map.tiles.join('\n'));
  const out: string[] = [];
  while (state.status === 'playing' && state.turn <= MAX_TURNS) {
    const f = state.floor ?? 1;
    const party = planParty(state);
    const r = resolveTurn(state, { ...planEnemies(state), ...party });
    const pos = state.units.map((u) => `${u.id}${u.down ? 'x' : ''}(${u.x},${u.y})${u.hp}`).join(' ');
    const plans = Object.entries(party)
      .map(([id, a]) => `${id}:${a.map((x) => x.type[0] + ('dir' in x ? x.dir : '')).join('')}`)
      .join(' ');
    const bumps = r.events.filter((e) => e.type === 'bump').map((e) => e.id).join(',');
    out.push(`T${state.turn} B${f} ${pos}\n    ${plans}  bump:${bumps}`);
    state = r.state;
    if ((state.floor ?? 1) !== f) out.push(`--- 地下 ${state.floor} 階へ ---\n${state.map.tiles.join('\n')}`);
  }
  out.push(`結果: ${state.status}(最深 B${state.deepest}、${state.gold ?? 0} G)`);
  console.log(out.join('\n'));
});
