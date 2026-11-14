import './style.css';
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

const param =new URLSearchParams(location.search).get('seed');
controller.start(param ? Number(param) : randomSeed());
