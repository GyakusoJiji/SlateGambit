// 操作パネルの HTML 生成。イベントは controller 側で data-* 属性を使って受ける。
import { RULES, apLeft, carryingAfter, planCost, spellCost } from '../core/actions';
import { AP_PER_TURN, TICKS_PER_TURN, type Action, type GameEvent, type GameState, type ItemId, type PotionId, type Rumor, type SpellId, type StrikeKind, type Unit } from '../core/types';
import { T } from '../data/text.ja';
import { ITEMS, MONSTERS, SPELLS } from '../data/units';
import { expProgress, spellMp, stats } from '../core/stats';
import { iconUrl } from './icons';
import { tickCells } from './timeline';

export type Mode = 'move' | 'attack' | 'fireball' | 'heal' | 'revive' | 'smite' | 'trip' | 'power' | 'carry' | 'group' | 'potion';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function partyCards(party: Unit[], plans: Record<string, Action[]>, selected: string | null): string {
  return `<div class="cards">${party
    .map((u) => {
      const d = stats(u);
      const used = planCost(plans[u.id] ?? []);
      const pips = Array.from({ length: AP_PER_TURN }, (_, i) => `<i class="${i < used ? 'used' : ''}"></i>`).join('');
      const xp = expProgress(u);
      const xpTitle = xp.toNext > 0 ? `次のレベルまで ${xp.toNext}` : 'レベル上限';
      return `<button class="card${u.id === selected ? ' sel' : ''}${u.down ? ' down' : ''}" data-sel="${u.id}">
        <img src="${iconUrl(d.icon)}" alt="">
        <span class="name"><em class="lv">${T.level(xp.level)}</em>${esc(u.name)}${u.down ? `<small>${T.down}${u.carriedTurns ? `·担${u.carriedTurns}` : ''}</small>` : ''}</span>
        <span class="bar hp"><i style="width:${(u.hp / d.maxHp) * 100}%"></i></span>
        ${d.maxMp > 0 ? `<span class="bar mp"><i style="width:${(u.mp / d.maxMp) * 100}%"></i></span>` : '<span class="bar none"></span>'}
        <span class="bar xp" title="${xpTitle}"><i style="width:${xp.ratio * 100}%"></i></span>
        <span class="pips">${pips}</span>
      </button>`;
    })
    .join('')}</div>`;
}

/**
 * 持ち物の欄: 所持金・回復薬と食料の数・秘宝(持っている味方の名前)。予約中も再生中も盤面のすぐ下に出す
 */
export function inventoryBar(gold: number, items: GameState['items'], relic: string | null, bank = 0, blessing = false): string {
  const potions = (Object.keys(ITEMS) as ItemId[])
    .map((k) => `<span class="item${items?.[k] ? '' : ' none'}" title="${ITEMS[k].name}">${ITEMS[k].icon}${ITEMS[k].short} ×${items?.[k] ?? 0}</span>`)
    .join('');
  const treasure = relic !== null ? `<span class="item relic">💎${T.inv.relic(esc(relic))}</span>` : '';
  const saved = bank > 0 ? `<span class="item">🏦${T.inv.bank(bank)}</span>` : '';
  const holy = blessing ? `<span class="item relic">✝${T.inv.blessing}</span>` : '';
  return `<div class="inv"><span class="item gold">💰${T.gold(gold)}</span>${saved}${potions}${treasure}${holy}</div>`;
}

export function actionLabel(a: Action, nameOf: (id: string) => string): string {
  const arrow = { N: '↑', E: '→', S: '↓', W: '←' };
  switch (a.type) {
    case 'move':
      return arrow[a.dir] + (a.stop ? '!' : '') + (a.slow ? '⁺' : '');
    case 'attack':
      return `${a.power ? SPELLS.power.name : T.act.attack}:${nameOf(a.target)}`;
    case 'cover':
      return SPELLS.cover.name;
    case 'charge':
      return `${T.act.charge}:${nameOf(a.target)}×${a.ticks}`;
    case 'carry':
      return `${T.act.carry}:${nameOf(a.target)}`;
    case 'drop':
      return T.act.drop;
    case 'stairs':
      return T.act.stairs;
    case 'guard':
      return T.act.guard;
    case 'wait':
      return T.act.wait;
    case 'spell':
      return SPELLS[a.spell].name + (a.target ? `:${nameOf(a.target)}` : '');
    case 'item':
      return `${ITEMS[a.item].short}:${nameOf(a.target)}`;
    case 'overwatch':
      return `${T.act.overwatch}×${a.ticks}`;
    case 'intercept':
      return `${T.act.intercept}×${a.ticks}`;
  }
}

/** 連続する移動を 1 つのチップにまとめて表示する */
export function planChips(actions: Action[], nameOf: (id: string) => string, inCombat: boolean): string {
  const rest = apLeft(actions);
  const filler = inCombat ? T.act.guard : T.act.wait;
  const tail = rest > 0 ? `<span class="chip empty">${T.restFill(filler, rest, actions.length === 0)}</span>` : '';
  const out: string[] = [];
  let arrows = '';
  for (const a of actions) {
    if (a.type === 'move') {
      arrows += actionLabel(a, nameOf);
      continue;
    }
    if (arrows) out.push(`<span class="chip mv">${arrows}</span>`);
    arrows = '';
    out.push(`<span class="chip">${esc(actionLabel(a, nameOf))}</span>`);
  }
  if (arrows) out.push(`<span class="chip mv">${arrows}</span>`);
  return out.join('') + tail;
}

/** ボタンの並びの空き */
const GAP = '<span class="act-gap"></span>';

/** キャラを選んでいないときの、全部グレーのボタン */
/**
 * 回復薬のボタン。押すたびに HP 薬と MP 薬を切り替える(選んでいる方を表示し、右下に残り数)。
 * どちらも持っていない・AP が足りない・担いでいるときはグレー
 */
export function potionButton(kind: PotionId, items: GameState['items'], on: boolean, off: boolean): string {
  const it = ITEMS[kind];
  const n = items?.[kind] ?? 0;
  const cls = ['act', on ? 'on' : '', off ? 'off' : ''].filter(Boolean).join(' ');
  return `<button data-act="potion" data-label="${it.short}" class="${cls}"${off ? ' aria-disabled="true"' : ''}><span class="ic">🧪</span>${it.short}<small>${n}</small></button>`;
}

/**
 * 行動ボタンの並び(5 列)。どのキャラでも同じ位置に並べ、その職業に無いもの・使えないものはグレーアウトする。
 * 1 行目: 攻撃・特技・休憩、2 行目: 移動・守り・担ぐ・回復薬、3 行目: 魔法。
 * 4 行目(空き・全員休憩・全員移動・1手戻す・実行)は controller 側で続けて並べる。
 * null は空き。'potion'(回復薬)は controller が作った HTML をそのまま置く
 */
const ACTION_ROWS: (string | null)[][] = [
  ['attack', 'power', 'watch', 'trip', 'wait'],
  ['move', 'guard', 'cover', 'carry', 'potion'],
  ['fireball', 'smite', 'heal', 'revive', null],
];

/** controller が作るボタン(持ち物は controller が知っているため) */
export type ExtraButtons = { potion: string };

/** キャラを選んでいないときの、全部グレーのボタン */
export function idleButtons(extra: ExtraButtons): string {
  return ACTION_ROWS.flat()
    .map((id) => (id === 'potion' ? extra.potion : id ? actButton(id, { off: true }) : GAP))
    .join('');
}

export function actionButtons(u: Unit, actions: Action[], mode: Mode, extra: ExtraButtons): string {
  const d = stats(u);
  const ap = apLeft(actions);
  // 担いでいる間は、移動(2AP/マス)・防御・待機・降ろすだけ
  const busy = carryingAfter(u, actions);
  const need = (s: SpellId) => (s === 'power' ? RULES.powerCost : s === 'cover' ? RULES.coverCost : spellCost(s));
  const spell = (s: SpellId) => !busy && d.spells.includes(s) && ap >= need(s) && u.mp >= spellMp(u, s);
  const button = (id: string): string => {
    switch (id) {
      case 'potion':
        return extra.potion;
      case 'move':
        return actButton('move', { on: mode === 'move', off: ap < (busy ? RULES.carryMoveCost : 1) });
      case 'attack':
        return actButton('attack', { on: mode === 'attack', off: busy || ap < 1 });
      case 'guard':
      case 'wait':
        return actButton(id, { off: ap < 1 });
      case 'watch':
        return actButton('watch', { off: busy || ap < 1 });
      case 'carry':
        // 担ぐと降ろすは同じ枠。担いでいる間は降ろす
        return busy ? actButton('drop', { off: ap < 1 }) : actButton('carry', { on: mode === 'carry', off: ap < 1 });
      default: {
        // 特技・魔法。その職業に無いものは MP の表示も付けずにグレーにする
        const s = id as SpellId;
        if (!d.spells.includes(s)) return actButton(s, { off: true, mp: 0 });
        return actButton(s, { on: mode === s, off: !spell(s), mp: spellMp(u, s) });
      }
    }
  };
  return ACTION_ROWS.flat()
    .map((id) => (id ? button(id) : GAP))
    .join('');
}

/** 行動ボタンのアイコン */
const ICONS: Record<string, string> = {
  move: '👣',
  attack: '⚔️',
  fireball: '🔥',
  heal: '💚',
  revive: '✨',
  smite: '☀️',
  trip: '🦵',
  cover: '🧱',
  power: '💥',
  carry: '🎒',
  drop: '⬇️',
  undo: '↩️',
  rest: '💤',
  group: '🚶',
  guard: '🛡️',
  wait: '⏳',
  watch: '⚡',
  execute: '▶️',
};

/**
 * 行動ボタン 1 つ。使えないボタンは disabled ではなく off クラスでグレーアウトする
 * (disabled だとマウスを乗せても説明が出ないため)。押されても controller 側で無視する
 */
export function actButton(id: string, opts: { on?: boolean; off?: boolean; cls?: string; mp?: number } = {}): string {
  const label = id in SPELLS ? SPELLS[id as SpellId].name : (T.act as Record<string, string>)[id];
  // MP の消費(成長で変わる分は opts.mp で渡す)
  const cost = opts.mp ?? (id in SPELLS ? SPELLS[id as SpellId].mp : 0);
  const mp = cost > 0 ? `<small>${cost}</small>` : '';
  const cls = ['act', opts.on ? 'on' : '', opts.off ? 'off' : '', opts.cls ?? ''].filter(Boolean).join(' ');
  return `<button data-act="${id}" data-label="${label}" class="${cls}"${opts.off ? ' aria-disabled="true"' : ''}><span class="ic">${ICONS[id] ?? ''}</span>${label}${mp}</button>`;
}

export function playbackControls(paused: boolean, speed: number, tick: number): string {
  return `<div class="playbar">
    <span class="tick">${T.play.tick(tick, TICKS_PER_TURN)}</span>
    <button data-pb="toggle" class="act">${paused ? T.play.resume : T.play.pause}</button>
    <button data-pb="step" class="act">${T.play.step}</button>
    <button data-pb="speed" class="act">${T.play.speed(speed)}</button>
    <button data-pb="skip" class="act">${T.play.skip}</button>
  </div>`;
}

/**
 * レベルアップをまとめた 1 行(無ければ空)。同じレベルに上がった者は名前を並べ、
 * partySize 人全員が同じレベルに上がったら「全員」とする
 */
export function levelUpNote(events: GameEvent[], nameOf: (id: string) => string, partySize = 0): string {
  const byLevel = new Map<number, string[]>();
  for (const e of events) if (e.type === 'levelup') byLevel.set(e.level, [...(byLevel.get(e.level) ?? []), e.id]);
  if (byLevel.size === 0) return '';
  if (byLevel.size === 1) {
    const [[lv, ids]] = [...byLevel];
    if (partySize > 1 && ids.length === partySize) return T.log.levelupAll(lv);
  }
  return [...byLevel].map(([lv, ids]) => T.log.levelup(ids.map(nameOf).join('・'), lv)).join(' ');
}

/** 住人の噂の 1 行(本当か嘘かは書かない) */
export function rumorText(who: string, r: Rumor): string {
  const dir = { N: '北', S: '南', E: '東', W: '西' } as const;
  switch (r.kind) {
    case 'stairs':
      return T.rumor.stairs(who, r.floor, dir[r.dir]);
    case 'monster':
      return T.rumor.monster(who, r.floor, MONSTERS[r.monster]?.name ?? r.monster);
    case 'chests':
      return T.rumor.chests(who, r.floor, r.n);
    case 'thief':
      return T.rumor.thief(who, r.claim);
    case 'dragon':
      return T.rumor.dragon(who, r.asleep);
  }
}

/** 範囲魔法の種類 */
const AREA_KINDS = new Set<StrikeKind>(['fireball', 'smite', 'breath', 'hellfire']);

export function eventLog(events: GameEvent[], nameOf: (id: string) => string, limit = 6): string {
  const lines: string[] = [];
  const rests: string[] = [];
  /** レベルアップは全員分を 1 行にまとめる(直前の戦闘の経過を押し出さないため) */
  let levelups = false;
  for (const e of events) {
    switch (e.type) {
      case 'damage': {
        lines.push(T.log.attack(nameOf(e.by), nameOf(e.id), e.amount, e.guarded) + (e.flank ? T.log.flank : ''));
        break;
      }
      case 'cover':
        lines.push(T.log.cover(nameOf(e.id), nameOf(e.for)));
        break;
      case 'stun':
        lines.push(T.log.stun(nameOf(e.id)));
        break;
      case 'interrupt':
        lines.push(T.log.interrupt(nameOf(e.id), e.spell && SPELLS[e.spell].name));
        break;
      case 'wander':
        lines.push(T.log.wander);
        break;
      case 'alarm':
        lines.push(T.log.alarm(nameOf(e.id), e.count));
        break;
      case 'bounty':
        lines.push(T.log.bounty(nameOf(e.id), e.gold));
        break;
      case 'heal':
        lines.push(e.mp ? T.log.healMp(nameOf(e.id), e.amount) : T.log.heal(nameOf(e.id), e.amount));
        break;
      case 'down':
        lines.push(T.log.down(nameOf(e.id)));
        break;
      case 'revive':
        lines.push(T.log.revive(nameOf(e.id)));
        break;
      case 'fizzle':
        lines.push(T.log.fizzle(nameOf(e.id), e.reason));
        break;
      case 'halt':
        lines.push(T.log.halt(nameOf(e.id)));
        break;
      case 'strike':
        if (e.reaction) lines.push(T.log.reaction(nameOf(e.id)));
        if (e.scatter) lines.push(T.log.scatter(nameOf(e.id)));
        // 範囲魔法が誰にも当たらなかったことも残す(敵が動いて空振りした結果を、再生しなくても分かるように)
        if (AREA_KINDS.has(e.kind) && !events.some((d) => d.type === 'damage' && d.by === e.id && d.tick === e.tick)) {
          lines.push(T.log.noHit(nameOf(e.id), SPELLS[e.kind as SpellId].name));
        }
        break;
      case 'rest':
        // 休憩は全員分を 1 行にまとめる(下で追加)
        rests.push(T.log.restPart(nameOf(e.id), e.hp, e.mp));
        break;
      case 'carry':
        lines.push(T.log.carry(nameOf(e.id), nameOf(e.target)));
        break;
      case 'drop':
        lines.push(T.log.drop(nameOf(e.id), nameOf(e.target)));
        break;
      case 'spring':
        lines.push(T.log.spring(nameOf(e.id), e.revived));
        break;
      case 'wake':
        lines.push(T.log.wake(nameOf(e.id)));
        break;
      case 'awaken':
        lines.push(T.log.awaken(nameOf(e.id)));
        break;
      case 'treasure':
        lines.push(e.got ? T.log.treasureGot(nameOf(e.id)) : T.log.treasureDrop(nameOf(e.id)));
        break;
      case 'chest':
        lines.push(T.log.chest(nameOf(e.id), e.gold));
        break;
      case 'loot':
        lines.push(T.log.loot(e.gold));
        break;
      case 'blessing':
        lines.push(T.log.blessing(nameOf(e.id)));
        break;
      case 'unmask':
        lines.push(T.log.unmask(nameOf(e.id)));
        break;
      case 'intrude':
        lines.push(T.log.intrude(e.count));
        break;
      case 'rumor':
        lines.push(rumorText(nameOf(e.id), e.rumor));
        break;
      case 'steal':
        lines.push(T.log.steal(nameOf(e.id), e.gold));
        break;
      case 'recover':
        lines.push(T.log.recover(nameOf(e.id), e.gold));
        break;
      case 'escape':
        lines.push(T.log.escape(nameOf(e.id), e.gold));
        break;
      case 'dry':
        lines.push(T.log.dry);
        break;
      case 'ration':
        if (!e.food) lines.push(T.log.noFood);
        break;
      case 'exp':
        lines.push(T.log.exp(e.amount));
        break;
      case 'levelup':
        if (!levelups) lines.push(levelUpNote(events, nameOf));
        levelups = true;
        break;
      case 'stairs':
        lines.push(T.log.stairs(e.from, e.to));
        break;
    }
  }
  const restLine = rests.filter(Boolean).join('、');
  if (restLine) lines.push(T.log.rest(restLine));
  return `<ul class="log">${lines
    .slice(-limit)
    .map((l) => `<li>${esc(l)}</li>`)
    .join('')}</ul>`;
}

/**
 * ターン後の結果の要約。ターンの初めの味方ごとに 1 行(攻撃・魔法の結果、不発の理由、受けたダメージ)と、
 * 全体の出来事(階の移動・レベルアップ・宝箱など)を 1 行。詳しい経過は eventLog(履歴の画面)で見る
 */
export function turnSummary(events: GameEvent[], before: Unit[], nameOf: (id: string) => string): string[] {
  const sideOf = new Map(before.map((u) => [u.id, u.side]));
  /** 倒れたティック(同じターンに倒れ・起き上がり・また倒れることもある) */
  const downAt = new Map<string, Set<number>>();
  for (const e of events) if (e.type === 'down') downAt.set(e.id, new Set([...(downAt.get(e.id) ?? []), e.tick]));
  const party = before.filter((u) => u.side === 'party');
  const lines: string[] = [];
  for (const u of party) {
    const parts: string[] = [];
    let taken = 0;
    let moved = false;
    let rest = '';
    events.forEach((e, i) => {
      if (!('id' in e) || e.id !== u.id) return;
      if (e.type === 'strike') parts.push(strikeSummary(events, i, u.side, sideOf, downAt, nameOf));
      else if (e.type === 'fizzle') parts.push(T.sum.fizzle(e.reason));
      else if (e.type === 'damage') taken += e.amount;
      else if (e.type === 'cover') parts.push(T.sum.cover(nameOf(e.for)));
      else if (e.type === 'halt') parts.push(T.sum.halt);
      else if (e.type === 'carry') parts.push(T.sum.carry(nameOf(e.target)));
      else if (e.type === 'move') moved = true;
      else if (e.type === 'rest') rest = T.log.restPart('', e.hp, e.mp).trim();
      else if (e.type === 'revive' || e.type === 'wake' || (e.type === 'spring' && e.revived)) parts.push(T.sum.revived);
    });
    if (taken > 0) parts.push(T.sum.taken(taken));
    if (downAt.has(u.id)) parts.push(T.sum.down);
    if (parts.length === 0) parts.push(u.down ? T.down : rest ? T.sum.rest(rest) : moved ? T.sum.moved : T.sum.idle);
    lines.push(`${nameOf(u.id)}: ${parts.join(' / ')}`);
  }
  const notes: string[] = [];
  for (const e of events) {
    if (e.type === 'stairs') notes.push(T.log.stairs(e.from, e.to));
    else if (e.type === 'chest') notes.push(T.log.chest(nameOf(e.id), e.gold));
    else if (e.type === 'treasure') notes.push(e.got ? T.log.treasureGot(nameOf(e.id)) : T.log.treasureDrop(nameOf(e.id)));
    else if (e.type === 'awaken') notes.push(T.log.awaken(nameOf(e.id)));
    else if (e.type === 'wander') notes.push(T.log.wander);
    else if (e.type === 'alarm') notes.push(T.log.alarm(nameOf(e.id), e.count));
    else if (e.type === 'bounty') notes.push(T.log.bounty(nameOf(e.id), e.gold));
  }
  const lv = levelUpNote(events, nameOf, party.length);
  if (lv) notes.push(lv);
  if (notes.length > 0) lines.push(notes.join(' / '));
  return lines;
}

/** events[i](味方の攻撃・魔法)の結果を短く。同じティックの、次の攻撃・魔法までに出たダメージ・回復を集める */
function strikeSummary(
  events: GameEvent[],
  i: number,
  side: Unit['side'],
  sideOf: Map<string, Unit['side']>,
  downAt: Map<string, Set<number>>,
  nameOf: (id: string) => string,
): string {
  const s = events[i];
  if (s.type !== 'strike') return '';
  const after: GameEvent[] = [];
  for (let j = i + 1; j < events.length && events[j].tick === s.tick && events[j].type !== 'strike'; j++) after.push(events[j]);
  const dmg = after.filter((e): e is Extract<GameEvent, { type: 'damage' }> => e.type === 'damage' && e.by === s.id);
  const killed = (id: string) => !!downAt.get(id)?.has(s.tick);
  const label = s.reaction ? (s.kind === 'ranged' ? T.act.overwatch : T.act.intercept) : T.sum.kind[s.kind];
  switch (s.kind) {
    case 'melee':
    case 'ranged':
      if (dmg.length === 0) return T.sum.missed(label);
      return `${label}: ${dmg.map((d) => T.sum.hit(nameOf(d.id), d.amount, killed(d.id))).join('、')}`;
    case 'fireball':
    case 'smite':
    case 'breath':
    case 'hellfire': {
      const foes = dmg.filter((d) => sideOf.get(d.id) !== side);
      const allies = dmg.filter((d) => sideOf.get(d.id) === side);
      const total = foes.reduce((t, d) => t + d.amount, 0);
      const kills = foes.filter((d) => killed(d.id)).length;
      return T.sum.area(label, foes.length, total, kills, allies.length);
    }
    case 'heal':
    case 'potion': {
      const h = after.find((e) => e.type === 'heal');
      return h && h.type === 'heal' ? `${label}: ${nameOf(h.id)} ${h.mp ? 'MP' : ''}+${h.amount}` : label;
    }
    default: {
      // 足払いで構え・詠唱を止めたら、それも添える
      const stop = s.kind === 'trip' ? events.find((e) => e.type === 'interrupt' && e.id === s.target && e.tick === s.tick) : undefined;
      const tail = stop && stop.type === 'interrupt' ? T.sum.interrupted(stop.spell && SPELLS[stop.spell].name) : '';
      return s.target ? `${label}: ${nameOf(s.target)}${tail}` : label;
    }
  }
}

/**
 * 予約の時間軸: 味方ごとに 8 ティックの行動を並べる(見るだけ)。
 * 見出しのティック番号を押すと、盤面にそのティックの終わりの予定位置を出す(もう一度押すと消す)
 */
export function timeline(party: Unit[], plans: Record<string, Action[]>, nameOf: (id: string) => string, filler: 'guard' | 'wait', tick: number | null, selected: string | null): string {
  const head = Array.from({ length: TICKS_PER_TURN }, (_, i) => `<button class="tk${tick === i + 1 ? ' on' : ''}" data-tick="${i + 1}" title="${T.timeline.tickTitle(i + 1)}">${i + 1}</button>`).join('');
  const rows = party
    .map((u) => {
      const cells = u.down
        ? `<span class="cell down" style="grid-column: span ${TICKS_PER_TURN}">${T.down}</span>`
        : tickCells(plans[u.id] ?? [], filler)
            .map((c, i) => `<span class="cell${c.hit ? ' hit' : ''}${c.fill ? ' fill' : ''}${tick === i + 1 ? ' on' : ''}">${esc(c.glyph)}</span>`)
            .join('');
      return `<span class="who${u.id === selected ? ' sel' : ''}" data-sel="${u.id}">${esc(nameOf(u.id))}</span>${cells}`;
    })
    .join('');
  return `<div class="timeline"><span class="who"></span>${head}${rows}</div>`;
}
