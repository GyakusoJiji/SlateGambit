// フェーズ管理(予約 / 再生 / 終了)と、画面・入力・ルールエンジンの橋渡し。
import { planEnemies, summarizeIntent } from '../core/ai';
import { apLeft, canAppend } from '../core/actions';
import { samePos, step } from '../core/map';
import { pathTo } from '../core/path';
import { resolveTurn } from '../core/resolve';
import { createTestGame } from '../core/scenario';
import type { Action, GameState, Plans, Pos, Unit } from '../core/types';
import { sideVisibleMask, visibleFoes } from '../core/vision';
import { T } from '../data/text.ja';
import { SPELLS, unitDef } from '../data/units';
import { attachInput } from './input';
import { actionButtons, eventLog, partyCards, planChips, playbackControls, type Mode } from './panel';
import { Playback } from './playback';
import { Renderer, type DisplayUnit, type Mark, type View } from './renderer';

interface Settings {
  hints: boolean;
  debugPlans: boolean;
  noFog: boolean;
}

const SETTINGS_KEY = 'slate-gambit/settings';

export class Controller {
  private state!: GameState;
  private enemyPlans: Plans = {};
  private plans: Plans = {};
  private selected: string | null = null;
  private mode: Mode = 'move';
  private stopFlag = false;
  private playback: Playback | null = null;
  private lastPlayback: Playback | null = null;
  private names = new Map<string, string>();
  private settings: Settings = loadSettings();
  private renderer: Renderer;
  private dirty = true;
  private panelKey = '';
  private toastTimer = 0;

  constructor(
    private readonly el: {
      canvas: HTMLCanvasElement;
      panel: HTMLElement;
      topbar: HTMLElement;
      overlay: HTMLElement;
      toast: HTMLElement;
    },
  ) {
    this.renderer = new Renderer(el.canvas);
    attachInput(el.canvas, this.renderer, (sx, sy) => this.onTap(sx, sy), () => (this.dirty = true));
    new ResizeObserver(() => {
      this.renderer.resize();
      this.dirty = true;
    }).observe(el.canvas);
    el.panel.addEventListener('click', (e) => this.onPanelClick(e));
    el.topbar.addEventListener('click', (e) => this.onTopbarClick(e));
    el.overlay.addEventListener('click', (e) => this.onOverlayClick(e));
    el.overlay.addEventListener('change', (e) => this.onSettingChange(e));
  }

  start(seed: number): void {
    this.state = createTestGame(seed);
    this.names = displayNames(this.state.units);
    this.playback = null;
    this.lastPlayback = null;
    this.replaying = false;
    this.selected = null;
    this.el.overlay.hidden = true;
    const party = this.party();
    this.renderer.resize();
    this.renderer.centerOn(centroid(party));
    this.beginPlanning();
    if (!this.looping) {
      this.looping = true;
      requestAnimationFrame((t) => this.loop(t, t));
    }
  }

  private looping = false;
  /** 前ターンの再視聴中か(終わっても予約を消さない) */
  private replaying = false;

  // ---- フェーズ ----

  private beginPlanning(): void {
    this.enemyPlans = planEnemies(this.state);
    this.plans = {};
    for (const u of this.party()) this.plans[u.id] = [];
    const first = this.party().find((u) => !u.down);
    if (!this.selected || this.unit(this.selected)?.down) this.selected = first?.id ?? null;
    this.mode = 'move';
    this.refresh();
    if (this.state.status !== 'playing') this.showResult();
  }

  private execute(): void {
    const result = resolveTurn(this.state, { ...this.enemyPlans, ...this.plans });
    this.playback = new Playback(this.state, result);
    this.lastPlayback = this.playback;
    this.state = result.state;
    this.refresh();
  }

  private finishPlayback(): void {
    this.playback = null;
    if (this.replaying) {
      this.replaying = false;
      this.refresh();
      return;
    }
    this.beginPlanning();
  }

  private loop(now: number, prev: number): void {
    const pb = this.playback;
    if (pb) {
      pb.update(now - prev);
      this.dirty = true;
      if (pb.done && !pb.paused) {
        this.finishPlayback();
      }
    }
    if (this.dirty) {
      this.dirty = false;
      this.renderer.draw(this.buildView());
      this.updatePanel();
    }
    requestAnimationFrame((t) => this.loop(t, now));
  }

  private refresh(): void {
    this.dirty = true;
    this.panelKey = '';
  }

  // ---- 表示 ----

  private buildView(): View {
    const pb = this.playback;
    const noFog = this.settings.noFog;
    if (pb) {
      const fi = pb.frameIndex();
      const visible = noFog ? null : pb.visible[fi];
      const snaps = pb.units();
      const units: DisplayUnit[] = [];
      for (const s of snaps) {
        const u = pb.before.units.find((x) => x.id === s.id)!;
        if (u.side === 'enemy' && visible && !visible[s.y * pb.before.map.w + s.x] && !s.down) continue;
        if (u.side === 'enemy' && visible && s.down && !visible[s.y * pb.before.map.w + s.x]) continue;
        const d = unitDef(u.defId);
        units.push({ id: s.id, icon: d.icon, side: u.side, x: s.fx, y: s.fy, hp: s.hp, maxHp: d.maxHp, down: s.down, guard: s.guard, watch: s.watch, selected: false });
      }
      return { map: pb.before.map, explored: pb.explored[fi], visible, units, marks: [], hints: [], effects: pb.effects() };
    }

    const st = this.state;
    const visible = noFog ? null : sideVisibleMask(st.map, st.units, 'party');
    const seen = (u: Unit) => !visible || visible[u.y * st.map.w + u.x];
    const units: DisplayUnit[] = st.units
      .filter((u) => u.side === 'party' || seen(u))
      .map((u) => {
        const d = unitDef(u.defId);
        return { id: u.id, icon: d.icon, side: u.side, x: u.x, y: u.y, hp: u.hp, maxHp: d.maxHp, down: u.down, guard: false, watch: false, selected: u.id === this.selected };
      });

    const marks: Mark[] = [];
    for (const u of this.party()) {
      marks.push(...planMarks(st, u, this.plans[u.id] ?? [], u.id === this.selected ? '#ffe14a' : '#5ab0ffaa'));
    }
    if (this.settings.debugPlans) {
      for (const u of st.units) if (u.side === 'enemy' && !u.down) marks.push(...planMarks(st, u, this.enemyPlans[u.id] ?? [], '#ff5a5a99'));
    }
    const hints = this.settings.hints
      ? st.units.filter((u) => u.side === 'enemy' && !u.down && seen(u)).map((u) => ({ at: { x: u.x, y: u.y }, intent: summarizeIntent(this.enemyPlans[u.id] ?? []) }))
      : [];
    return { map: st.map, explored: st.explored, visible, units, marks, hints, effects: [] };
  }

  private updatePanel(): void {
    const pb = this.playback;
    const key = pb ? `pb:${pb.currentTick()}:${pb.paused}:${pb.speed}:${pb.eventsSoFar().length}` : `plan:${this.panelVersion}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    const nameOf = (id: string) => this.names.get(id) ?? id;

    this.el.topbar.querySelector('.turn')!.textContent = T.turn(this.state.turn);
    const replay = this.el.topbar.querySelector<HTMLButtonElement>('[data-top="replay"]')!;
    replay.disabled = !this.lastPlayback || !!pb;

    if (pb) {
      const before = pb.before.units.filter((u) => u.side === 'party');
      const snaps = pb.units();
      const shown = before.map((u) => {
        const s = snaps.find((x) => x.id === u.id)!;
        return { ...u, hp: s.hp, mp: s.mp, down: s.down };
      });
      this.el.panel.innerHTML = `
        ${partyCards(shown, {}, null)}
        <p class="prompt">${T.prompt.playing}</p>
        ${playbackControls(pb.paused, pb.speed, pb.currentTick())}
        ${eventLog(pb.eventsSoFar(), nameOf)}`;
      return;
    }

    const sel = this.selected ? this.unit(this.selected) : undefined;
    const acts = sel ? this.plans[sel.id] ?? [] : [];
    const prompt = !sel ? T.prompt.selectUnit : T.prompt[this.mode];
    this.el.panel.innerHTML = `
      ${partyCards(this.party(), this.plans, this.selected)}
      ${
        sel && !sel.down
          ? `<div class="plan"><b>${nameOf(sel.id)}</b> <span class="ap">AP ${apLeft(acts)}/8</span>${planChips(acts, nameOf)}</div>
             <p class="prompt">${prompt}</p>
             ${actionButtons(sel, acts, this.mode, this.stopFlag)}`
          : `<p class="prompt">${sel ? `${nameOf(sel.id)} は${T.down}している` : T.prompt.selectUnit}</p>`
      }
      <div class="bottom${this.foesInSight() ? '' : ' four'}">
        <button data-act="undo" class="act">${T.act.undo}</button>
        <button data-act="clear" class="act">${T.act.clear}</button>
        ${this.foesInSight() ? '' : `<button data-act="rest" class="act">${T.act.rest}</button>`}
        <button data-act="execute" class="act primary">${T.act.execute} ▶</button>
      </div>
      ${this.lastPlayback ? eventLog(this.lastPlayback.result.events, nameOf, 4) : ''}`;
  }

  private panelVersion = 0;
  private changed(): void {
    this.panelVersion++;
    this.dirty = true;
  }

  private toast(msg: string): void {
    this.el.toast.textContent = msg;
    this.el.toast.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.el.toast.classList.remove('show'), 1600);
  }

  private showResult(): void {
    const won = this.state.status === 'won';
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet result ${won ? 'won' : 'lost'}">
      <h2>${won ? T.result.won : T.result.lost}</h2>
      <p>${T.turn(this.state.turn - 1)} で決着</p>
      <button class="act primary" data-ov="new">${T.settings.newGame}</button>
      <button class="act" data-ov="close">${T.settings.close}</button>
    </div>`;
  }

  private showSettings(): void {
    const s = this.settings;
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet">
      <h2>${T.settings.title}</h2>
      <label><input type="checkbox" data-set="hints" ${s.hints ? 'checked' : ''}> ${T.settings.hints}</label>
      <label><input type="checkbox" data-set="debugPlans" ${s.debugPlans ? 'checked' : ''}> ${T.settings.debugPlans}</label>
      <label><input type="checkbox" data-set="noFog" ${s.noFog ? 'checked' : ''}> ${T.settings.debugNoFog}</label>
      <label>${T.settings.seed} <input type="number" data-seed value="${this.state.seed}"></label>
      <div class="row">
        <button class="act" data-ov="new">${T.settings.newGame}</button>
        <button class="act primary" data-ov="close">${T.settings.close}</button>
      </div>
    </div>`;
  }

  // ---- 入力 ----

  private onTopbarClick(e: Event): void {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-top]');
    if (!b) return;
    if (b.dataset.top === 'settings') this.showSettings();
    if (b.dataset.top === 'replay' && this.lastPlayback && !this.playback) {
      this.playback = this.lastPlayback;
      this.replaying = true;
      this.playback.restart();
      this.refresh();
    }
  }

  private onOverlayClick(e: Event): void {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ov]');
    if (!b) {
      if (e.target === this.el.overlay) this.el.overlay.hidden = true;
      return;
    }
    if (b.dataset.ov === 'close') this.el.overlay.hidden = true;
    if (b.dataset.ov === 'new') {
      const input = this.el.overlay.querySelector<HTMLInputElement>('[data-seed]');
      const seed = input && input.value ? Number(input.value) : randomSeed();
      const url = new URL(location.href);
      url.searchParams.set('seed', String(seed));
      history.replaceState(null, '', url);
      this.start(seed);
    }
  }

  private onSettingChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const k = input.dataset.set as keyof Settings | undefined;
    if (!k) return;
    this.settings[k] = input.checked;
    saveSettings(this.settings);
    this.refresh();
  }

  private onPanelClick(e: Event): void {
    const t = e.target as HTMLElement;
    const pbBtn = t.closest<HTMLElement>('[data-pb]');
    if (pbBtn && this.playback) {
      const pb = this.playback;
      switch (pbBtn.dataset.pb) {
        case 'toggle':
          if (pb.done) this.finishPlayback();
          else pb.paused = !pb.paused;
          break;
        case 'step':
          pb.stepOnce();
          break;
        case 'speed':
          pb.speed = pb.speed >= 4 ? 1 : pb.speed * 2;
          break;
        case 'skip':
          this.finishPlayback();
          break;
      }
      this.refresh();
      return;
    }
    const selBtn = t.closest<HTMLElement>('[data-sel]');
    if (selBtn && !this.playback) {
      this.select(selBtn.dataset.sel!);
      return;
    }
    const actBtn = t.closest<HTMLElement>('[data-act]');
    if (actBtn && !this.playback) this.onAction(actBtn.dataset.act!);
  }

  private foesInSight(): boolean {
    return visibleFoes(this.state.map, this.state.units, 'party').size > 0;
  }

  private onAction(act: string): void {
    if (act === 'execute') return this.execute();
    if (act === 'rest') {
      // 全員の予約を消して待機させ、そのまま実行する
      if (this.foesInSight()) return this.toast(T.err.cannotRest);
      for (const id of Object.keys(this.plans)) this.plans[id] = [];
      return this.execute();
    }
    const u = this.selected ? this.unit(this.selected) : undefined;
    if (!u) return;
    const list = this.plans[u.id];
    switch (act) {
      case 'undo':
        list.pop();
        break;
      case 'clear':
        list.length = 0;
        break;
      case 'stop':
        this.stopFlag = !this.stopFlag;
        break;
      case 'guard':
      case 'wait':
        this.append(u, { type: act });
        break;
      case 'overwatch':
      case 'intercept':
        this.append(u, { type: act, ticks: apLeft(list) });
        break;
      case 'move':
      case 'attack':
      case 'fireball':
      case 'heal':
      case 'revive':
      case 'follow':
      case 'escort':
        this.mode = act;
        break;
    }
    this.changed();
  }

  private select(id: string): void {
    this.selected = id;
    this.mode = 'move';
    this.changed();
  }

  private append(u: Unit, a: Action): boolean {
    const list = this.plans[u.id];
    const err = canAppend(u, list, a);
    if (err) {
      this.toast(err);
      return false;
    }
    list.push(a);
    this.changed();
    this.advanceIfFull(u);
    return true;
  }

  private onTap(sx: number, sy: number): void {
    if (this.playback) return;
    const tile = this.renderer.screenToTile(sx, sy);
    const st = this.state;
    if (tile.x < 0 || tile.y < 0 || tile.x >= st.map.w || tile.y >= st.map.h) return;
    const visible = this.settings.noFog ? null : sideVisibleMask(st.map, st.units, 'party');
    const at = st.units.filter((u) => samePos(u, tile) && (u.side === 'party' || !visible || visible[tile.y * st.map.w + tile.x]));
    const ally = at.find((u) => u.side === 'party');
    const foe = at.find((u) => u.side === 'enemy' && !u.down);
    const u = this.selected ? this.unit(this.selected) : undefined;

    // 対象を選ぶモード
    if (u && this.mode !== 'move') {
      const m = this.mode;
      let ok = false;
      if (m === 'attack' && foe) ok = this.append(u, { type: 'attack', target: foe.id });
      else if (m === 'follow' && foe) ok = this.append(u, { type: 'follow', target: foe.id, ticks: apLeft(this.plans[u.id]) });
      else if (m === 'escort' && ally && ally.id !== u.id) ok = this.append(u, { type: 'escort', target: ally.id, ticks: apLeft(this.plans[u.id]) });
      else if (m === 'heal' && ally && !ally.down) ok = this.append(u, { type: 'spell', spell: 'heal', target: ally.id });
      else if (m === 'revive' && ally && ally.down) ok = this.append(u, { type: 'spell', spell: 'revive', target: ally.id });
      else if (m === 'fireball' && st.explored[tile.y * st.map.w + tile.x]) ok = this.append(u, { type: 'spell', spell: 'fireball', tile });
      else this.toast(T.err.notTarget);
      if (ok) this.mode = 'move';
      this.changed();
      return;
    }

    // 移動モード: 味方なら選択、敵なら攻撃、床なら経路を予約
    if (ally && !ally.down && ally.id !== this.selected) return this.select(ally.id);
    if (!u || u.down) return;
    if (foe) {
      this.append(u, { type: 'attack', target: foe.id });
      return;
    }
    if (!st.explored[tile.y * st.map.w + tile.x]) return this.toast(T.err.noPath);
    const from = simulate(st, u, this.plans[u.id]).end;
    const path = pathTo(st.map, from, tile);
    if (!path || path.length === 0) return this.toast(T.err.noPath);
    const room = apLeft(this.plans[u.id]);
    if (room <= 0) return this.toast(T.err.noAp);
    for (const d of path.slice(0, room)) this.plans[u.id].push({ type: 'move', dir: d, stop: this.stopFlag || undefined });
    this.changed();
    this.advanceIfFull(u);
  }

  /** AP を使い切ったら次の味方を選択する */
  private advanceIfFull(u: Unit): void {
    if (apLeft(this.plans[u.id]) > 0) return;
    const next = this.party().find((p) => !p.down && apLeft(this.plans[p.id]) > 0);
    if (next) this.select(next.id);
  }

  // ---- 補助 ----

  private party(): Unit[] {
    return this.state.units.filter((u) => u.side === 'party');
  }

  private unit(id: string): Unit | undefined {
    return this.state.units.find((u) => u.id === id);
  }
}

/** 予約から移動部分だけを辿り、予定経路と予定位置を求める(他ユニットとの競合は考慮しない) */
function simulate(st: GameState, u: Unit, actions: Action[]): { path: Pos[]; end: Pos } {
  let p: Pos = { x: u.x, y: u.y };
  const path = [p];
  for (const a of actions) {
    if (a.type !== 'move') continue;
    const n = step(p, a.dir);
    if (st.map.tiles[n.y]?.[n.x] === '#') continue;
    p = n;
    path.push(p);
  }
  return { path, end: p };
}

function planMarks(st: GameState, u: Unit, actions: Action[], color: string): Mark[] {
  const marks: Mark[] = [];
  const { path, end } = simulate(st, u, actions);
  const icon = unitDef(u.defId).icon;
  if (path.length > 1) {
    marks.push({ kind: 'path', points: path, color });
    marks.push({ kind: 'ghost', at: end, icon });
  }
  const find = (id: string) => st.units.find((x) => x.id === id);
  for (const a of actions) {
    if (a.type === 'attack') {
      const t = find(a.target);
      if (t) {
        marks.push({ kind: 'target', at: t, color: '#ff5050' });
        marks.push({ kind: 'link', from: end, to: t, color: '#ff505099' });
      }
    } else if (a.type === 'spell') {
      if (a.tile) {
        marks.push({ kind: 'area', at: a.tile, radius: SPELLS[a.spell].radius, color: 'rgba(255,120,30,0.25)' });
        marks.push({ kind: 'target', at: a.tile, color: '#ff8a30' });
      } else if (a.target) {
        const t = find(a.target);
        if (t) marks.push({ kind: 'target', at: t, color: '#60ff90' });
      }
    } else if (a.type === 'follow' || a.type === 'escort') {
      const t = find(a.target);
      if (t) marks.push({ kind: 'path', points: [end, t], color: a.type === 'follow' ? '#ff9050' : '#60d0ff', dashed: true });
    } else if (a.type === 'overwatch' || a.type === 'intercept') {
      marks.push({ kind: 'area', at: end, radius: a.type === 'intercept' ? 1 : 0, color: 'rgba(255,176,32,0.18)' });
    }
  }
  return marks;
}

function displayNames(units: Unit[]): Map<string, string> {
  const names = new Map<string, string>();
  const count = new Map<string, number>();
  for (const u of units) count.set(u.defId, (count.get(u.defId) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const u of units) {
    if (u.side === 'party' || count.get(u.defId)! === 1) {
      names.set(u.id, u.name);
      continue;
    }
    const n = seen.get(u.defId) ?? 0;
    seen.set(u.defId, n + 1);
    names.set(u.id, u.name + String.fromCharCode(65 + n));
  }
  return names;
}

function centroid(units: Unit[]): Pos {
  const n = units.length || 1;
  return { x: units.reduce((s, u) => s + u.x, 0) / n, y: units.reduce((s, u) => s + u.y, 0) / n };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 1_000_000);
}

function loadSettings(): Settings {
  const def: Settings = { hints: true, debugPlans: false, noFog: false };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...def, ...JSON.parse(raw) } : def;
  } catch {
    return def;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // 保存できない環境では設定は今回限りとする
  }
}
