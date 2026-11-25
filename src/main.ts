import './style.css';
import type { Difficulty } from './core/types';
import { Controller, randomSeed } from './ui/controller';
import { loadGame } from './ui/save';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const controller = new Controller({
  canvas: $('#canvas'),
  panel: $('#panel'),
  topbar: $('#topbar'),
  overlay: $('#overlay'),
  toast: $('#toast'),
});

// 開発時のみ、ブラウザからの自動検証用に公開する
if (import.meta.env.DEV) (window as unknown as { __sg: Controller }).__sg = controller;

// 自動保存があれば続きから再開する(無ければメインメニュー)。
// ?seed=数&diff=easy|normal|hard(&floor=0〜5。0 は地上)で直接始める(保存と同じシード・難易度なら続きから)。diff が無ければ難易度選択を出す
const params = new URLSearchParams(location.search);
const seed = params.get('seed') ? Number(params.get('seed')) : randomSeed();
const diff = params.get('diff') as Difficulty | null;
const saved = loadGame();
// ?scenario=ID で固定遭遇から始める(自動保存とは関係なく、毎回最初から)
const scenario = params.get('scenario');
// ?minigame=ID(&stage=N)でミニゲームのステージから始める(持ち越しなし。毎回最初から)
const minigame = params.get('minigame');
// ?tutorial=1(または ?tutorial=レッスンID)でチュートリアルのレッスンから始める
const tutorial = params.get('tutorial');
const sameGame = saved && (!params.get('seed') || (saved.seed === seed && (saved.difficulty ?? 'normal') === diff));
if (scenario && controller.startEncounter(scenario)) {
  // 固定遭遇を始めた
} else if (tutorial && controller.startTutorial(tutorial === '1' ? undefined : tutorial)) {
  // レッスンを始めた
} else if (minigame && controller.startMinigame(minigame, Number(params.get('stage') ?? 0) || 0)) {
  // ミニゲームを始めた
} else if (saved && sameGame) {
  controller.resume(saved);
} else if (diff === 'easy' || diff === 'normal' || diff === 'hard') {
  // &floor=N で途中の階から始める(バランス確認用。レベルもその階に合わせる)
  controller.start(seed, diff, true, Number(params.get('floor') ?? 0) || 0);
} else {
  controller.start(seed, 'normal', false);
  controller.showMenu(seed);
}
