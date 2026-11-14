// 操作パネルの HTML 生成。イベントは controller 側で data-* 属性を使って受ける。
import { RULES, apLeft, planCost } from '../core/actions';
import { AP_PER_TURN, TICKS_PER_TURN, type Action, type GameEvent, type Unit } from '../core/types';
import { T } from '../data/text.ja';
import { SPELLS, unitDef } from '../data/units';
import { iconUrl } from './icons';

export type Mode = 'move' | 'attack' | 'fireball' | 'heal' | 'revive' | 'follow' | 'escort';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function partyCards(party: Unit[], plans: Record<string, Action[]>, selected: string | null): string {
  return `<div class="cards">${party
    .map((u) => {
      const d = unitDef(u.defId);
      const used = planCost(plans[u.id] ?? []);
      const pips = Array.from({ length: AP_PER_TURN }, (_, i) => `<i class="${i < used ? 'used' : ''}"></i>`).join('');
      return `<button class="card${u.id === selected ? ' sel' : ''}${u.down ? ' down' : ''}" data-sel="${u.id}">
        <img src="${iconUrl(d.icon)}" alt="">
        <span class="name">${esc(u.name)}${u.down ? `<small>${T.down}</small>` : ''}</span>
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
      return arrow[a.dir] + (a.stop ? '!' : '');
    case 'attack':
      return `${T.act.attack}:${nameOf(a.target)}`;
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
export function planChips(actions: Action[], nameOf: (id: string) => string): string {
  if (actions.length === 0) return `<span class="chip empty">予約なし(待機)</span>`;
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
  return out.join('');
}

export function actionButtons(u: Unit, actions: Action[], mode: Mode, stopFlag: boolean): string {
  const d = unitDef(u.defId);
  const ap = apLeft(actions);
  const btn = (id: string, label: string, opts: { on?: boolean; off?: boolean; cls?: string } = {}) =>
    `<button data-act="${id}" class="act${opts.on ? ' on' : ''}${opts.cls ? ' ' + opts.cls : ''}"${opts.off ? ' disabled' : ''}>${label}</button>`;
  const list = [
    btn('move', T.act.move, { on: mode === 'move', off: ap < 1 }),
    btn('attack', T.act.attack, { on: mode === 'attack', off: ap < RULES.attackCost }),
    btn('guard', T.act.guard, { off: ap < 1 }),
    btn('wait', T.act.wait, { off: ap < 1 }),
  ];
  for (const s of d.spells) {
    const sd = SPELLS[s];
    list.push(btn(s, `${sd.name}<small>MP${sd.mp}</small>`, { on: mode === s, off: ap < RULES.spellCost }));
  }
  if (d.range > 1) list.push(btn('overwatch', T.act.overwatch, { off: ap < 1 }));
  list.push(btn('intercept', T.act.intercept, { off: ap < 1 }));
  list.push(btn('follow', T.act.follow, { on: mode === 'follow', off: ap < 1 }));
  list.push(btn('escort', T.act.escort, { on: mode === 'escort', off: ap < 1 }));
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
    }
  }
  return `<ul class="log">${lines
    .slice(-limit)
    .map((l) => `<li>${esc(l)}</li>`)
    .join('')}</ul>`;
}
