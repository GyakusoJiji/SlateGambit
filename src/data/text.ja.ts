// 画面に表示する文言。多言語化する場合はこのファイルを差し替える。

export const T = {
  title: 'Slate Gambit',
  turn: (n: number) => `ターン ${n}`,
  ap: 'AP',
  hp: 'HP',
  mp: 'MP',
  down: '気絶',

  act: {
    move: '移動',
    attack: '攻撃',
    guard: '防御',
    wait: '待機',
    fireball: '火球',
    heal: '回復',
    revive: '蘇生',
    overwatch: '警戒射撃',
    intercept: '迎撃',
    follow: '追尾',
    escort: '護衛',
    stop: '発見で停止',
    undo: '1手戻す',
    clear: '全消し',
    execute: '実行',
  },

  prompt: {
    move: '移動先のマスをタップ(敵をタップで攻撃)',
    attack: '攻撃する敵をタップ',
    fireball: '火球を撃ち込むマスをタップ(範囲 3×3・味方も巻き込む)',
    heal: '回復する味方をタップ',
    revive: '蘇生する気絶した味方をタップ',
    follow: '追いかける敵をタップ',
    escort: '付き添う味方をタップ',
    playing: '同時解決を再生中',
    selectUnit: '味方をタップして選択',
  },

  play: {
    pause: '一時停止',
    resume: '再生',
    step: 'コマ送り',
    skip: 'スキップ',
    replay: 'もう一度見る',
    speed: (n: number) => `×${n}`,
    tick: (t: number, n: number) => `ティック ${t}/${n}`,
  },

  settings: {
    title: '設定',
    hints: '敵の予兆を表示する',
    debugPlans: '[デバッグ] 敵の計画をすべて表示',
    debugNoFog: '[デバッグ] 視界制限を解除',
    seed: 'シード',
    newGame: '新しいゲーム',
    close: '閉じる',
  },

  result: {
    won: '勝利! 敵を全滅させた',
    lost: '全滅した…',
  },

  log: {
    attack: (a: string, b: string, n: number, guarded: boolean) => `${a} → ${b} に ${n} ダメージ${guarded ? '(防御)' : ''}`,
    heal: (b: string, n: number) => `${b} が ${n} 回復`,
    down: (a: string) => `${a} が倒れた`,
    revive: (a: string) => `${a} が起き上がった`,
    fizzle: (a: string, why: string) => `${a} の行動は不発(${why})`,
    halt: (a: string) => `${a} は敵を見つけて立ち止まった`,
    reaction: (a: string) => `${a} の条件付き行動が発動!`,
    bump: (a: string) => `${a} は進めなかった`,
  },

  err: {
    noAp: 'AP が足りない',
    noPath: 'そこへは行けない',
    notTarget: 'そこには対象がいない',
  },
};
