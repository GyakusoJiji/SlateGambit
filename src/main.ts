import './style.css';
import type { Difficulty } from './core/types';
import { Controller, randomSeed } from './ui/controller';

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

// ?seed=数&diff=easy|normal|hard で直接始める。diff が無ければ難易度選択を出す
const params = new URLSearchParams(location.search);
const seed = params.get('seed') ? Number(params.get('seed')) : randomSeed();
const diff = params.get('diff') as Difficulty | null;
if (diff === 'easy' || diff === 'normal' || diff === 'hard') {
  controller.start(seed, diff);
} else {
  controller.start(seed, 'normal');
  controller.showStart(seed);
}
