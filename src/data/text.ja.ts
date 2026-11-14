// 画面に表示する文言。多言語化する場合はこのファイルを差し替える。

export const T = {
  title: 'Slate Gambit',
  turn: (n: number) => `ターン ${n}`,
  ap: 'AP',
  hp: 'HP',
  mp: 'MP',
  down: '気絶',
  /** 予約の残り AP の扱い(戦闘中は防御、非戦闘中は待機) */
  restFill: (filler: string, n: number, all: boolean) => (all ? `予約なし(${filler})` : `残り ${filler}×${n}`),

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
    rest: '休憩',
  },

  /** 行動ボタンにマウスを乗せたときの 1 行説明 */
  desc: {
    idle: 'ボタンにマウスを乗せると説明を表示',
    move: '移動 1AP/マス: 行き先をタップ。キャラのいるマスも通れるが、止まれない',
    attack: '攻撃 3AP: 敵を指定。2ティック構えて3ティック目に撃つ。離れられると不発',
    guard: '防御 1AP: そのティックに受けるダメージ半減。休憩にはならない',
    wait: '待機 1AP: 何もしない。敵が見えず全員が待機だけなら休憩になる',
    fireball: '火球 3AP: マスを指定。3ティック目に 3×3 を爆破。味方も巻き込む',
    heal: '回復 3AP: 味方を指定。3ティック目に HP を回復(射程 4・射線が必要)',
    revive: '蘇生 3AP: 隣の気絶した味方を指定。3ティック目に起き上がらせる',
    overwatch: '警戒射撃 残りAP全部: 射程と射線に入った敵を即座に撃つ。味方越しは撃たない',
    intercept: '迎撃 残りAP全部: その場で構え、上下左右に来た敵を即座に攻撃',
    follow: '追尾 残りAP全部: 敵を指定し、その隣へ追いかける。攻撃はしない',
    escort: '護衛 残りAP全部: 味方を指定し、その隣を保ってついていく',
    stop: '発見で停止(切替): 移動中に新しい敵を見たら、残りの移動を防御に変える',
    undo: '選択中の味方の最後の予約を取り消す',
    clear: '選択中の味方の予約をすべて取り消す',
    rest: '全員の予約を消して待機し、HP と MP を少し回復する',
    execute: '敵味方の予約を 8 ティックで同時に解決する(リターンキーでも実行)',
  } as Record<string, string>,

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
    rest: (a: string, hp: number, mp: number) => `${a} は休憩した(HP+${hp}${mp > 0 ? ` MP+${mp}` : ''})`,
  },

  err: {
    noAp: 'AP が足りない',
    cannotRest: '敵が見えている間は休憩できない',
    noPath: 'そこへは行けない',
    notTarget: 'そこには対象がいない',
  },
};
