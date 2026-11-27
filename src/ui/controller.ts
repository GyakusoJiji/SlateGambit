// フェーズ管理(予約 / 再生 / 終了)と、画面・入力・ルールエンジンの橋渡し。
import { planEnemies, plannedTarget, summarizeIntent } from '../core/ai';
import { RULES, actionCost, apLeft, canAppend, carryingAfter, fillPlan, planCost } from '../core/actions';
import { hasLos } from '../core/los';
import { adjacent, dirBetween, nearOrSame, samePos } from '../core/map';
import { pathTo } from '../core/path';
import { canShove, chargeRoute, inReach, REACH, reachProblem, resolveTurn } from '../core/resolve';
import { FLOORS, generateGame } from '../core/generate';
import { createEncounter, createFromDef, encounterDef, type Carry } from '../core/encounters';
import { carryOver, MINIGAMES, minigameDef, rankOf, stageScenario, type MinigameDef } from '../core/minigames';
import { currentFloor, findTile, stairsDest, treasureHere } from '../core/floors';
import { quickMovePlans } from '../core/quickmove';
import {
  anyTired,
  bankDay,
  buyItem,
  churchCost,
  clinicCost,
  deposit,
  FACILITY_TILE,
  facilityHere,
  innCost,
  roomFacility,
  TOWN,
  useChurch,
  useClinic,
  useInn,
  useStable,
  withdraw,
  type FacilityId,
} from '../core/town';
import type { Action, Difficulty, GameEvent, GameState, ItemId, Plans, PotionId, Pos, TurnResult, Unit } from '../core/types';
import { isNeutral, sideVisibleMask, visibleFoes } from '../core/vision';
import { T } from '../data/text.ja';
import { ITEMS, PERKS, SPELLS } from '../data/units';
import { pendingPerk, stats } from '../core/stats';
import { attachInput } from './input';
import { actButton, actionButtons, eventLog, idleButtons, inventoryBar, levelUpNote, rumorText, partyCards, planChips, playbackControls, potionButton, timeline, turnSummary, type Mode } from './panel';
import { canStepPreview, cursorTickFor, previewPlan, reachInfo, shoveDelay, tickCells, unitsAtTick } from './timeline';
import { Playback } from './playback';
import { Renderer, type DisplayUnit, type Mark, type View } from './renderer';
import { clearInn, loadGame, loadInn, saveGame, saveInn } from './save';
import { LESSONS, lessonDef, TUTORIAL_ID, TUTORIAL_PAGES } from '../core/tutorial';

interface Settings {
  hints: boolean;
  pointers: boolean;
  debugPlans: boolean;
  noFog: boolean;
  /** 全員移動の隊列(先頭の後ろに並ぶ順。味方の ID)。null なら先頭に近い順 */
  formation: string[] | null;
}

const SETTINGS_KEY = 'slate-gambit/settings';

export class Controller {
  private state!: GameState;
  private enemyPlans: Plans = {};
  private plans: Plans = {};
  private selected: string | null = null;
  private mode: Mode = 'move';
  /** 1手戻すの長押しで予約を全部取り消したとき、続くクリックを無視する */
  private longPressed = false;
  private pressTimer = 0;
  private playback: Playback | null = null;
  private lastPlayback: Playback | null = null;
  /** 回復薬のボタンで選んでいる薬の種類 */
  private potionKind: PotionId = 'hp';
  /** 時間軸で選んでいるティック(盤面にその時点の予定位置を出す)。null なら出さない */
  private timelineTick: number | null = null;
  /** 最近のターンの出来事(履歴の画面用。保存はしない) */
  private history: { turn: number; events: GameEvent[]; before: Unit[] }[] = [];
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
    // 1手戻すを長押しすると、予約を全部取り消す
    el.panel.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act="undo"]');
      if (!b || b.classList.contains('off') || this.playback) return;
      this.pressTimer = window.setTimeout(() => {
        const u = this.selected ? this.unit(this.selected) : undefined;
        if (!u) return;
        this.plans[u.id].length = 0;
        this.longPressed = true;
        this.toast(T.toast.cleared);
        this.changed();
      }, 500);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) el.panel.addEventListener(ev, () => clearTimeout(this.pressTimer));
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

  /** 味方から見えている敵が画面の外にいれば、味方と敵の間へカメラを寄せる(止まった理由の敵を見せる) */
  private frameFoes(): void {
    const seen = visibleFoes(this.state.map, this.state.units, 'party');
    const foes = this.state.units.filter((u) => seen.has(u.id));
    if (foes.length === 0 || foes.every((f) => this.renderer.inView(f, 0.1))) return;
    const a = centroid(this.party());
    const b = centroid(foes);
    this.focusOn({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
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

  // ---- 自動で進める操作(クイック移動) ----

  /** クイック移動の行き先と先頭のキャラ */
  private quick: { leader: string; target: Pos } | null = null;
  private autoTimer = 0;

  /** 自動で進めている操作(クイック移動・全員休憩)を止める。止めたら true */
  private stopAuto(msg?: string): boolean {
    if (!this.quick && !this.rest) return false;
    this.quick = null;
    this.rest = null;
    clearTimeout(this.autoTimer);
    if (msg) this.toast(msg);
    this.changed();
    return true;
  }

  /** 予約フェーズに戻ったとき、クイック移動・全員休憩の続きを行う */
  private continueAuto(): void {
    if (this.rest) {
      if (this.state.status !== 'playing') return void this.stopAuto();
      this.autoTimer = window.setTimeout(() => {
        if (this.rest && !this.playback) this.restStep();
      }, 120);
      return;
    }
    if (!this.quick) return;
    if (this.state.status !== 'playing') return void this.stopAuto();
    if (this.foesInSight()) return void this.stopAuto(T.toast.foundFoe);
    const last = this.lastPlayback?.result.events ?? [];
    if (last.some((e) => e.type === 'damage')) return void this.stopAuto();
    // 噂を聞いたら、通知を読めるよう止まる(次のターンの通知で上書きしない)
    if (last.some((e) => e.type === 'rumor')) return void this.stopAuto();
    const plans = quickMovePlans(this.state, this.quick.leader, this.quick.target, this.settings.formation);
    if (!plans) return void this.stopAuto(this.arrivedMessage());
    this.autoTimer = window.setTimeout(() => {
      if (!this.quick || this.playback) return;
      this.plans = { ...this.plans, ...plans };
      this.execute(true);
    }, 120);
  }

  /** 全員移動で着いたときの通知。地上で先頭が施設の部屋の中にいれば「〇〇に入った」 */
  private arrivedMessage(): string {
    const u = this.state.units.find((x) => x.id === this.quick?.leader && !x.down);
    const f = u && (this.state.floor ?? 1) === 0 && !this.state.scenario ? roomFacility(this.state.map, u) : null;
    return f ? T.toast.enteredFacility(T.facility[f].name) : T.toast.arrived;
  }

  /** 立っている味方に、HP か MP が減っている者がいるか */
  private tired(): boolean {
    return this.party().some((u) => !u.down && (u.hp < stats(u).maxHp || u.mp < stats(u).maxMp));
  }

  /** 全員休憩の途中経過(null なら休憩していない)。left=残りターン数、turns=休んだターン数 */
  private rest: { left: number; turns: number } | null = null;

  /** 全員休憩を始める */
  private restAll(): void {
    this.rest = { left: REST_TURNS, turns: 0 };
    this.restStep();
  }

  /**
   * 全員休憩を進める。敵が見えないターンはまとめて解決して画面に出さず、
   * 敵が見えているターン(物音で来た敵などが近づいてくる)は 1 ターンずつ再生して見せる。休憩は続ける。
   * 攻撃を受ける・敵が隣まで来る・全快する・決着する・REST_TURNS ターンたつと止める
   * (途中の盤面やボタンを押しても止まる。経過は履歴で見られる)
   */
  private restStep(): void {
    const r = this.rest;
    if (!r) return;
    let last: { before: GameState; result: TurnResult } | null = null;
    let why: string | null = null;
    let shown = false;
    while (r.left > 0) {
      const before = this.state;
      const party: Plans = {};
      for (const u of this.party()) if (!u.down) party[u.id] = fillPlan([], 'rest');
      const result = resolveTurn(before, { ...planEnemies(before), ...party });
      this.pushHistory(before, result);
      this.state = result.state;
      last = { before, result };
      r.left--;
      r.turns++;
      why = this.restStopReason(result.events);
      if (why === null && r.left <= 0) why = T.toast.restLimit;
      // 敵が見えていた(見えた)ターンは再生する
      shown = visibleFoes(before.map, before.units, 'party').size > 0 || this.foesInSight() || result.events.some((e) => e.type === 'damage');
      if (shown || why !== null) break;
    }
    if (!last) return void (this.rest = null);
    if (!this.state.scenario) saveGame(this.state);
    const done = why !== null;
    if (done) this.rest = null;
    const note = done && why ? T.toast.restDone(r.turns, why) : '';
    if (shown) {
      // 再生が終わったら finishPlayback → beginPlanning → continueAuto で続きを休む
      this.playback = new Playback(last.before, last.result);
      this.lastPlayback = this.playback;
      this.userPanned = false;
      this.restNote = note;
      this.refresh();
      return;
    }
    const pb = new Playback(last.before, last.result);
    pb.skip();
    this.lastPlayback = pb;
    if (note) this.toast(note);
    this.beginPlanning();
    this.showPerkChoice();
  }

  /** 再生が終わってから出す全員休憩の結果の通知 */
  private restNote = '';

  /** 全員休憩をやめる理由(続けるなら null)。決着したときは空文字(結果の画面を出すので通知しない) */
  private restStopReason(events: GameEvent[]): string | null {
    if (this.state.status !== 'playing') return '';
    if (events.some((e) => e.type === 'damage' && this.unit(e.id)?.side === 'party')) return T.toast.restHurt;
    if (events.some((e) => e.type === 'ration' && !e.food)) return T.toast.restNoFood;
    const st = this.state;
    const near = st.units.some((f) => f.side === 'enemy' && !f.down && !isNeutral(f) && this.party().some((p) => !p.down && adjacent(st.map, p, f)));
    if (near) return T.toast.restFoeNear;
    if (!this.tired()) return T.toast.rested;
    return null;
  }

  private pushHistory(before: GameState, result: TurnResult): void {
    this.history.push({ turn: before.turn, events: result.events, before: before.units });
    if (this.history.length > HISTORY_TURNS) this.history.shift();
  }

  /** メインメニュー(キャンペーン / ミニゲーム)。seed は、キャンペーンをはじめから始めるときのマップのシード */
  showMenu(seed: number = randomSeed()): void {
    this.pendingSeed = seed;
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet start menu">
      <h2>${T.menu.title}</h2>
      <p class="menu-sub">${T.menu.subtitle}</p>
      <button class="act diff" data-ov="tutorial"><b>${T.menu.tutorial}</b><small>${T.menu.tutorialDesc}</small></button>
      <button class="act diff" data-ov="campaign"><b>${T.menu.campaign}</b><small>${T.menu.campaignDesc}</small></button>
      <button class="act diff" data-ov="minigames"><b>${T.menu.minigames}</b><small>${T.menu.minigamesDesc}</small></button>
    </div>`;
  }

  /**
   * キャンペーンの画面: 宿・馬小屋の保存があればそこから、または難易度を選んではじめから。
   * ターンごとの自動保存(最後のターン)は、起動したときの自動の再開だけに使う
   */
  private showCampaign(): void {
    this.el.overlay.hidden = false;
    const saved = loadGame();
    const inn = loadInn();
    const btn = (d: Difficulty) => `<button class="act diff" data-ov="diff" data-diff="${d}">
        <b>${T.difficulty[d]}</b><small>${T.difficultyDesc[d]}</small></button>`;
    this.el.overlay.innerHTML = `<div class="sheet start">
      <h2>${T.menu.campaign}</h2>
      ${inn ? `<button class="act diff primary" data-ov="continue-inn"><b>${T.menu.continueInn}</b><small>${T.menu.continueInnDesc(inn.turn, !!saved && saved.turn !== inn.turn)}</small></button>` : ''}
      <h3>${T.menu.newGame}</h3>
      ${btn('easy')}${btn('normal')}${btn('hard')}
      <button class="act" data-ov="campaign-settings">${T.settings.title}</button>
      <p class="note">${T.start.note}<br>${T.difficultyDesc.boss}</p>
      <button class="act" data-ov="menu">${T.menu.back}</button>
    </div>`;
  }

  /** ミニゲームの画面: 短い連戦の一覧 */
  private showMinigames(): void {
    const mg = (m: MinigameDef) =>
      `<button class="act diff" data-ov="mg-start" data-id="${m.id}"><b>${m.title}</b><small>${T.menu.stages(m.stages.length, m.minutes)}</small><small>${m.desc}</small></button>`;
    this.el.overlay.innerHTML = `<div class="sheet start">
      <h2>${T.menu.minigames}</h2>
      ${MINIGAMES.map(mg).join('')}
      <button class="act" data-ov="menu">${T.menu.back}</button>
    </div>`;
  }

  /** チュートリアルの操作ガイド(ページ送り)。最後のページから練習戦を始められる */
  private showTutorialGuide(page = 0): void {
    const n = TUTORIAL_PAGES.length;
    const i = Math.max(0, Math.min(n - 1, page));
    const p = TUTORIAL_PAGES[i];
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet start guide">
      <p class="pager">${T.tutorial.pager(i + 1, n)}</p>
      <h2>${p.title}</h2>
      <ul>${p.lines.map((l) => `<li>${l}</li>`).join('')}</ul>
      ${i + 1 < n ? `<button class="act primary" data-ov="tut-go" data-page="${i + 1}">${T.tutorial.next}</button>` : `<button class="act primary" data-ov="tut-lessons">${T.tutorial.start}</button>`}
      ${i > 0 ? `<button class="act" data-ov="tut-go" data-page="${i - 1}">${T.tutorial.prev}</button>` : ''}
      <button class="act" data-ov="menu">${T.tutorial.toMenu}</button>
    </div>`;
  }

  /** レッスンの一覧(操作を 1 つずつ覚える練習戦) */
  private showLessons(): void {
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet start">
      <h2>${T.tutorial.lessons}</h2>
      <p class="note">${T.tutorial.lessonsNote}</p>
      ${LESSONS.map((l) => `<button class="act diff" data-ov="tut-start" data-id="${l.id}"><b>${l.title}</b><small>${T.tutorial.learn(l.learn)}</small><small>${l.desc}</small></button>`).join('')}
      <button class="act" data-ov="tutorial">${T.tutorial.toGuide}</button>
      <button class="act" data-ov="menu">${T.tutorial.toMenu}</button>
    </div>`;
  }

  /** チュートリアルのレッスンを始める(自動保存しない)。見つからなければ false */
  startTutorial(id: string = TUTORIAL_ID): boolean {
    const lesson = lessonDef(id);
    if (!lesson) return false;
    this.mg = null;
    const st = createFromDef(lesson, lesson.id, 1);
    // 成長の二択(魔法使いの Lv 2)は、初めての人には早いので、あらかじめ選んだ状態で始める
    for (const u of st.units) if (u.defId === 'mage') u.perks = ['fireMp'];
    this.begin(st);
    this.toast(lesson.intro);
    return true;
  }

  /** 練習戦の間だけ、盤面の上に「次にやること」を出す */
  private updateCoach(): void {
    const el = document.querySelector<HTMLElement>('#coach');
    if (!el) return;
    const st = this.state;
    const lesson = lessonDef(st.scenario ?? '');
    if (!lesson || st.status !== 'playing' || this.playback) {
      el.hidden = true;
      return;
    }
    const plans = Object.values(this.plans).flat();
    const party = this.party();
    const kinds = plans.map((a) => (a.type === 'spell' ? a.spell : a.type === 'charge' ? 'attack' : a.type));
    const step = lesson.coach({
      turn: st.turn,
      plans: kinds,
      foeInSight: this.foesInSight(),
      carrying: party.some((u) => !!u.carrying),
      besideDown: party.some((u) => !u.down && st.units.some((d) => d.side === 'party' && d.down && Math.max(Math.abs(d.x - u.x), Math.abs(d.y - u.y)) <= 1)),
    });
    el.innerHTML = T.tutorial.coach(step + 1, lesson.steps.length, lesson.steps[Math.min(step, lesson.steps.length - 1)]);
    el.hidden = false;
  }

  /** URL を、再読み込みで同じ画面から始められる形にする(指定した以外の開始用の指定は消す) */
  private setUrl(params: Record<string, string>): void {
    const url = new URL(location.href);
    for (const k of ['seed', 'diff', 'floor', 'scenario', 'minigame', 'stage', 'tutorial']) url.searchParams.delete(k);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    history.replaceState(null, '', url);
  }

  /** ミニゲームの 1 ステージを始める(自動保存しない)。見つからなければ false。carry は前のステージからの持ち越し */
  startMinigame(id: string, index = 0, carry?: Carry, results: number[] = [], seed: number = randomSeed()): boolean {
    const def = minigameDef(id);
    const stage = def?.stages[index];
    if (!def || !stage) return false;
    this.mg = { def, index, startCarry: carry, results };
    this.begin(createFromDef(stage, stageScenario(id, index), seed, carry));
    this.toast(T.minigame.stageIntro(index + 1, def.stages.length, stage.title, stage.desc));
    return true;
  }

  /** 今のミニゲーム(固定遭遇・キャンペーンのときは null)。results は勝ったステージごとのターン数 */
  private mg: { def: MinigameDef; index: number; startCarry?: Carry; results: number[] } | null = null;

  /** 固定遭遇を始める(自動保存しない)。見つからなければ false */
  startEncounter(id: string, seed: number = randomSeed()): boolean {
    const st = createEncounter(id, seed);
    if (!st) return false;
    this.mg = null;
    this.begin(st);
    return true;
  }

  private pendingSeed = 0;

  /** persist=false は難易度選択の後ろに映すだけの仮のゲーム(保存しない) */
  /** startFloor: デバッグ用に途中の階から始める(URL の &floor=) */
  start(seed: number, difficulty: Difficulty = 'normal', persist = true, startFloor = 0): void {
    this.mg = null;
    this.begin(generateGame(seed, difficulty, Math.max(0, Math.min(FLOORS, startFloor))));
    if (persist) {
      saveGame(this.state);
      // 前のキャンペーンの宿・馬小屋の保存は使えなくする
      clearInn();
    }
  }

  /** 自動保存から続きを始める。起動 1 回ごとに、銀行の預金に利息が付く(まれに暴落する) */
  /** fromInn: 宿・馬小屋の保存から始める(自動保存をその状態で上書きする) */
  resume(state: GameState, fromInn = false): void {
    const day = bankDay(state, Math.random());
    if ((day || fromInn) && !state.scenario) saveGame(state);
    this.mg = null;
    this.begin(state);
    const notes = [fromInn ? T.toast.resumedInn(state.turn) : T.toast.resumed(state.turn)];
    if (day) notes.push(day.crash ? T.facility.bank.crash(day.amount) : T.facility.bank.interest(day.amount));
    this.toast(notes.join('\n'));
  }

  private begin(state: GameState): void {
    this.stopAuto();
    this.state = state;
    this.names = displayNames(this.state.units);
    this.playback = null;
    this.lastPlayback = null;
    this.history = [];
    this.replaying = false;
    this.selected = null;
    this.lastMode.clear();
    this.el.overlay.hidden = true;
    const party = this.party();
    this.renderer.resize();
    this.renderer.centerOn(centroid(party));
    this.beginPlanning();
    // 途中の階や固定遭遇から始めると、最初から成長の二択を選べることがある
    this.showPerkChoice();
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
    this.timelineTick = null;
    this.plans = {};
    for (const u of this.party()) this.plans[u.id] = [];
    const first = this.party().find((u) => !u.down);
    if (!this.selected || this.unit(this.selected)?.down) this.selected = first?.id ?? null;
    this.mode = this.defaultMode(this.selected);
    // 選んでいるキャラが画面の外なら、そこへ盤面を寄せる
    const sel = this.selected ? this.unit(this.selected) : undefined;
    if (sel && !this.renderer.inView(sel, 0.1)) this.focusOn(sel);
    this.frameFoes();
    this.refresh();
    if (this.state.status !== 'playing') return this.showResult();
    this.continueAuto();
  }

  private execute(fast = false): void {
    // 止まるマスが重なっている・射線を味方が塞ぐ見込みなら知らせる(実行はする)
    if (!fast) {
      const notes: string[] = [];
      if (this.overlaps().length > 0) notes.push(T.toast.overlap);
      const shots = this.blockedShots();
      if (shots.length > 0) notes.push(T.toast.blockedShot(shots.map((b) => this.names.get(b.id) ?? b.id).join('・')));
      if (notes.length > 0) this.toast(notes.join('\n'));
    }
    // 指定されていない残り AP は、敵が見えていれば防御、見えなければ休憩(待機)にする
    const combat = this.foesInSight();
    const filled: Plans = {};
    for (const u of this.party()) if (!u.down) filled[u.id] = fillPlan(this.plans[u.id] ?? [], combat ? 'guard' : 'wait');
    const result = resolveTurn(this.state, { ...this.enemyPlans, ...filled });
    this.playback = new Playback(this.state, result);
    this.userPanned = false;
    // クイック移動の再生は速くする
    if (fast) this.playback.speed = 4;
    this.lastPlayback = this.playback;
    this.pushHistory(this.state, result);
    this.state = result.state;
    // ターンが終わるたびに自動保存する(決着したら保存を消す)。固定遭遇は保存しない
    if (!this.state.scenario) saveGame(this.state);
    this.refresh();
  }

  private finishPlayback(): void {
    const pb = this.playback;
    this.playback = null;
    if (this.replaying) {
      this.replaying = false;
      this.refresh();
      return;
    }
    // 階段で別の階へ移った: 新しい階の敵の表示名を足し、パーティを映す
    const events = pb?.result.events ?? [];
    const notes: string[] = [];
    const moved = events.find((e) => e.type === 'stairs');
    if (moved && moved.type === 'stairs') {
      this.names = new Map([...this.names, ...displayNames(this.state.units)]);
      // 再生中に追っていたカメラの目標は前の階の座標なので捨てる
      this.camGoal = null;
      this.renderer.centerOn(centroid(this.party()));
      // 全員移動の行き先は前の階の座標なので、ここで止める
      this.stopAuto();
      notes.push(T.log.stairs(moved.from, moved.to));
    }
    // 正体を現した盗人は、以後「野盗」と呼ぶ
    for (const e of events) {
      if (e.type !== 'unmask') continue;
      const u = this.unit(e.id);
      if (u) this.names.set(u.id, u.name);
    }
    // 住人の噂は通知にも出す(ログは流れてしまうので)
    for (const e of events) if (e.type === 'rumor') notes.push(rumorText(this.names.get(e.id) ?? e.id, e.rumor));
    const lv = levelUpNote(events, (id) => this.names.get(id) ?? id, this.party().length);
    if (lv) notes.push(lv);
    if (this.restNote) notes.push(this.restNote);
    this.restNote = '';
    if (notes.length > 0) this.toast(notes.join('\n'));
    this.beginPlanning();
    this.showPerkChoice();
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
    } else if (this.settings.hints && this.foesInSight() && Math.floor(now / 90) !== Math.floor(prev / 90)) {
      // 戦闘中の予約画面では、敵の狙いラインを穏やかに点滅させる(約 11fps 更新で省電力を保つ)
      this.dirty = true;
    }
    if (this.dirty) {
      this.dirty = false;
      this.renderer.draw(this.buildView(now));
      this.updatePanel();
    }
    requestAnimationFrame((t) => this.loop(t, now));
  }

  private refresh(): void {
    this.dirty = true;
    this.panelKey = '';
  }

  // ---- 表示 ----

  /** 予約画面で基準にするティック(手動指定があればそれ、無ければ選択中キャラの行動モードから決まるティック) */
  private activePreviewTick(): number {
    if (this.timelineTick !== null) return this.timelineTick;
    const sel = this.selected ? this.unit(this.selected) : undefined;
    if (!sel || sel.down) return 0;
    const plan = this.plans[sel.id] ?? [];
    return cursorTickFor(plan, this.mode, shoveDelay(this.state, sel, plan));
  }

  private buildView(now = 0): View {
    const pb = this.playback;
    const noFog = this.settings.noFog;
    if (pb) {
      const fi = pb.frameIndex();
      const map = pb.mapAt(fi);
      const visible = noFog ? null : pb.visible[fi];
      const snaps = pb.units();
      const units: DisplayUnit[] = [];
      for (const s of snaps) {
        const u = pb.before.units.find((x) => x.id === s.id)!;
        // 敵は味方の視界に入っているものだけ描く。倒れた敵は一定ターンたつと消す
        if (u.side === 'enemy' && visible && !visible[s.y * map.w + s.x]) continue;
        const after = pb.result.state.units.find((x) => x.id === s.id) ?? u;
        if (s.down && corpseGone(after, pb.before.turn)) continue;
        const d = stats(u);
        units.push({ id: s.id, icon: d.icon, side: u.side, x: s.fx, y: s.fy, hp: s.hp, maxHp: d.maxHp, down: s.down, guard: s.guard, watch: s.watch, selected: false, carrying: s.carrying });
      }
      const tr = pb.treasure();
      for (const u of units) u.treasure = !!tr && tr.holder === u.id;
      return { map, explored: pb.explored[fi], visible, units, marks: [], hints: [], effects: pb.effects(), treasureAt: tr?.at, pointers: this.pointers(pb.before, pb.explored[fi], tr?.at ?? null) };
    }

    const st = this.state;
    const obj = st.objective;
    const visible = noFog ? null : sideVisibleMask(st.map, st.units, 'party');
    const seen = (u: Unit) => !visible || visible[u.y * st.map.w + u.x];
    const previewTick = this.activePreviewTick();
    const snappedUnits = unitsAtTick(st, this.plans, previewTick);
    const units: DisplayUnit[] = [];
    for (const u of st.units) {
      if (u.side !== 'party' && !(seen(u) && !corpseGone(u, st.turn))) continue;
      const d = stats(u);
      const treasure = obj?.kind === 'treasure' && obj.holder === u.id;
      // 予約済みの他の味方は、基準ティック(previewTick)の予定位置に動かして描き、元の位置には薄い残像を残す
      if (u.side === 'party' && !u.down && (this.timelineTick !== null || u.id !== this.selected) && previewTick > 0) {
        const at = snappedUnits.find((x) => x.id === u.id)!;
        if (at.x !== u.x || at.y !== u.y) {
          units.push({ id: `${u.id}@0`, icon: d.icon, side: u.side, x: u.x, y: u.y, hp: u.hp, maxHp: d.maxHp, down: false, guard: false, watch: false, selected: false, faint: true });
          units.push({ id: u.id, icon: d.icon, side: u.side, x: at.x, y: at.y, hp: u.hp, maxHp: d.maxHp, down: false, guard: false, watch: false, selected: u.id === this.selected, carrying: !!u.carrying, treasure });
          continue;
        }
      }
      units.push({ id: u.id, icon: d.icon, side: u.side, x: u.x, y: u.y, hp: u.hp, maxHp: d.maxHp, down: u.down, guard: false, watch: false, selected: u.id === this.selected, carrying: !!u.carrying, treasure });
    }

    const marks: Mark[] = [];
    for (const u of this.party()) {
      marks.push(...planMarks(st, u, this.plans[u.id] ?? [], u.id === this.selected ? '#ffe14a' : '#5ab0ffaa'));
    }
    // 対象を選ぶモードでは、発動ティックの味方予定位置(snappedUnits)を基準に、届くマスと届く相手を出す
    const sel = this.selected ? this.unit(this.selected) : undefined;
    if (sel && !sel.down && TARGET_MODES.has(this.mode)) {
      const from = previewPlan(st, sel, this.plans[sel.id] ?? []).end;
      const { tiles, targets, blind } = reachInfo(st, sel, from, this.mode, snappedUnits);
      for (const p of tiles) marks.push({ kind: 'area', at: p, radius: 0, color: 'rgba(110,190,255,0.13)' });
      // 火球: 見えないマス(撃てるが着弾点がずれる)
      for (const p of blind) marks.push({ kind: 'area', at: p, radius: 0, color: 'rgba(255,150,60,0.12)' });
      for (const t of targets) if (t.side === 'party' || seen(t)) marks.push({ kind: 'target', at: t, color: '#7fe07f' });
    }
    // 基準ティックに攻撃・魔法が発動する味方には橙の印を付ける
    if (previewTick > 0) {
      const filler = this.foesInSight() ? 'guard' : 'wait';
      for (const u of this.party()) {
        if (u.down) continue;
        const plan = this.plans[u.id] ?? [];
        const at = snappedUnits.find((x) => x.id === u.id)!;
        if (this.timelineTick !== null && u.id === this.selected && (at.x !== u.x || at.y !== u.y)) {
          marks.push({ kind: 'ghost', at, icon: stats(u).icon });
        }
        if (tickCells(plan, filler, { st, u })[previewTick - 1]?.hit) marks.push({ kind: 'target', at, color: '#ffb040' });
      }
    }
    // 止まるマスが重なっている所は赤い枠で知らせる
    for (const p of this.overlaps()) marks.push({ kind: 'area', at: p, radius: 0, color: 'rgba(255,40,40,0.35)' }, { kind: 'target', at: p, color: '#ff3030' });
    // 発射のときに味方が射線を塞ぐ見込みの射撃は、撃つ位置に赤い札を出す(例「塞4」= 4 ティック目)
    for (const b of this.blockedShots()) marks.push({ kind: 'tag', at: b.at, text: `塞${b.tick}`, color: '#ff6060' });
    if (this.settings.debugPlans) {
      for (const u of st.units) if (u.side === 'enemy' && !u.down) marks.push(...planMarks(st, u, this.enemyPlans[u.id] ?? [], '#ff5a5a99'));
    }
    const hints = this.settings.hints
      ? st.units
          .filter((u) => u.side === 'enemy' && !u.down && seen(u) && !isNeutral(u))
          .map((u) => {
            const plan = this.enemyPlans[u.id] ?? [];
            // ブレス・火球・業火は着弾予定の範囲と、発動するティックも見せる(読んでよければ避けられる・止められる)
            const bi = plan.findIndex((a) => a.type === 'spell' && !!a.tile);
            const b = plan[bi];
            const area =
              b && b.type === 'spell' && b.tile ? { at: b.tile, radius: SPELLS[b.spell].radius, tick: planCost(plan.slice(0, bi + 1)) } : undefined;
            // 単体の味方を狙う敵からは、狙っている味方(開始位置)へオレンジの点滅ラインを出す
            const pt = plannedTarget(plan, { unit: u, map: st.map, units: st.units });
            const tgt = pt ? st.units.find((p) => p.id === pt.target && !p.down) : undefined;
            const aim = pt && tgt ? { to: { x: tgt.x, y: tgt.y }, charge: pt.charge, power: pt.power } : undefined;
            const intent = summarizeIntent(plan, u);
            // 単体の攻撃は、発動するティックを印に添える(「!3」「強5」「追6」。接近攻撃がこのターンに届かない見込みなら「追」だけ)
            const hitLabel =
              pt && (intent === 'attack' || intent === 'power')
                ? pt.charge
                  ? `追${pt.tick ?? ''}`
                  : `${pt.power ? '強' : '!'}${pt.tick}`
                : undefined;
            // 警報役は、増援を呼ぶまでの残りターンを出す(例「笛2」)
            const left = u.ai?.alarm !== undefined && !u.ai.alarmRaised ? RULES.alarmTurns - u.ai.alarm : undefined;
            // 盗んだ野盗は「盗」の印(逃げている)
            const label = left !== undefined ? `笛${left}` : u.ai?.stolen ? '盗' : hitLabel;
            return { at: { x: u.x, y: u.y }, intent, area, aim, label };
          })
      : [];
    const treasureAt = treasureHere(st);
    const pulse = (now % 1100) / 1100;
    return { map: st.map, explored: st.explored, visible, units, marks, hints, pulse, effects: [], treasureAt, pointers: this.pointers(st, st.explored, treasureAt) };
  }

  /** 画面外の目印: 上り階段(入口)、見つけた下り階段・秘宝、(誰も映っていなければ)味方 */
  private pointers(st: GameState, explored: ArrayLike<number>, treasureAt: Pos | null): { at: Pos; color: string; label: string }[] {
    const out: { at: Pos; color: string; label: string }[] = [];
    if (!this.settings.pointers) return out;
    const seen = (p: Pos) => !!explored[p.y * st.map.w + p.x];
    const up = findTile(st.map, 'S');
    if (up) out.push({ at: up, color: '#c8b070', label: currentFloor(st) === 1 ? T.pointer.surface : T.pointer.stairs });
    // 地上: 見つけた施設
    if (currentFloor(st) === 0) {
      for (const [f, c] of Object.entries(FACILITY_TILE) as [FacilityId, string][]) {
        const p = findTile(st.map, c);
        if (p && seen(p)) out.push({ at: p, color: '#9fe0a0', label: T.facility[f].name });
      }
    }
    const down = findTile(st.map, '>');
    if (down && seen(down)) out.push({ at: down, color: '#b08cff', label: T.pointer.down });
    if (treasureAt && seen(treasureAt)) out.push({ at: treasureAt, color: '#ffd23a', label: T.pointer.treasure });
    // 救出の対象(固定遭遇)。画面の外にいれば場所を示す
    const o = st.objective;
    const who = o?.kind === 'escape' ? st.units.find((u) => u.id === o.who) : undefined;
    if (who && !this.renderer.inView(who)) out.push({ at: who, color: '#ff8080', label: T.pointer.rescue(who.name) });
    const party = this.party().filter((u) => !u.down);
    if (party.length > 0 && !party.some((u) => this.renderer.inView(u))) out.push({ at: centroid(party), color: '#5ab0ff', label: T.pointer.party });
    return out;
  }

  /** トップバーの「ターン・難易度・目的」 */
  private statusLine(): string {
    const st = this.state;
    const o = st.objective;
    const goal = o?.kind === 'treasure' ? T.objectiveShort[o.holder ? 'treasureHeld' : 'treasure'] : T.objectiveShort[o?.kind ?? 'annihilate'];
    // 固定遭遇は階とゴールドの代わりに遭遇の名前を出す
    if (this.mg) return `${this.mg.def.title} ${this.mg.index + 1}/${this.mg.def.stages.length}·${T.turnShort(st.turn)}·${goal}`;
    if (st.scenario) return `${encounterDef(st.scenario)?.title ?? st.scenario}·${T.turnShort(st.turn)}·${goal}`;
    return `${T.floor(currentFloor(st))}·${T.turnShort(st.turn)}·${goal}`;
  }

  private updatePanel(): void {
    const pb = this.playback;
    const key = pb ? `pb:${pb.currentTick()}:${pb.paused}:${pb.speed}:${pb.eventsSoFar().length}` : `plan:${this.panelVersion}`;
    if (key === this.panelKey) return;
    this.panelKey = key;
    const nameOf = (id: string) => this.names.get(id) ?? id;

    this.updateCoach();
    const turnEl = this.el.topbar.querySelector<HTMLElement>('.turn')!;
    turnEl.textContent = this.statusLine();
    turnEl.title = `${T.floorLong(currentFloor(this.state))} · ${T.difficulty[this.state.difficulty ?? 'normal']} · ${T.objective[this.state.objective?.kind ?? 'annihilate']}`;
    const replay = this.el.topbar.querySelector<HTMLButtonElement>('[data-top="replay"]')!;
    replay.disabled = !this.lastPlayback || !!pb;

    if (pb) {
      const before = pb.before.units.filter((u) => u.side === 'party');
      const snaps = pb.units();
      const shown = before.map((u) => {
        const s = snaps.find((x) => x.id === u.id)!;
        return { ...u, hp: s.hp, mp: s.mp, down: s.down };
      });
      const tr = pb.treasure();
      this.el.panel.innerHTML = `
        ${this.inventory(pb.before, pb.eventsSoFar(), tr?.holder ?? null)}
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
      ? `<b>${nameOf(sel.id)}</b> <span class="ap">AP ${this.apFor(sel)}/8</span>${vitals(sel)}${planChips(acts, nameOf, this.foesInSight())}`
      : `<span class="chip empty">${sel ? `${nameOf(sel.id)} は${T.down}している` : T.prompt.selectUnit}</span>`;
    const promptText = active ? prompt : '';
    const potion = active
      ? potionButton(this.potionKind, this.state.items, this.mode === 'potion', this.potionOff(sel, acts))
      : potionButton(this.potionKind, this.state.items, false, true);
    const hasPlan = active && acts.length > 0;
    const actions = active ? actionButtons(sel, acts, this.mode, { potion, noMagic: currentFloor(this.state) === 0 }) : idleButtons({ potion });
    const o = this.state.objective;
    this.el.panel.innerHTML = `
      ${this.inventory(this.state, [], o?.kind === 'treasure' ? o.holder ?? null : null, true)}
      ${partyCards(this.party(), this.plans, this.selected)}
      <div class="plan">${status}</div>
      <p class="prompt" data-prompt="${promptText}">${promptText}</p>
      <div class="acts">
        ${actions}
        <span class="act-gap"></span>
        ${actButton('rest', { off: this.foesInSight() })}
        ${actButton('group', { on: this.mode === 'group', off: !active || this.foesInSight() })}
        ${actButton('undo', { off: !hasPlan })}
        ${actButton('execute', { cls: 'primary' })}
      </div>
      ${timeline(this.party(), this.plans, nameOf, this.foesInSight() ? 'guard' : 'wait', this.timelineTick, this.selected, active ? cursorTickFor(acts, this.mode, shoveDelay(this.state, sel, acts)) : null, this.state)}
      ${this.lastPlayback ? summaryList(turnSummary(this.lastPlayback.result.events, this.lastPlayback.before.units, nameOf)) : '<ul class="log"></ul>'}`;
  }

  /**
   * 持ち物の欄。再生中は、ターンの初めの持ち物に、それまでに起きた出来事(宝箱・警報役の宝・回復薬)を足し引きして出す。
   * withFacility: 誰かが施設の部屋にいて、敵が見えていなければ、右端にその施設の名前のボタンを出す(予約中だけ)
   */
  private inventory(st: GameState, events: GameEvent[], holder: string | null, withFacility = false): string {
    let gold = st.gold ?? 0;
    const items = { ...st.items };
    events.forEach((e, i) => {
      if (e.type === 'chest' || e.type === 'bounty' || e.type === 'loot' || e.type === 'recover') gold += e.gold;
      if (e.type === 'steal') gold -= e.gold;
      if (e.type === 'ration' && e.food) items.food = Math.max(0, (items.food ?? 0) - 1);
      // 回復薬は、使った直後の回復の出来事で種類が分かる
      if (e.type === 'strike' && e.kind === 'potion') {
        const h = events[i + 1];
        const k: ItemId = h?.type === 'heal' && h.mp ? 'mp' : 'hp';
        items[k] = Math.max(0, (items[k] ?? 0) - 1);
      }
    });
    // 加護は、再生中に使われたら(持ち直した出来事があれば)消して出す
    const blessing = !!st.blessing && !events.some((e) => e.type === 'blessing');
    const fac = withFacility ? this.facility() : null;
    return inventoryBar(gold, items, holder && (this.names.get(holder) ?? holder), st.bank ?? 0, blessing, fac ? T.facility[fac].name : undefined);
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
    // 長い通知(2 行など)は読み切れるよう長めに出す
    this.toastTimer = window.setTimeout(() => this.el.toast.classList.remove('show'), Math.max(1600, msg.length * 70));
  }

  private showResult(): void {
    this.stopAuto();
    // 結果の後ろに、パーティのいる場所を映す
    this.focusOn(centroid(this.party()));
    const won = this.state.status === 'won';
    this.el.overlay.hidden = false;
    if (this.mg) return this.showStageResult(won);
    const lesson = lessonDef(this.state.scenario ?? '');
    if (lesson) {
      const next = LESSONS[LESSONS.indexOf(lesson) + 1];
      this.el.overlay.innerHTML = won
        ? `<div class="sheet result won">
        <h2>${next ? T.tutorial.lessonDone(lesson.title) : T.tutorial.doneTitle}</h2>
        <p>${next ? T.tutorial.lessonDoneBody(lesson.learn) : T.tutorial.doneBody}</p>
        ${next ? `<button class="act primary" data-ov="tut-start" data-id="${next.id}">${T.tutorial.nextLesson(next.title)}</button>` : `<button class="act primary" data-ov="campaign">${T.tutorial.toCampaign}</button>`}
        <button class="act" data-ov="retry">${T.tutorial.retry}</button>
        <button class="act" data-ov="tut-lessons">${T.tutorial.toLessons}</button>
        <button class="act" data-ov="menu">${T.tutorial.toMenu}</button>
      </div>`
        : `<div class="sheet result lost">
        <h2>${T.tutorial.lost}</h2>
        <button class="act primary" data-ov="retry">${T.tutorial.retry}</button>
        <button class="act" data-ov="tut-lessons">${T.tutorial.toLessons}</button>
        <button class="act" data-ov="menu">${T.tutorial.toMenu}</button>
      </div>`;
      return;
    }
    // キャンペーンを勝ち終えたら、宿・馬小屋の保存も消す(全滅したときは、そこからやり直せるよう残す)
    if (won && !this.state.scenario) clearInn();
    this.el.overlay.innerHTML = `<div class="sheet result ${won ? 'won' : 'lost'}">
      <h2>${won ? (({ treasure: T.result.wonTreasure, escape: T.result.wonEscape }) as Record<string, string>)[this.state.objective?.kind ?? ''] ?? T.result.won : T.result.lost}</h2>
      <p>${T.difficulty[this.state.difficulty ?? 'normal']} · ${T.turn(this.state.turn - 1)} で決着</p>
      <p>${T.result.summary(this.state.deepest ?? currentFloor(this.state), T.gold(this.state.gold ?? 0))}</p>
      <p>${this.party().map((u) => `${u.name} ${T.level(u.level ?? 1)}`).join(' · ')}</p>
      ${this.state.scenario ? `<button class="act primary" data-ov="retry">${T.result.retry}</button>` : ''}
      <button class="act${this.state.scenario ? '' : ' primary'}" data-ov="new">${T.settings.newGame}</button>
      <button class="act" data-ov="close">${T.settings.close}</button>
    </div>`;
  }

  /** ミニゲームの 1 ステージが終わったときの画面: 途中なら次へ、最後なら評価、負けたらやり直し */
  private showStageResult(won: boolean): void {
    const mg = this.mg!;
    const n = mg.def.stages.length;
    const stage = mg.def.stages[mg.index];
    const par = stage.par ?? 0;
    const turns = this.state.turn - 1;
    if (won) mg.results[mg.index] = turns;
    const menu = `<button class="act" data-ov="menu">${T.minigame.toMenu}</button>`;
    if (!won) {
      this.el.overlay.innerHTML = `<div class="sheet result lost">
        <h2>${T.minigame.lost(mg.index + 1, n)}</h2>
        <button class="act primary" data-ov="retry">${T.minigame.retryStage}</button>
        ${menu}
      </div>`;
      return;
    }
    if (mg.index + 1 < n) {
      this.el.overlay.innerHTML = `<div class="sheet result won">
        <h2>${T.minigame.stageClear(mg.index + 1, n, stage.title)}</h2>
        <p>${T.minigame.stageTurns(turns, par)}</p>
        <p>${T.minigame.breakNote}</p>
        <button class="act primary" data-ov="mg-next">${T.minigame.next}</button>
        ${menu}
      </div>`;
      return;
    }
    const total = mg.results.reduce((s, t) => s + t, 0);
    const totalPar = mg.def.stages.reduce((s, g) => s + (g.par ?? 0), 0);
    const rank = rankOf(mg.def, total);
    const alive = this.party().every((u) => !u.down);
    this.el.overlay.innerHTML = `<div class="sheet result won">
      <h2>${T.minigame.allClear(mg.def.title)}</h2>
      <p class="rank rank-${rank}">${rank}</p>
      <p>${T.minigame.total(total, totalPar)}</p>
      <p>${mg.def.stages.map((g, i) => `${g.title} ${mg.results[i]}/${g.par}`).join(' · ')}</p>
      ${alive ? `<p>${T.minigame.allAlive}</p>` : ''}
      <p class="note">${T.minigame.rankNote}</p>
      <button class="act primary" data-ov="mg-again">${T.minigame.again}</button>
      ${menu}
    </div>`;
  }

  /** 成長の二択がまだのキャラがいれば、選ぶ画面を出す(選ぶまで閉じない) */
  private showPerkChoice(): boolean {
    if (this.state.status !== 'playing') return false;
    const u = this.party().find((p) => pendingPerk(p));
    if (!u) return false;
    const choices = pendingPerk(u)!;
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet perk">
      <h2>${T.perk.title(u.name, u.level ?? 1)}</h2>
      ${choices.map((p) => `<button class="act diff" data-ov="perk" data-id="${u.id}" data-perk="${p}"><b>${PERKS[p].name}</b><small>${PERKS[p].desc}</small></button>`).join('')}
      <p class="note">${T.perk.note}</p>
    </div>`;
    return true;
  }

  /** 使える施設: 立っている味方が地上の施設のマスにいて、敵が見えていなければ、その施設 */
  private facility(): FacilityId | null {
    if (this.state.status !== 'playing' || this.foesInSight()) return null;
    return facilityHere(this.state);
  }

  /** 施設の画面(宿・馬小屋・道具屋・療養所)。使っても時間は進まない */
  private showFacility(): void {
    const f = this.facility();
    if (!f) return;
    const st = this.state;
    const gold = st.gold ?? 0;
    const text = T.facility[f];
    let body = '';
    if (f === 'shop') {
      body = (Object.keys(ITEMS) as ItemId[])
        .map((k) => {
          const it = ITEMS[k];
          return `<div class="row"><span>${it.icon}${it.name} · ${T.shop.have(st.items?.[k] ?? 0)}</span>
            <button class="act" data-ov="buy" data-item="${k}" ${gold < it.price ? 'disabled' : ''}>${T.shop.buy(it.short, it.price)}</button></div>`;
        })
        .join('');
    } else if (f === 'inn') {
      const cost = innCost(st);
      body = `<button class="act primary" data-ov="inn" ${gold < cost || !anyTired(st) ? 'disabled' : ''}>${T.facility.inn.use(cost)}</button>`;
    } else if (f === 'stable') {
      body = `<button class="act primary" data-ov="stable">${T.facility.stable.use(Math.round(TOWN.stableHpRatio * 100))}</button>`;
    } else if (f === 'bank') {
      const bank = st.bank ?? 0;
      const step = TOWN.bankStep;
      body = `<p>${T.facility.bank.balance(bank)}</p>
        <div class="row">
          <button class="act" data-ov="deposit" data-amount="${step}" ${gold <= 0 ? 'disabled' : ''}>${T.facility.bank.deposit(step)}</button>
          <button class="act" data-ov="deposit" data-amount="all" ${gold <= 0 ? 'disabled' : ''}>${T.facility.bank.depositAll}</button>
        </div>
        <div class="row">
          <button class="act" data-ov="withdraw" data-amount="${step}" ${bank <= 0 ? 'disabled' : ''}>${T.facility.bank.withdraw(step)}</button>
          <button class="act" data-ov="withdraw" data-amount="all" ${bank <= 0 ? 'disabled' : ''}>${T.facility.bank.withdrawAll}</button>
        </div>`;
    } else if (f === 'church') {
      const cost = churchCost(st);
      body = st.blessing
        ? `<p class="note">${T.facility.church.active}</p>`
        : `<button class="act primary" data-ov="church" ${gold < cost ? 'disabled' : ''}>${T.facility.church.use(cost)}</button>`;
    } else {
      const downed = this.party().filter((u) => u.down);
      body = downed.length
        ? downed
            .map((u) => `<div class="row"><span>${this.names.get(u.id) ?? u.name}(${T.level(u.level ?? 1)})</span>
              <button class="act" data-ov="clinic" data-id="${u.id}" ${gold < clinicCost(u) ? 'disabled' : ''}>${T.facility.clinic.use(clinicCost(u))}</button></div>`)
            .join('')
        : `<p class="note">${T.facility.clinic.none}</p>`;
    }
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet shop">
      <h2>${text.name}</h2>
      <p class="note">${text.note}</p>
      <p>${T.shop.gold(gold)}</p>
      ${body}
      <button class="act" data-ov="close">${T.settings.close}</button>
    </div>`;
  }

  /**
   * 宿・馬小屋で「全員休憩」を押したとき: その施設で休み(宿は宿代を払って泊まる。足りなければ泊まらない)、
   * 結果にかかわらず保存して、そのことを知らせる
   */
  private restAtFacility(fac: 'inn' | 'stable'): void {
    const st = this.state;
    // 回復の必要が無ければ、保存だけする
    let msg = '';
    if (fac === 'inn') {
      if (anyTired(st)) msg = useInn(st) ? T.facility.inn.done : T.facility.inn.poor(innCost(st));
    } else {
      msg = useStable(st) ? T.facility.stable.done : T.facility.stable.nothing;
    }
    saveGame(st);
    saveInn(st);
    this.toast(T.toast.saved(msg));
    // 予約を足したりモードを変えたら、手動のティック固定は解除して現在の操作ティックに追従させる
    this.timelineTick = null;
    this.changed();
  }

  /** 施設を使った後: 保存して、画面と施設の画面を描き直す */
  private facilityUsed(msg?: string): void {
    if (!this.state.scenario) saveGame(this.state);
    if (msg) this.toast(msg);
    this.changed();
    this.showFacility();
  }

  /** 履歴の画面: 新しいターンから順に、味方ごとの要約と経過の全部 */
  private showHistory(): void {
    const nameOf = (id: string) => this.names.get(id) ?? id;
    const turns = [...this.history]
      .reverse()
      .map(
        (h) => `<section class="turn-log">
          <h3>${T.history.turn(h.turn)}</h3>
          ${summaryList(turnSummary(h.events, h.before, nameOf))}
          <details><summary>${T.history.detail}</summary>${eventLog(h.events, nameOf, Infinity)}</details>
        </section>`,
      )
      .join('');
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet history">
      <h2>${T.history.title}</h2>
      <div class="turns">${turns || `<p class="note">${T.history.empty}</p>`}</div>
      <button class="act primary" data-ov="close">${T.settings.close}</button>
    </div>`;
  }

  /** seed: シード欄に出す値(並び替えで描き直すとき、入力途中の値を残す) */
  private settingsFromCampaign = false;

  private showSettings(): void {
    const s = this.settings;
    this.el.overlay.hidden = false;
    this.el.overlay.innerHTML = `<div class="sheet">
      <h2>${T.settings.title}</h2>
      <label><input type="checkbox" data-set="hints" ${s.hints ? 'checked' : ''}> ${T.settings.hints}</label>
      <label><input type="checkbox" data-set="pointers" ${s.pointers ? 'checked' : ''}> ${T.settings.pointers}</label>
      ${this.formationSection()}
      <div class="row">
        <button class="act primary" data-ov="settings-close">${T.settings.close}</button>
      </div>
    </div>`;
  }

  /** 設定画面の「隊列」: 近い順(自動)か指定した順か。指定した順は ▲▼ で並べ替える */
  private formationSection(): string {
    const order = this.formationOrder();
    const custom = !!this.settings.formation;
    const nameOf = (id: string) => this.names.get(id) ?? id;
    const rows = order
      .map(
        (id, i) => `<li><span>${i + 1}. ${nameOf(id)}</span>
          <button class="act small" data-ov="form-up" data-id="${id}" ${!custom || i === 0 ? 'disabled' : ''} aria-label="${T.formation.up}">▲</button>
          <button class="act small" data-ov="form-down" data-id="${id}" ${!custom || i === order.length - 1 ? 'disabled' : ''} aria-label="${T.formation.down}">▼</button></li>`,
      )
      .join('');
    return `<fieldset class="formation">
      <legend>${T.formation.title}</legend>
      <label><input type="radio" name="formation" data-formation="auto" ${custom ? '' : 'checked'}> ${T.formation.auto}</label>
      <label><input type="radio" name="formation" data-formation="custom" ${custom ? 'checked' : ''}> ${T.formation.custom}</label>
      <ol class="${custom ? '' : 'off'}">${rows}</ol>
      <p class="note">${T.formation.note}</p>
    </fieldset>`;
  }

  /** 設定画面に出す隊列の順(自動のときは味方の並びのまま) */
  private formationOrder(): string[] {
    const ids = this.party().map((u) => u.id);
    const f = this.settings.formation;
    if (!f) return ids;
    return [...f.filter((id) => ids.includes(id)), ...ids.filter((id) => !f.includes(id))];
  }

  private moveInFormation(id: string, delta: number): void {
    const order = this.formationOrder();
    const i = order.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    this.settings.formation = order;
    saveSettings(this.settings);
  }

  // ---- 入力 ----

  private onTopbarClick(e: Event): void {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-top]');
    if (!b) return;
    if (b.dataset.top === 'settings') { this.pendingSeed = randomSeed(); this.showCampaign(); }
    if (b.dataset.top === 'history' && !this.playback) this.showHistory();
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
      // 難易度選択と成長の二択は選ぶまで閉じない
      if (e.target === this.el.overlay && !this.el.overlay.querySelector('.start, .perk')) this.el.overlay.hidden = true;
      return;
    }
    if (b.dataset.ov === 'close') this.el.overlay.hidden = true;
    if (b.dataset.ov === 'perk') {
      const u = this.unit(b.dataset.id!);
      if (u && pendingPerk(u)) {
        u.perks = [...(u.perks ?? []), b.dataset.perk!];
        if (!this.state.scenario) saveGame(this.state);
        this.el.overlay.hidden = true;
        this.changed();
        this.showPerkChoice();
      }
    }
    const fac = this.facility();
    if (b.dataset.ov === 'buy' && fac === 'shop' && buyItem(this.state, b.dataset.item as ItemId)) this.facilityUsed();
    if (b.dataset.ov === 'inn' && fac === 'inn' && useInn(this.state)) this.facilityUsed(T.facility.inn.done);
    if (b.dataset.ov === 'stable' && fac === 'stable') this.facilityUsed(useStable(this.state) ? T.facility.stable.done : T.facility.stable.nothing);
    if (b.dataset.ov === 'clinic' && fac === 'clinic' && useClinic(this.state, b.dataset.id!)) this.facilityUsed(T.facility.clinic.done(this.names.get(b.dataset.id!) ?? ''));
    if (b.dataset.ov === 'church' && fac === 'church' && useChurch(this.state)) this.facilityUsed(T.facility.church.done);
    if ((b.dataset.ov === 'deposit' || b.dataset.ov === 'withdraw') && fac === 'bank') {
      const amount = b.dataset.amount === 'all' ? Infinity : Number(b.dataset.amount);
      if ((b.dataset.ov === 'deposit' ? deposit : withdraw)(this.state, amount) > 0) this.facilityUsed();
    }
    if (b.dataset.ov === 'form-up' || b.dataset.ov === 'form-down') {
      this.moveInFormation(b.dataset.id!, b.dataset.ov === 'form-up' ? -1 : 1);
      this.showSettings();
    }
    if (b.dataset.ov === 'new') this.showMenu(randomSeed());
    if (b.dataset.ov === 'campaign-settings') { this.settingsFromCampaign = true; this.showSettings(); }
    if (b.dataset.ov === 'settings-close') {
      if (this.settingsFromCampaign) this.showCampaign();
      else { this.el.overlay.hidden = true; this.refresh(); }
    }
    if (b.dataset.ov === 'menu') this.showMenu(this.pendingSeed);
    if (b.dataset.ov === 'tutorial') this.showTutorialGuide(0);
    if (b.dataset.ov === 'tut-go') this.showTutorialGuide(Number(b.dataset.page));
    if (b.dataset.ov === 'tut-lessons') this.showLessons();
    if (b.dataset.ov === 'tut-start') {
      this.setUrl({ tutorial: b.dataset.id! });
      this.startTutorial(b.dataset.id!);
    }
    if (b.dataset.ov === 'campaign') this.showCampaign();
    if (b.dataset.ov === 'minigames') this.showMinigames();
    if (b.dataset.ov === 'continue-inn') {
      const inn = loadInn();
      if (inn) {
        this.setUrl({});
        this.resume(inn, true);
      }
    }
    if (b.dataset.ov === 'mg-start' || b.dataset.ov === 'mg-again') {
      const id = b.dataset.ov === 'mg-again' ? this.mg!.def.id : b.dataset.id!;
      this.setUrl({ minigame: id });
      this.startMinigame(id);
    }
    if (b.dataset.ov === 'mg-next' && this.mg) {
      const { def, index, results } = this.mg;
      this.setUrl({ minigame: def.id, stage: String(index + 1) });
      this.startMinigame(def.id, index + 1, carryOver(this.state), results);
    }
    if (b.dataset.ov === 'retry' && this.mg) {
      const { def, index, startCarry, results } = this.mg;
      this.startMinigame(def.id, index, startCarry, results.slice(0, index));
    } else if (b.dataset.ov === 'retry' && lessonDef(this.state.scenario ?? '')) {
      this.startTutorial(this.state.scenario!);
    } else if (b.dataset.ov === 'encounter' || b.dataset.ov === 'retry') {
      const id = b.dataset.ov === 'retry' ? this.state.scenario! : b.dataset.id!;
      // 再読み込みで同じ固定遭遇から始められるよう、URL に残す
      this.setUrl({ scenario: id });
      this.startEncounter(id);
    }
    if (b.dataset.ov === 'diff') {
      const diff = b.dataset.diff as Difficulty;
      // 再読み込みで同じゲームから始められるよう、シードと難易度を URL に残す
      this.setUrl({ seed: String(this.pendingSeed), diff });
      this.start(this.pendingSeed, diff);
    }
  }

  private onSettingChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.dataset.formation) {
      this.settings.formation = input.dataset.formation === 'custom' ? this.formationOrder() : null;
      saveSettings(this.settings);
      this.showSettings();
      return;
    }
    const k = input.dataset.set as 'hints' | 'pointers' | undefined;
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
    // クイック移動の途中で何か押したら止める
    if (!pbBtn && this.stopAuto(T.toast.stopped)) return;
    const tickBtn = t.closest<HTMLElement>('[data-tick]');
    if (tickBtn && !this.playback) {
      const n = Number(tickBtn.dataset.tick);
      this.timelineTick = this.timelineTick === n ? null : n;
      this.changed();
      return;
    }
    // 持ち物の欄の右端の施設ボタン
    if (t.closest('[data-fac]') && !this.playback) return this.showFacility();
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
      // 全員の予約を消して休憩する。全快するか敵が見えるまでのターンを、まとめて 1 回で処理する
      if (this.foesInSight()) return this.toast(T.err.cannotRest);
      // 宿・馬小屋にいるときは、その施設で休んで保存する(時間は進まない)
      const fac = this.facility();
      if (fac === 'inn' || fac === 'stable') return this.restAtFacility(fac);
      return this.restAll();
    }
    if (act === 'group') {
      if (this.foesInSight()) return this.toast(T.err.cannotGroup);
      this.mode = 'group';
      if (this.selected) this.lastMode.set(this.selected, 'group');
      return this.changed();
    }
    const u = this.selected ? this.unit(this.selected) : undefined;
    if (!u) return;
    const list = this.plans[u.id];
    switch (act) {
      case 'undo':
        // 長押しで全部取り消した直後のクリックは無視する
        if (this.longPressed) this.longPressed = false;
        else list.pop();
        break;
      case 'watch':
        // 遠隔の武器なら警戒射撃、近接なら迎撃
        this.append(u, { type: stats(u).range > 1 ? 'overwatch' : 'intercept', ticks: this.apFor(u) });
        break;
      case 'guard':
      case 'wait':
      case 'drop':
        this.append(u, { type: act });
        break;
      case 'overwatch':
      case 'intercept':
        this.append(u, { type: act, ticks: this.apFor(u) });
        break;
      case 'cover':
        this.append(u, { type: 'cover' });
        break;
      case 'move':
      case 'attack':
      case 'fireball':
      case 'smite':
      case 'trip':
      case 'power':
      case 'heal':
      case 'revive':
      case 'carry':
        this.mode = act;
        this.lastMode.set(u.id, act);
        break;
      case 'potion':
        // 2 回目は薬の種類を切り替える。選んだ薬を持っていなければ、持っている方にする
        if (this.mode === 'potion') this.potionKind = this.potionKind === 'hp' ? 'mp' : 'hp';
        if (!this.state.items?.[this.potionKind]) this.potionKind = this.potionKind === 'hp' ? 'mp' : 'hp';
        this.mode = 'potion';
        break;
    }
    // 予約を足したりモードを変えたら、手動のティック固定は解除して現在の操作ティックに追従させる
    this.timelineTick = null;
    this.changed();
  }

  /** 回復薬のボタンをグレーにするか(どちらの薬も無い・AP 不足・担いでいる) */
  private potionOff(u: Unit, acts: Action[]): boolean {
    const items = this.state.items ?? {};
    return !(items.hp || items.mp) || apLeft(acts) - shoveDelay(this.state, u, acts) < RULES.itemCost || carryingAfter(u, acts);
  }

  /** 予約済みの回復薬の数(全員分) */
  private reservedItems(kind: PotionId): number {
    return Object.values(this.plans)
      .flat()
      .filter((a) => a.type === 'item' && a.item === kind).length;
  }

  /** キャラごとに最後に選んだ行動モード(選択したときの初期位置にする) */
  private lastMode = new Map<string, Mode>();

  /**
   * そのキャラを選んだときの行動モード。
   * 1. そのキャラに敵が隣接している → 攻撃
   * 2. 誰かの視界に敵がいる → 攻撃
   * 3. 誰の視界にも敵がいない → 全員移動
   * それ以外(担いでいて攻撃できないなど、上が使えないとき)は、そのキャラが最後に選んだモード。
   * 最後のモードも使えなければ移動
   */
  private defaultMode(id: string | null): Mode {
    const u = id ? this.unit(id) : undefined;
    if (!u || u.down) return 'move';
    const st = this.state;
    const plan = this.plans[u.id] ?? [];
    const usable = (m: Mode): boolean => {
      const carrying = carryingAfter(u, plan);
      switch (m) {
        case 'attack':
        case 'carry':
          return !carrying;
        case 'fireball':
        case 'smite':
        case 'trip':
        case 'power':
        case 'heal':
        case 'revive':
          return !carrying && (stats(u).spells as string[]).includes(m);
        case 'group':
          return !this.foesInSight();
        default:
          return true;
      }
    };
    const adjacentFoe = st.units.some((f) => f.side === 'enemy' && !f.down && !isNeutral(f) && adjacent(st.map, u, f));
    const preferred: Mode = adjacentFoe || this.foesInSight() ? 'attack' : 'group';
    if (usable(preferred)) return preferred;
    const last = this.lastMode.get(u.id);
    return last && usable(last) ? last : 'move';
  }

  /** focus=true なら、そのキャラの位置に盤面を寄せる(盤面をタップして選んだときは寄せない) */
  private select(id: string, focus = false): void {
    this.selected = id;
    this.mode = this.defaultMode(id);
    const u = this.unit(id);
    if (focus && u) this.focusOn(u);
    // 予約を足したりモードを変えたら、手動のティック固定は解除して現在の操作ティックに追従させる
    this.timelineTick = null;
    this.changed();
  }

  /** 予約どおりに動いたとき、止まるマスが重なる味方のマス */
  private overlaps(): Pos[] {
    const ends = new Map<string, number>();
    const out: Pos[] = [];
    for (const u of this.party()) {
      if (u.down) continue;
      const e = previewPlan(this.state, u, this.plans[u.id] ?? []).end;
      const k = `${e.x},${e.y}`;
      const n = (ends.get(k) ?? 0) + 1;
      ends.set(k, n);
      if (n === 2) out.push(e);
    }
    return out;
  }

  /** 残り AP(押し返しの踏ん張りで遅れて、このターンに入らなくなる分を引く) */
  private apFor(u: Unit): number {
    const list = this.plans[u.id] ?? [];
    return Math.max(0, apLeft(list) - shoveDelay(this.state, u, list));
  }

  /**
   * 発射のときに味方が射線上にいて不発になる見込みの射撃(遠隔の攻撃だけ)。
   * 撃つ味方・発動するティック・撃つ位置を返す
   */
  private blockedShots(): { id: string; tick: number; at: Pos }[] {
    const st = this.state;
    const out: { id: string; tick: number; at: Pos }[] = [];
    for (const u of this.party()) {
      if (u.down || stats(u).range <= 1) continue;
      const pv = previewPlan(st, u, this.plans[u.id] ?? []);
      pv.steps.forEach((s, i) => {
        if (s.k !== 'strike' || s.action.type !== 'attack') return;
        const tick = i + 1;
        const units = unitsAtTick(st, this.plans, tick);
        const target = s.action.target;
        const t = units.find((x) => x.id === target);
        if (t && !t.down && reachProblem(st.map, u, pv.pos[tick], t, units) === REACH.ally) out.push({ id: u.id, tick, at: pv.pos[tick] });
      });
    }
    return out;
  }

  /** 予約に足す。advance=false なら、AP を使い切っても次のキャラへ移らない */
  private append(u: Unit, a: Action, advance = true): boolean {
    const list = this.plans[u.id];
    // 残り AP 全部を使う行動以外は、押し返しの踏ん張りで遅れる分も足りるかを見る
    const takesRest = a.type === 'charge' || a.type === 'overwatch' || a.type === 'intercept';
    const err = !takesRest && actionCost(a) > this.apFor(u) ? T.err.noAp : canAppend(u, list, a, currentFloor(this.state));
    if (err) {
      this.toast(err);
      return false;
    }
    list.push(a);
    this.changed();
    if (advance) this.advanceIfFull(u);
    return true;
  }

  private onTap(sx: number, sy: number): void {
    if (this.stopAuto(T.toast.stopped)) return;
    if (this.playback) return;
    const tile = this.renderer.screenToTile(sx, sy);
    const st = this.state;
    if (tile.x < 0 || tile.y < 0 || tile.x >= st.map.w || tile.y >= st.map.h) return;
    const visible = this.settings.noFog ? null : sideVisibleMask(st.map, st.units, 'party');
    const u = this.selected ? this.unit(this.selected) : undefined;
    // 基準ティックで動いている味方もその予定位置でタップできるようにする
    const previewTick = this.activePreviewTick();
    const snapped = unitsAtTick(st, this.plans, previewTick);
    const at = st.units.filter((x) => {
      if (x.side !== 'party') return samePos(x, tile) && (!visible || visible[tile.y * st.map.w + tile.x]);
      // 予定位置へ動かして描いている味方は予定位置だけで判定する(元の位置の薄い残像は描くだけ。空いたマスへの移動や回復の相手選びを邪魔しない)
      const p = !x.down && (this.timelineTick !== null || x.id !== u?.id) && previewTick > 0 ? snapped.find((s) => s.id === x.id)! : x;
      return samePos(p, tile);
    });
    const ally = at.find((x) => x.side === 'party');
    const foe = at.find((x) => x.side === 'enemy' && !x.down && !isNeutral(x));

    // クイック移動: 行き先をタップすると、選んでいるキャラを先頭に全員が自動で向かう
    if (u && this.mode === 'group') {
      if (ally && !ally.down && ally.id !== u.id) return this.select(ally.id);
      if (!st.explored[tile.y * st.map.w + tile.x]) return this.toast(T.err.noPath);
      const plans = quickMovePlans(st, u.id, tile, this.settings.formation);
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
      // 敵を狙うモードで味方をタップしたら、そのキャラを選ぶ(接近攻撃の後は次のキャラへ自動で移らないため)
      if ((m === 'attack' || m === 'power' || m === 'trip') && ally && !ally.down && ally.id !== u.id && !foe) return this.select(ally.id);
      const hitTick = cursorTickFor(this.plans[u.id], m, shoveDelay(st, u, this.plans[u.id]));
      const unitsAtHit = unitsAtTick(st, this.plans, hitTick);
      const allyAtHit = ally ? unitsAtHit.find((x) => x.id === ally.id) ?? ally : undefined;
      let ok = false;
      if (m === 'attack' && foe) ok = this.attackOrCharge(u, foe, false);
      else if (m === 'carry' && ally && ally.down && ally.id !== u.id) {
        const end = previewPlan(st, u, this.plans[u.id]).end;
        if (!nearOrSame(st.map, end, ally)) {
          this.toast(T.err.notTarget);
        } else ok = this.append(u, { type: 'carry', target: ally.id });
      }
      else if (m === 'heal' && ally && !ally.down && allyAtHit) ok = this.append(u, { type: 'spell', spell: 'heal', target: ally.id });
      else if (m === 'potion' && ally && !ally.down && allyAtHit) {
        const it = ITEMS[this.potionKind];
        const have = st.items?.[this.potionKind] ?? 0;
        if (!nearOrSame(st.map, previewPlan(st, u, this.plans[u.id]).end, allyAtHit)) this.toast(T.err.notTarget);
        else if (have <= 0) this.toast(T.shop.noItem(it.name));
        else if (this.reservedItems(this.potionKind) >= have) this.toast(T.shop.reserved(it.name));
        else ok = this.append(u, { type: 'item', item: this.potionKind, target: ally.id });
      }
      else if (m === 'revive' && ally && ally.down) ok = this.append(u, { type: 'spell', spell: 'revive', target: ally.id });
      else if ((m === 'fireball' || m === 'smite') && st.explored[tile.y * st.map.w + tile.x]) ok = this.append(u, { type: 'spell', spell: m, tile });
      else if (m === 'trip' && foe) ok = this.append(u, { type: 'spell', spell: 'trip', target: foe.id });
      else if (m === 'power' && foe) {
        // 押し返す予約をした敵は、押された先の位置で届くかを見る
        const end = previewPlan(st, u, this.plans[u.id]).end;
        const foeAtHit = unitsAtHit.find((x) => x.id === foe.id) ?? foe;
        if (inReach(st.map, u, end, foeAtHit, unitsAtHit)) ok = this.append(u, { type: 'attack', target: foe.id, power: true });
        else this.toast(T.err.powerReach);
      }
      else this.toast(T.err.notTarget);
      if (ok) this.timelineTick = null;
      // 予約できたら同じキャラは既定のモードに戻す(AP を使い切って次のキャラに移った場合はそのキャラの既定のまま)
      if (ok && this.selected === u.id) this.mode = this.defaultMode(u.id);
      this.changed();
      return;
    }

    // 移動モード: 味方なら選択、敵なら攻撃(重装ユニットで押し返せる小型敵のマスなら、移動での突破も選べるよう隣接時は押し込み移動)、床なら経路を予約
    if (ally && !ally.down && ally.id !== this.selected && !foe) return this.select(ally.id);
    if (!u || u.down) return;
    if (foe) {
      if (carryingAfter(u, this.plans[u.id])) return this.toast(T.err.carrying);
      // 移動モードで、重装ユニット(戦士)が上下左右の隣の小型敵をタップしたときは、そのマスへ踏み込んで押し返す移動を予約する。
      // 敵の後ろが壁や別のユニットで押せないときは、攻撃にする
      const plan = this.plans[u.id];
      const fromNow = previewPlan(st, u, plan).end;
      const unitsNow = unitsAtTick(st, this.plans, planCost(plan) + shoveDelay(st, u, plan));
      const foeNow = unitsNow.find((x) => x.id === foe.id) ?? foe;
      const dir = canShove(u, foe) ? dirBetween(fromNow, foeNow) : null;
      if (dir && this.apFor(u) >= 1 && typeof canStepPreview(st.map, unitsNow, u, fromNow, foeNow) === 'object') {
        this.timelineTick = null;
        plan.push({ type: 'move', dir, stop: true });
        this.changed();
        this.advanceIfFull(u);
        return;
      }
      this.attackOrCharge(u, foe, true);
      return;
    }
    if (!st.explored[tile.y * st.map.w + tile.x]) return this.toast(T.err.noPath);
    const list = this.plans[u.id];
    const from = previewPlan(st, u, list).end;
    // 階段を行き先に選んだら、着いたターンの終わりに階段を使う(通り過ぎるだけなら使わない)
    const stairs = stairsDest(st, tile) !== null && !list.some((a) => a.type === 'stairs');
    // 押し返せない敵のマスは避けて経路を引く(戦士が小型敵を押し返して奥の床をタップしたときは直進できるようにする)
    const blockedByFoe = (p: Pos) =>
      st.units.some((o) => o.side !== u.side && !o.down && !isNeutral(o) && o.x === p.x && o.y === p.y && !canShove(u, o));
    const path = pathTo(st.map, from, tile, blockedByFoe) ?? pathTo(st.map, from, tile);
    if (path && path.length === 0 && stairs) {
      list.push({ type: 'stairs' });
      this.changed();
      return;
    }
    if (!path || path.length === 0) return this.toast(T.err.noPath);
    // 担いでいる間は 1 マス 2 AP
    const slow = carryingAfter(u, list);
    const room = Math.floor(this.apFor(u) / (slow ? RULES.carryMoveCost : 1));
    if (room <= 0) return this.toast(T.err.noAp);
    this.timelineTick = null;
    for (const d of path.slice(0, room)) {
      list.push({ type: 'move', dir: d, stop: true, slow: slow || undefined });
    }
    if (stairs) {
      if (path.length <= room) list.push({ type: 'stairs' });
      else this.toast(T.toast.stairsLater);
    }
    this.changed();
    this.advanceIfFull(u);
  }

  /**
   * 予定位置から届くなら攻撃、届かなければ接近攻撃(残り AP 全部)を予約する。
   * - 判定には、その攻撃が発動するティックにおける味方の予定位置(unitsAtTick)を使う(前の味方がどく予約済みなら射線が通る)。
   * - 攻撃モード(fromMoveMode=false)で、遠隔の射程・壁は通るが味方が射線上にいる場合は、勝手に接近攻撃へ変えず、
   *   その場での射撃を予約して「発射時に味方が射線上にいる見込み」と知らせる(移動モードでのタップ時は接近攻撃にする)。
   */
  private attackOrCharge(u: Unit, foe: Unit, fromMoveMode = false): boolean {
    const st = this.state;
    const plan = this.plans[u.id];
    const end = previewPlan(st, u, plan).end;
    const hitTick = Math.min(8, planCost(plan) + shoveDelay(st, u, plan) + RULES.attackCost);
    const unitsAtHit = unitsAtTick(st, this.plans, hitTick);
    // 押し返す予約をした敵は、押された先の位置で届くかを見る
    const foeAtHit = unitsAtHit.find((x) => x.id === foe.id) ?? foe;
    const why = reachProblem(st.map, u, end, foeAtHit, unitsAtHit);
    if (!why) return this.append(u, { type: 'attack', target: foe.id });
    if (!fromMoveMode && stats(u).range > 1 && why === REACH.ally) {
      const ok = this.append(u, { type: 'attack', target: foe.id });
      if (ok) this.toast(T.err.allyInLine(hitTick));
      return ok;
    }
    const ap = this.apFor(u);
    // 接近攻撃で AP を使い切っても、次のキャラへは移らない(続けたタップが別のキャラに入らないように)
    const ok = this.append(u, { type: 'charge', target: foe.id, ticks: ap }, false);
    if (ok) {
      const route = chargeRoute(st.map, u, end, foeAtHit, unitsAtHit);
      this.toast(T.err.toCharge(why, ap, route ? route.length - 1 : null, RULES.attackCost).trim());
    }
    return ok;
  }

  /** AP を使い切ったら次の味方を選択する */
  private advanceIfFull(u: Unit): void {
    if (this.apFor(u) > 0) return;
    const next = this.party().find((p) => !p.down && this.apFor(p) > 0);
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

/** 対象を選ぶモード(届くマスを盤面に出す) */
const TARGET_MODES = new Set<Mode>(['attack', 'power', 'trip', 'fireball', 'smite', 'heal', 'revive', 'carry', 'potion']);

/** 履歴に残すターン数 */
const HISTORY_TURNS = 30;

/** 全員休憩でまとめて処理する最大ターン数 */
const REST_TURNS = 20;

/** 倒れた敵を描き続けるターン数(倒れたターンの後、このターン数がたつと消す) */
const CORPSE_TURNS = 3;

/** 倒れた敵の描画を消すか(turn=表示しているターン) */
function corpseGone(u: Unit, turn: number): boolean {
  return u.side === 'enemy' && u.down && turn - (u.downTurn ?? -Infinity) > CORPSE_TURNS;
}

/** 結果の要約の一覧(1 行ずつ。長い行は省略し、全部は履歴の画面で見る) */
function summaryList(lines: string[]): string {
  const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<ul class="log summary">${lines.map((l) => `<li title="${esc(l)}">${esc(l)}</li>`).join('')}</ul>`;
}

/** 選んでいるキャラの HP・MP(現在値/最大値) */
function vitals(u: Unit): string {
  const d = stats(u);
  return `<span class="vitals">HP ${u.hp}/${d.maxHp}${d.maxMp > 0 ? ` MP ${u.mp}/${d.maxMp}` : ''}</span>`;
}

function planMarks(st: GameState, u: Unit, actions: Action[], color: string): Mark[] {
  const marks: Mark[] = [];
  const { path, end, pushes } = previewPlan(st, u, actions);
  const icon = stats(u).icon;
  if (path.length > 1) {
    marks.push({ kind: 'path', points: path, color });
    marks.push({ kind: 'ghost', at: end, icon });
  }
  // 押し返す敵: 今の位置に「押」の札、押された先に薄い姿を出す。攻撃の線は押された先へ引く
  const pushedTo = new Map<string, Pos>();
  for (const p of pushes) {
    const foe = st.units.find((x) => x.id === p.id);
    if (!foe) continue;
    if (!pushedTo.has(p.id)) marks.push({ kind: 'tag', at: foe, text: '押', color: '#ffb040' });
    marks.push({ kind: 'ghost', at: p.to, icon: stats(foe).icon });
    pushedTo.set(p.id, p.to);
  }
  const find = (id: string) => {
    const x = st.units.find((o) => o.id === id);
    const to = pushedTo.get(id);
    return x && to ? { ...x, ...to } : x;
  };
  for (const a of actions) {
    if (a.type === 'attack' || (a.type === 'spell' && a.spell === 'trip')) {
      const t = find(a.target!);
      if (t) {
        marks.push({ kind: 'target', at: t, color: '#ff5050' });
        marks.push({ kind: 'link', from: end, to: t, color: '#ff505099' });
      }
    } else if (a.type === 'spell') {
      if (a.tile) {
        // 見えないマスを狙った火球は、ずれて届きうる範囲も薄く出す
        if (a.spell === 'fireball' && !hasLos(st.map, end, a.tile)) {
          marks.push({ kind: 'area', at: a.tile, radius: SPELLS[a.spell].radius + RULES.fireballScatter, color: 'rgba(255,120,30,0.12)' });
        }
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
        // 経路の目安(予約の時点の位置で求める。実行時に相手が動けば変わる)。行けなければ相手への直線
        const route = chargeRoute(st.map, u, end, t, st.units);
        if (route && route.length > 1) marks.push({ kind: 'path', points: route, color: '#ff5050', dashed: true });
        marks.push({ kind: 'path', points: [route?.at(-1) ?? end, t], color: '#ff505099', dashed: true });
      }
    } else if (a.type === 'carry') {
      const t = find(a.target);
      if (t) marks.push({ kind: 'target', at: t, color: '#60d0ff' });
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
  const def: Settings = { hints: true, pointers: true, debugPlans: false, noFog: false, formation: null };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const s: Settings = raw ? { ...def, ...JSON.parse(raw), debugPlans: false, noFog: false } : def;
    const f: unknown = s.formation;
    if (!Array.isArray(f) || !f.every((id) => typeof id === 'string')) s.formation = null;
    return s;
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
