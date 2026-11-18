// 操作パネルの HTML 生成。イベントは controller 側で data-* 属性を使って受ける。
import { RULES, apLeft, carryingAfter, planCost } from '../core/actions';
import { AP_PER_TURN, TICKS_PER_TURN, type Action, type GameEvent, type SpellId, type Unit } from '../core/types';
import { T } from '../data/text.ja';
import { SPELLS, unitDef } from '../data/units';
import { iconUrl } from './icons';

export type Mode = 'move' | 'attack' | 'fireball' | 'heal' | 'revive' | 'carry' | 'group';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function partyCards(party: Unit[], plans: Record<string, Action[]>, selected: string | null): string {
  return `<div class="cards">${party
    .map((u) => {
      const d = unitDef(u.defId);
      const used = planCost(plans[u.id] ?? []);
      const pips = Array.from({ length: AP_PER_TURN }, (_, i) => `<i class="${i < used ? 'used' : ''}"></i>`).join('');
      return `<button class="card${u.id === selected ? ' sel' : ''}${u.down ? ' down' : ''}" data-sel="${u.id}">
        <img src="${iconUrl(d.icon)}" alt="">
        <span class="name">${esc(u.name)}${u.down ? `<small>${T.down}${u.carriedTurns ? `·担${u.carriedTurns}` : ''}</small>` : ''}</span>
        <span class="bar hp"><i style="width:${(u.hp / d.maxHp) * 100}%"></i></span>
        ${d.maxMp > 0 ? `<span class="bar mp"><i style="width:${(u.mp / d.maxMp) * 100}%"></i></span>` : '<span class="bar none"></span>'}
        <span class="pips">${pips}</span>
      </button>`;
    })
    .join('')}</div>`;
}

export function actionLabel(a: Action, nameOf: (id: string) => string): string {
  const arrow = { N: '↑', E: '→', S: '↓', W: '←' };
  switch (a.type) {
    case 'move':
      return arrow[a.dir] + (a.stop ? '!' : '') + (a.slow ? '⁺' : '');
    case 'attack':
      return `${T.act.attack}:${nameOf(a.target)}`;
    case 'charge':
      return `${T.act.charge}:${nameOf(a.target)}×${a.ticks}`;
    case 'carry':
      return `${T.act.carry}:${nameOf(a.target)}`;
    case 'drop':
      return T.act.drop;
    case 'guard':
      return T.act.guard;
    case 'wait':
      return T.act.wait;
    case 'spell':
      return SPELLS[a.spell].name + (a.target ? `:${nameOf(a.target)}` : '');
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

/** 職業の特技の枠の数(特技が少ない職業は空けておき、ほかのボタンの位置を揃える) */
const SKILL_SLOTS = 2;
const GAP = '<span class="act-gap"></span>';

/** キャラを選んでいないときの、全部グレーのボタン */
export function idleButtons(): string {
  return [...['move', 'attack', 'guard', 'wait', 'watch'].map((id) => actButton(id, { off: true })), GAP, GAP, actButton('carry', { off: true })].join('');
}

export function actionButtons(u: Unit, actions: Action[], mode: Mode): string {
  const d = unitDef(u.defId);
  const ap = apLeft(actions);
  // 担いでいる間は、移動(2AP/マス)・防御・待機・降ろすだけ
  const busy = carryingAfter(u, actions);
  const spell = (s: SpellId) => !busy && d.spells.includes(s) && ap >= RULES.spellCost && u.mp >= SPELLS[s].mp;
  // ボタンはどのキャラでも同じ位置に並べ、使えないものはグレーアウトする
  // 特技の枠には、その職業の魔法だけを出す
  const skills = d.spells.map((s) => actButton(s, { on: mode === s, off: !spell(s) }));
  while (skills.length < SKILL_SLOTS) skills.push(GAP);
  const list = [
    actButton('move', { on: mode === 'move', off: ap < (busy ? RULES.carryMoveCost : 1) }),
    actButton('attack', { on: mode === 'attack', off: busy || ap < 1 }),
    actButton('guard', { off: ap < 1 }),
    actButton('wait', { off: ap < 1 }),
    actButton('watch', { off: busy || ap < 1 }),
    ...skills,
    // 担ぐと降ろすは同じ枠。担いでいる間は降ろす
    busy ? actButton('drop', { off: ap < 1 }) : actButton('carry', { on: mode === 'carry', off: ap < 1 }),
  ];
  return list.join('');
}

/** 行動ボタンのアイコン */
const ICONS: Record<string, string> = {
  move: '👣',
  attack: '⚔️',
  fireball: '🔥',
  heal: '💚',
  revive: '✨',
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
export function actButton(id: string, opts: { on?: boolean; off?: boolean; cls?: string } = {}): string {
  const label = id in SPELLS ? SPELLS[id as SpellId].name : (T.act as Record<string, string>)[id];
  const mp = id in SPELLS ? `<small>${SPELLS[id as SpellId].mp}</small>` : '';
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

export function eventLog(events: GameEvent[], nameOf: (id: string) => string, limit = 6): string {
  const lines: string[] = [];
  const rests: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'damage': {
        lines.push(T.log.attack(nameOf(e.by), nameOf(e.id), e.amount, e.guarded));
        break;
      }
      case 'heal':
        lines.push(T.log.heal(nameOf(e.id), e.amount));
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
    }
  }
  const restLine = rests.filter(Boolean).join('、');
  if (restLine) lines.push(T.log.rest(restLine));
  return `<ul class="log">${lines
    .slice(-limit)
    .map((l) => `<li>${esc(l)}</li>`)
    .join('')}</ul>`;
}
