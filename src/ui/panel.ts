// 操作パネルの HTML 生成。イベントは controller 側で data-* 属性を使って受ける。
import { RULES, apLeft, carryingAfter, fillerAction, planCost } from '../core/actions';
import { AP_PER_TURN, TICKS_PER_TURN, type Action, type GameEvent, type Unit } from '../core/types';
import { T } from '../data/text.ja';
import { SPELLS, unitDef } from '../data/units';
import { iconUrl } from './icons';

export type Mode = 'move' | 'attack' | 'fireball' | 'heal' | 'revive' | 'follow' | 'escort' | 'carry';

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
    case 'follow':
      return `${T.act.follow}:${nameOf(a.target)}×${a.ticks}`;
    case 'escort':
      return `${T.act.escort}:${nameOf(a.target)}×${a.ticks}`;
  }
}

/** 連続する移動を 1 つのチップにまとめて表示する */
export function planChips(actions: Action[], nameOf: (id: string) => string, inCombat: boolean): string {
  const rest = apLeft(actions);
  const filler = fillerAction(actions, inCombat).type === 'guard' ? T.act.guard : T.act.wait;
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

export function actionButtons(u: Unit, actions: Action[], mode: Mode, stopFlag: boolean): string {
  const d = unitDef(u.defId);
  const ap = apLeft(actions);
  // 担いでいる間は、移動(2AP/マス)・防御・待機・降ろすだけ
  const busy = carryingAfter(u, actions);
  const btn = (id: string, label: string, opts: { on?: boolean; off?: boolean; cls?: string } = {}) =>
    `<button data-act="${id}" class="act${opts.on ? ' on' : ''}${opts.cls ? ' ' + opts.cls : ''}"${opts.off ? ' disabled' : ''}>${label}</button>`;
  const list = [
    btn('move', T.act.move, { on: mode === 'move', off: ap < (busy ? RULES.carryMoveCost : 1) }),
    btn('attack', T.act.attack, { on: mode === 'attack', off: busy || ap < 1 }),
    btn('guard', T.act.guard, { off: ap < 1 }),
    btn('wait', T.act.wait, { off: ap < 1 }),
  ];
  for (const s of d.spells) {
    const sd = SPELLS[s];
    list.push(btn(s, `${sd.name}<small>MP${sd.mp}</small>`, { on: mode === s, off: busy || ap < RULES.spellCost }));
  }
  if (d.range > 1) list.push(btn('overwatch', T.act.overwatch, { off: busy || ap < 1 }));
  list.push(btn('intercept', T.act.intercept, { off: busy || ap < 1 }));
  list.push(btn('follow', T.act.follow, { on: mode === 'follow', off: busy || ap < 1 }));
  list.push(btn('escort', T.act.escort, { on: mode === 'escort', off: busy || ap < 1 }));
  if (busy) list.push(btn('drop', T.act.drop, { off: ap < 1 }));
  else list.push(btn('carry', T.act.carry, { on: mode === 'carry', off: ap < 1 }));
  list.push(btn('stop', T.act.stop, { on: stopFlag, cls: 'toggle' }));
  return `<div class="acts">${list.join('')}</div>`;
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
        lines.push(T.log.rest(nameOf(e.id), e.hp, e.mp));
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
    }
  }
  return `<ul class="log">${lines
    .slice(-limit)
    .map((l) => `<li>${esc(l)}</li>`)
    .join('')}</ul>`;
}
