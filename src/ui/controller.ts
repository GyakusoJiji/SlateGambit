// フェーズ管理(予約 / 再生 / 終了)と、画面・入力・ルールエンジンの橋渡し。
import { planEnemies, summarizeIntent } from '../core/ai';
import { RULES, apLeft, canAppend, carryingAfter, fillPlan } from '../core/actions';
import { manhattan, samePos, step } from '../core/map';
import { pathTo } from '../core/path';
import { inReach, resolveTurn } from '../core/resolve';
import { generateGame } from '../core/generate';
import { quickMovePlans } from '../core/quickmove';
import type { Action, Difficulty, GameState, Plans, Pos, Unit } from '../core/types';
import { sideVisibleMask, visibleFoes } from '../core/vision';
import { T } from '../data/text.ja';
import { SPELLS, unitDef } from '../data/units';
import { attachInput } from './input';
import { actButton, actionButtons, eventLog, partyCards, planChips, playbackControls, type Mode } from './panel';
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
    attachInput(
      el.canvas,
      this.renderer,
      (sx, sy) => this.onTap(sx, sy),
      () => {
        // 自分で盤面を動かしたら、自動のカメラ移動はやめる(再生中なら、その再生の間は追わない)
        this.dirty = true;
        this.camGoal = null;
        if (this.playback) this.userPanned = true;
      },
    );
    new ResizeObserver(() => {
      this.renderer.resize();
      this.dirty = true;
    }).observe(el.canvas);
    el.panel.addEventListener('click', (e) => this.onPanelClick(e));
    el.panel.addEventListener('pointerover', (e) => this.showDesc(e));
    el.panel.addEventListener('pointerout', (e) => this.showDesc(e, true));
    el.topbar.addEventListener('click', (e) => this.onTopbarClick(e));
    el.overlay.addEventListener('click', (e) => this.onOverlayClick(e));
    el.overlay.addEventListener('change', (e) => this.onSettingChange(e));
    window.addEventListener('keydown', (e) => this.onKey(e));
  }

  /** リターンキーは「実行▶」と同じ。再生中・設定画面の表示中は無視する */
  private onKey(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || e.repeat || e.isComposing) return;
    if (this.stopAuto()) return;
    if (this.playback || !this.el.overlay.hidden || this.state.status !== 'playing') return;
    e.preventDefault();
    this.execute();
  }

  // ---- カメラ ----

  /** カメラが滑らかに向かう先(null なら動かさない) */
  private camGoal: Pos | null = null;

  private focusOn(p: Pos): void {
    this.camGoal = { x: p.x, y: p.y };
    this.dirty = true;
  }

  /** 毎フレーム、カメラを目標へ近づける。再生中は動いている味方が画面の内側に収まるよう追う */
  private updateCamera(): void {
    const pb = this.playback;
    if (pb && !this.userPanned) {
      const snaps = pb.units().filter((s) => !s.down && pb.before.units.find((u) => u.id === s.id)?.side === 'party');
      if (snaps.length > 0) {
        const c = { x: snaps.reduce((a, s) => a + s.fx, 0) / snaps.length, y: snaps.reduce((a, s) => a + s.fy, 0) / snaps.length };
        if (!this.renderer.inView(c, 0.25)) this.camGoal = c;
      }
    }
    const g = this.camGoal;
    if (!g) return;
    const r = this.renderer;
    const dx = g.x - r.cx;
    const dy = g.y - r.cy;
    if (Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02) {
      r.centerOn(g);
      this.camGoal = null;
    } else {
      r.centerOn({ x: r.cx + dx * 0.18, y: r.cy + dy * 0.18 });
    }
    this.dirty = true;
  }

  /** 再生中に自分で盤面を動かしたか(動かしたらその再生の間は追わない) */
  private userPanned = false;

  // ---- 自動で進める操作(クイック移動・連続休憩) ----

  /** クイック移動の行き先と先頭のキャラ */
  private quick: { leader: string; target: Pos } | null = null;
  /** 連続休憩の残り回数(0 なら連続休憩していない) */
  private autoRest = 0;
  private autoTimer = 0;

  /** 自動で進めている操作を止める。止めたら true */
  private stopAuto(msg?: string): boolean {
    if (!this.quick && !this.autoRest) return false;
    this.quick = null;
    this.autoRest = 0;
    clearTimeout(this.autoTimer);
    if (msg) this.toast(msg);
    this.changed();
    return true;
  }

  /** 予約フェーズに戻ったとき、クイック移動・連続休憩の続きを行う */
  private continueAuto(): void {
    if (!this.quick && !this.autoRest) return;
    if (this.state.status !== 'playing') return void this.stopAuto();
    if (this.foesInSight()) return void this.stopAuto(T.toast.foundFoe);
    const last = this.lastPlayback?.result.events ?? [];
    if (last.some((e) => e.type === 'damage')) return void this.stopAuto();
    if (this.quick) {
      const plans = quickMovePlans(this.state, this.quick.leader, this.quick.target);
      if (!plans) return void this.stopAuto(T.toast.arrived);
      this.autoTimer = window.setTimeout(() => {
        if (!this.quick || this.playback) return;
        this.plans = { ...this.plans, ...plans };
        this.execute(true);
      }, 120);
      return;
    }
    // 連続休憩: 立っている全員が全快するまで
    const tired = this.party().some((u) => !u.down && (u.hp < unitDef(u.defId).maxHp || u.mp < unitDef(u.defId).maxMp));
    if (!tired) return void this.stopAuto(T.toast.rested);
    this.autoRest--;
    if (this.autoRest <= 0) return void this.stopAuto();
    this.autoTimer = window.setTimeout(() => {
      if (!this.autoRest || this.playback) return;
      for (const id of Object.keys(this.plans)) this.plans[id] = [];
      this.execute(true);
    }, 120);
  }

  /** 難易度選択の画面を出す。選ぶとそのシードで新しいゲームを始める */
  showStart(seed: number): void {
    this.pendingSeed = seed;
    this.el.overlay.hidden = false;
    const btn = (d: Difficulty) => `<button class="act diff" data-ov="diff" data-diff="${d}">
        <b>${T.difficulty[d]}</b><small>${T.difficultyDesc[d]}</small></button>`;
    this.el.overlay.innerHTML = `<div class="sheet start">
      <h2>${T.start.title}</h2>
      ${btn('easy')}${btn('normal')}${btn('hard')}
      <p class="note">${T.start.note}<br>${T.difficultyDesc.boss}</p>
    </div>`;
  }

  private pendingSeed = 0;

  start(seed: number, difficulty: Difficulty = 'normal'): void {
    this.state = generateGame(seed, difficulty);
    this.names = displayNames(this.state.units);
    this.playback = null;
    this.lastPlayback = null;
    this.replaying = false;
    this.selected = null;
    this.lastMode.clear();
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
    this.mode = this.defaultMode(this.selected);
    // 選んでいるキャラが画面の外なら、そこへ盤面を寄せる
    const sel = this.selected ? this.unit(this.selected) : undefined;
    if (sel && !this.renderer.inView(sel, 0.1)) this.focusOn(sel);
    this.refresh();
    if (this.state.status !== 'playing') return this.showResult();
    this.continueAuto();
  }

  private execute(fast = false): void {
    // 止まるマスが重なっていれば知らせる(実行はする。解決時に片方が押し戻される)
    if (!fast && this.overlaps().length > 0) this.toast(T.toast.overlap);
    // 指定されていない残り AP は待機にする(敵が見えないときの待機は休憩になる)
    const filled: Plans = {};
    for (const u of this.party()) if (!u.down) filled[u.id] = fillPlan(this.plans[u.id] ?? []);
    const result = resolveTurn(this.state, { ...this.enemyPlans, ...filled });
    this.playback = new Playback(this.state, result);
    this.userPanned = false;
    // クイック移動・連続休憩の再生は速くする
    if (fast) this.playback.speed = 4;
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
    this.updateCamera();
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
        units.push({ id: s.id, icon: d.icon, side: u.side, x: s.fx, y: s.fy, hp: s.hp, maxHp: d.maxHp, down: s.down, guard: s.guard, watch: s.watch, selected: false, carrying: s.carrying });
      }
      const tr = pb.treasure();
      for (const u of units) u.treasure = !!tr && tr.holder === u.id;
      return { map: pb.before.map, explored: pb.explored[fi], visible, units, marks: [], hints: [], effects: pb.effects(), treasureAt: tr?.at, pointers: this.pointers(pb.explored[fi], tr?.at ?? null) };
    }

    const st = this.state;
    const obj = st.objective;
    const visible = noFog ? null : sideVisibleMask(st.map, st.units, 'party');
    const seen = (u: Unit) => !visible || visible[u.y * st.map.w + u.x];
    const units: DisplayUnit[] = st.units
      .filter((u) => u.side === 'party' || seen(u))
      .map((u) => {
        const d = unitDef(u.defId);
        return { id: u.id, icon: d.icon, side: u.side, x: u.x, y: u.y, hp: u.hp, maxHp: d.maxHp, down: u.down, guard: false, watch: false, selected: u.id === this.selected, carrying: !!u.carrying, treasure: obj?.kind === 'treasure' && obj.holder === u.id };
      });

    const marks: Mark[] = [];
    for (const u of this.party()) {
      marks.push(...planMarks(st, u, this.plans[u.id] ?? [], u.id === this.selected ? '#ffe14a' : '#5ab0ffaa'));
    }
    // 止まるマスが重なっている所は赤い枠で知らせる
    for (const p of this.overlaps()) marks.push({ kind: 'area', at: p, radius: 0, color: 'rgba(255,40,40,0.35)' }, { kind: 'target', at: p, color: '#ff3030' });
    if (this.settings.debugPlans) {
      for (const u of st.units) if (u.side === 'enemy' && !u.down) marks.push(...planMarks(st, u, this.enemyPlans[u.id] ?? [], '#ff5a5a99'));
    }
    const hints = this.settings.hints
      ? st.units
          .filter((u) => u.side === 'enemy' && !u.down && seen(u))
          .map((u) => {
            const plan = this.enemyPlans[u.id] ?? [];
            // ブレスは着弾予定の範囲も見せる(読んでよければ避けられる)
            const b = plan.find((a) => a.type === 'spell' && a.spell === 'breath');
            const area = b && b.type === 'spell' && b.tile ? { at: b.tile, radius: SPELLS.breath.radius } : undefined;
            return { at: { x: u.x, y: u.y }, intent: summarizeIntent(plan, u), area };
          })
      : [];
    const treasureAt = obj?.kind === 'treasure' ? obj.at : null;
    return { map: st.map, explored: st.explored, visible, units, marks, hints, effects: [], treasureAt, pointers: this.pointers(st.explored, treasureAt) };
  }

  /** 画面外の目印: 入口の階段、見つけた宝、(誰も映っていなければ)味方 */
  private pointers(explored: ArrayLike<number>, treasureAt: Pos | null): { at: Pos; color: string; label: string }[] {
    const st = this.state;
    const out: { at: Pos; color: string; label: string }[] = [];
    const si = st.map.tiles.join('').indexOf('S');
    if (si >= 0) out.push({ at: { x: si % st.map.w, y: Math.floor(si / st.map.w) }, color: '#c8b070', label: T.pointer.stairs });
    if (treasureAt && explored[treasureAt.y * st.map.w + treasureAt.x]) out.push({ at: treasureAt, color: '#ffd23a', label: T.pointer.treasure });
    const party = this.party().filter((u) => !u.down);
    if (party.length > 0 && !party.some((u) => this.renderer.inView(u))) out.push({ at: centroid(party), color: '#5ab0ff', label: T.pointer.party });
    return out;
  }

  /** トップバーの「ターン・難易度・目的」 */
  private statusLine(): string {
    const st = this.state;
    const o = st.objective;
    const goal = o?.kind === 'treasure' ? T.objectiveShort[o.holder ? 'treasureHeld' : 'treasure'] : T.objectiveShort.annihilate;
    return `${T.turnShort(st.turn)}·${T.difficulty[st.difficulty ?? 'normal']}·${goal}`;
  }

  private updatePanel(): void {
    const pb = this.playback;
    const key = pb ? `pb:${pb.currentTick()}:${pb.paused}:${pb.speed}:${pb.eventsSoFar().length}` : `plan:${this.panelVersion}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    const nameOf = (id: string) => this.names.get(id) ?? id;

    const turnEl = this.el.topbar.querySelector<HTMLElement>('.turn')!;
    turnEl.textContent = this.statusLine();
    turnEl.title = T.objective[this.state.objective?.kind ?? 'annihilate'];
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
    // 行動ボタンは常に同じ並び(4 列 × 5 行)。選択中のキャラが使えないものはグレーアウト
    const active = sel && !sel.down;
    const status = active
      ? `<b>${nameOf(sel.id)}</b> <span class="ap">AP ${apLeft(acts)}/8</span>${planChips(acts, nameOf, this.foesInSight())}`
      : `<span class="chip empty">${sel ? `${nameOf(sel.id)} は${T.down}している` : T.prompt.selectUnit}</span>`;
    const promptText = active ? prompt : '';
    const ACTION_IDS = ['move', 'attack', 'guard', 'wait', 'fireball', 'heal', 'revive', 'overwatch', 'intercept', 'follow', 'escort', 'stop', 'carry', 'drop'];
    const actions = active ? actionButtons(sel, acts, this.mode, this.stopFlag) : ACTION_IDS.map((id) => actButton(id, { off: true })).join('');
    const hasPlan = active && acts.length > 0;
    this.el.panel.innerHTML = `
      ${partyCards(this.party(), this.plans, this.selected)}
      <div class="plan">${status}</div>
      <p class="prompt" data-prompt="${promptText}">${promptText}</p>
      <div class="acts">
        ${actions}
        ${actButton('undo', { off: !hasPlan })}
        ${actButton('clear', { off: !hasPlan })}
        ${actButton('rest', { off: this.foesInSight() })}
        ${actButton('group', { on: this.mode === 'group', off: !active || this.foesInSight() })}
        ${actButton('execute', { cls: 'primary wide' })}
      </div>
      ${this.lastPlayback ? eventLog(this.lastPlayback.result.events, nameOf, 3) : '<ul class="log"></ul>'}`;
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
    this.stopAuto();
    // 結果の後ろに、パーティのいる場所を映す
    this.focusOn(centroid(this.party()));
    const won = this.state.status === 'won';
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet result ${won ? 'won' : 'lost'}">
      <h2>${won ? (this.state.objective?.kind === 'treasure' ? T.result.wonTreasure : T.result.won) : T.result.lost}</h2>
      <p>${T.difficulty[this.state.difficulty ?? 'normal']} · ${T.turn(this.state.turn - 1)} で決着</p>
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
      // 難易度選択は選ぶまで閉じない
      if (e.target === this.el.overlay && !this.el.overlay.querySelector('.start')) this.el.overlay.hidden = true;
      return;
    }
    if (b.dataset.ov === 'close') this.el.overlay.hidden = true;
    if (b.dataset.ov === 'new') {
      // 設定画面でシードを書き換えた場合だけそのシード、それ以外は毎回新しいマップ
      const input = this.el.overlay.querySelector<HTMLInputElement>('[data-seed]');
      const typed = input && input.value && Number(input.value) !== this.state.seed;
      this.showStart(typed ? Number(input.value) : randomSeed());
    }
    if (b.dataset.ov === 'diff') {
      const diff = b.dataset.diff as Difficulty;
      // 再読み込みで同じゲームから始められるよう、シードと難易度を URL に残す
      const url = new URL(location.href);
      url.searchParams.set('seed', String(this.pendingSeed));
      url.searchParams.set('diff', diff);
      history.replaceState(null, '', url);
      this.start(this.pendingSeed, diff);
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
    // クイック移動・連続休憩の途中で何か押したら止める
    if (!pbBtn && this.stopAuto(T.toast.stopped)) return;
    const selBtn = t.closest<HTMLElement>('[data-sel]');
    if (selBtn && !this.playback) {
      // カードで選んだら、そのキャラの位置に盤面を寄せる
      this.select(selBtn.dataset.sel!, true);
      return;
    }
    const actBtn = t.closest<HTMLElement>('[data-act]');
    // グレーアウトしたボタンは押しても何もしない
    if (actBtn && !this.playback && !actBtn.classList.contains('off')) this.onAction(actBtn.dataset.act!);
  }

  /** 行動ボタンにマウスが乗ったら、操作案内の行をそのボタンの説明に差し替える(離れたら元に戻す) */
  private showDesc(e: PointerEvent, leaving = false): void {
    const line = this.el.panel.querySelector<HTMLElement>('[data-prompt]');
    if (!line) return;
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    if (leaving && b.contains(e.relatedTarget as Node | null)) return;
    const desc = T.desc[b.dataset.act!];
    const label = b.dataset.label ?? '';
    line.textContent = leaving || !desc ? line.dataset.prompt! : `${label}: ${desc}`;
    line.classList.toggle('hover', !leaving && !!desc);
  }

  private foesInSight(): boolean {
    return visibleFoes(this.state.map, this.state.units, 'party').size > 0;
  }

  private onAction(act: string): void {
    if (act === 'execute') return this.execute();
    if (act === 'rest') {
      // 全員の予約を消して休憩する。全快するか敵が見えるまで続ける(最大 20 ターン)
      if (this.foesInSight()) return this.toast(T.err.cannotRest);
      for (const id of Object.keys(this.plans)) this.plans[id] = [];
      this.autoRest = 20;
      return this.execute(true);
    }
    if (act === 'group') {
      if (this.foesInSight()) return this.toast(T.err.cannotGroup);
      this.mode = 'group';
      return this.changed();
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
      case 'drop':
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
      case 'carry':
        this.mode = act;
        this.lastMode.set(u.id, act);
        break;
    }
    this.changed();
  }

  /** キャラごとに最後に選んだ行動モード(選択したときの初期位置にする) */
  private lastMode = new Map<string, Mode>();

  /**
   * そのキャラを選んだときの行動モード。
   * 戦闘中(敵が誰かの視界にいる)なら最後に選んだモード、非戦闘中は移動。使えないモードなら移動
   */
  private defaultMode(id: string | null): Mode {
    const u = id ? this.unit(id) : undefined;
    const m = u ? this.lastMode.get(u.id) : undefined;
    if (!u || !m || !this.foesInSight()) return 'move';
    const carrying = carryingAfter(u, this.plans[u.id] ?? []);
    if (carrying) return 'move';
    const spells: string[] = unitDef(u.defId).spells;
    if ((m === 'fireball' || m === 'heal' || m === 'revive') && !spells.includes(m)) return 'move';
    return m;
  }

  /** focus=true なら、そのキャラの位置に盤面を寄せる(盤面をタップして選んだときは寄せない) */
  private select(id: string, focus = false): void {
    this.selected = id;
    this.mode = this.defaultMode(id);
    const u = this.unit(id);
    if (focus && u) this.focusOn(u);
    this.changed();
  }

  /** 予約どおりに動いたとき、止まるマスが重なる味方のマス */
  private overlaps(): Pos[] {
    const ends = new Map<string, number>();
    const out: Pos[] = [];
    for (const u of this.party()) {
      if (u.down) continue;
      const e = simulate(this.state, u, this.plans[u.id] ?? []).end;
      const k = `${e.x},${e.y}`;
      const n = (ends.get(k) ?? 0) + 1;
      ends.set(k, n);
      if (n === 2) out.push(e);
    }
    return out;
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
    if (this.stopAuto(T.toast.stopped)) return;
    if (this.playback) return;
    const tile = this.renderer.screenToTile(sx, sy);
    const st = this.state;
    if (tile.x < 0 || tile.y < 0 || tile.x >= st.map.w || tile.y >= st.map.h) return;
    const visible = this.settings.noFog ? null : sideVisibleMask(st.map, st.units, 'party');
    const at = st.units.filter((u) => samePos(u, tile) && (u.side === 'party' || !visible || visible[tile.y * st.map.w + tile.x]));
    const ally = at.find((u) => u.side === 'party');
    const foe = at.find((u) => u.side === 'enemy' && !u.down);
    const u = this.selected ? this.unit(this.selected) : undefined;

    // クイック移動: 行き先をタップすると、選んでいるキャラを先頭に全員が自動で向かう
    if (u && this.mode === 'group') {
      if (ally && !ally.down && ally.id !== u.id) return this.select(ally.id);
      if (!st.explored[tile.y * st.map.w + tile.x]) return this.toast(T.err.noPath);
      const plans = quickMovePlans(st, u.id, tile);
      if (!plans) return this.toast(T.err.noPath);
      this.quick = { leader: u.id, target: tile };
      this.mode = 'move';
      this.plans = { ...this.plans, ...plans };
      this.execute(true);
      return;
    }

    // 対象を選ぶモード
    if (u && this.mode !== 'move') {
      const m = this.mode;
      let ok = false;
      if (m === 'attack' && foe) ok = this.attackOrCharge(u, foe);
      else if (m === 'carry' && ally && ally.down && ally.id !== u.id) {
        const end = simulate(st, u, this.plans[u.id]).end;
        if (manhattan(end, ally) > 1) {
          this.toast(T.err.notTarget);
        } else ok = this.append(u, { type: 'carry', target: ally.id });
      }
      else if (m === 'follow' && foe) ok = this.append(u, { type: 'follow', target: foe.id, ticks: apLeft(this.plans[u.id]) });
      else if (m === 'escort' && ally && ally.id !== u.id) ok = this.append(u, { type: 'escort', target: ally.id, ticks: apLeft(this.plans[u.id]) });
      else if (m === 'heal' && ally && !ally.down) ok = this.append(u, { type: 'spell', spell: 'heal', target: ally.id });
      else if (m === 'revive' && ally && ally.down) ok = this.append(u, { type: 'spell', spell: 'revive', target: ally.id });
      else if (m === 'fireball' && st.explored[tile.y * st.map.w + tile.x]) ok = this.append(u, { type: 'spell', spell: 'fireball', tile });
      else this.toast(T.err.notTarget);
      // 予約できたら同じキャラは移動モードに戻す(AP を使い切って次のキャラに移った場合はそのキャラの初期位置のまま)
      if (ok && this.selected === u.id) this.mode = 'move';
      this.changed();
      return;
    }

    // 移動モード: 味方なら選択、敵なら攻撃、床なら経路を予約
    if (ally && !ally.down && ally.id !== this.selected) return this.select(ally.id);
    if (!u || u.down) return;
    if (foe) {
      if (carryingAfter(u, this.plans[u.id])) return this.toast(T.err.carrying);
      this.attackOrCharge(u, foe);
      return;
    }
    if (!st.explored[tile.y * st.map.w + tile.x]) return this.toast(T.err.noPath);
    const from = simulate(st, u, this.plans[u.id]).end;
    const path = pathTo(st.map, from, tile);
    if (!path || path.length === 0) return this.toast(T.err.noPath);
    // 担いでいる間は 1 マス 2 AP
    const slow = carryingAfter(u, this.plans[u.id]);
    const room = Math.floor(apLeft(this.plans[u.id]) / (slow ? RULES.carryMoveCost : 1));
    if (room <= 0) return this.toast(T.err.noAp);
    for (const d of path.slice(0, room)) {
      this.plans[u.id].push({ type: 'move', dir: d, stop: this.stopFlag || undefined, slow: slow || undefined });
    }
    this.changed();
    this.advanceIfFull(u);
  }

  /**
   * 予定位置から届くなら攻撃、届かなければ接近攻撃(残り AP 全部)を予約する。
   * 遠隔で味方が射線上にいる場合も「届かない」とみなし、接近攻撃で射線の空く位置へ動かす
   */
  private attackOrCharge(u: Unit, foe: Unit): boolean {
    const plan = this.plans[u.id];
    const end = simulate(this.state, u, plan).end;
    if (inReach(this.state.map, u, end, foe, this.state.units)) return this.append(u, { type: 'attack', target: foe.id });
    const ok = this.append(u, { type: 'charge', target: foe.id, ticks: apLeft(plan) });
    if (ok) this.toast(T.err.toCharge);
    return ok;
  }

  /** AP を使い切ったら次の味方を選択する */
  private advanceIfFull(u: Unit): void {
    if (apLeft(this.plans[u.id]) > 0) return;
    const next = this.party().find((p) => !p.down && apLeft(this.plans[p.id]) > 0);
    if (next) this.select(next.id, !this.renderer.inView(next, 0.1));
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
    } else if (a.type === 'charge') {
      const t = find(a.target);
      if (t) {
        marks.push({ kind: 'target', at: t, color: '#ff5050' });
        marks.push({ kind: 'path', points: [end, t], color: '#ff5050', dashed: true });
      }
    } else if (a.type === 'carry') {
      const t = find(a.target);
      if (t) marks.push({ kind: 'target', at: t, color: '#60d0ff' });
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
