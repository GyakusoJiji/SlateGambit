// 画面に表示する文言。多言語化する場合はこのファイルを差し替える。

export const T = {
  title: 'Slate Gambit',
  turn: (n: number) => `ターン ${n}`,
  /** 上部バー用の短い表示 */
  turnShort: (n: number) => `T${n}`,
  ap: 'AP',
  hp: 'HP',
  mp: 'MP',
  down: '気絶',
  /** 予約の残り AP の扱い(敵が見えていれば防御、見えなければ休憩) */
  restFill: (filler: string, n: number, all: boolean) => (all ? `予約なし(${filler})` : `残り ${filler}×${n}`),

  act: {
    move: '移動',
    attack: '攻撃',
    guard: '防御',
    wait: '休憩',
    fireball: '火球',
    heal: '回復',
    revive: '蘇生',
    overwatch: '警戒射撃',
    intercept: '迎撃',
    charge: '接近攻撃',
    carry: '担ぐ',
    drop: '降ろす',
    undo: '1手戻す',
    execute: '実行',
    rest: '全員休憩',
    group: '全員移動',
    watch: '見張り',
  },

  /** 行動ボタンにマウスを乗せたときの 1 行説明 */
  desc: {
    move: '1AP/マス(上下左右のみ)。味方は通り抜けられるが重なって止まれない',
    attack: '3AP。近接は斜めを含む隣の敵に届く。届かない敵を選ぶと近づいて攻撃(残りAP全部)',
    carry: '1AP。隣(斜めも可)の気絶した味方を担ぐ。移動 2AP/マス',
    drop: '1AP。担いでいる味方をその場に降ろす',
    fireball: '3AP。マス指定、3×3 を爆破。味方も巻き込む',
    heal: '3AP。味方の HP を回復(射程 4)',
    revive: '3AP。隣の気絶した味方を起こす',
    undo: '最後の予約を取り消す(長押しで全部)',
    guard: '1AP。そのティックの被ダメージ半減。HP は回復しない',
    wait: '1AP。休んだ分だけ HP・MP が回復(戦闘中は半分)。被ダメージは減らない',
    watch: '残りAP全部。近接は隣の敵を攻撃(迎撃)、遠隔は射線に入った敵を撃つ(警戒射撃)',
    rest: '全快するか敵が見えるまで休憩を続ける(1 ターンで HP 20%・MP 2 回復)',
    group: '敵がいない間、行き先をタップすると全員が隊列で自動で向かう',
    execute: '全員の予約を同時に解決(リターンキー可)',
  } as Record<string, string>,

  prompt: {
    move: '移動先のマスをタップ(敵をタップで攻撃)',
    attack: '攻撃する敵をタップ(届かなければ近づいて攻撃)',
    carry: '担ぐ気絶した味方(隣のマス)をタップ',
    fireball: '撃ち込むマスをタップ(3×3・味方も巻き込む)',
    heal: '回復する味方をタップ',
    revive: '蘇生する気絶した味方をタップ',
    group: '全員で向かう行き先をタップ(選んでいるキャラが先頭、残りは隊列の順。敵を見たら止まる)',
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
    wonTreasure: '勝利! 宝を持ち帰った',
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
    /** 休憩した全員分を 1 行にまとめる */
    rest: (parts: string) => `休憩: ${parts}`,
    /** 1 人分(回復が 0 の項目は書かない。両方 0 なら空) */
    restPart: (a: string, hp: number, mp: number) =>
      hp > 0 || mp > 0 ? `${a} ${[hp > 0 ? `HP+${hp}` : '', mp > 0 ? `MP+${mp}` : ''].filter(Boolean).join(' ')}` : '',
    carry: (a: string, b: string) => `${a} が ${b} を担いだ`,
    drop: (a: string, b: string) => `${a} が ${b} を降ろした`,
    wake: (a: string) => `${a} は担がれている間に意識を取り戻した`,
    spring: (a: string, revived: boolean) => (revived ? `${a} は泉の力で起き上がった` : `${a} は泉で全回復した`),
    treasureGot: (a: string) => `${a} が宝を手に入れた! 入口の階段へ戻ろう`,
    treasureDrop: (a: string) => `${a} が宝を落とした`,
    awaken: (a: string) => `${a} が目を覚ました!`,
  },

  difficulty: {
    easy: 'Easy',
    normal: 'Normal',
    hard: 'Hard',
  } as Record<string, string>,
  difficultyDesc: {
    easy: '敵が少なめ。まずはここから',
    normal: '敵が多く、オーガも出る',
    hard: '大部屋に敵が固まり、オーガが 2 体まで出る',
    boss: 'どの難易度でも、最も奥の部屋にボスのドラゴンが待つ',
  } as Record<string, string>,

  objective: {
    annihilate: '敵を全滅させる',
    treasure: '宝を見つけて入口の階段に持ち帰る',
  } as Record<string, string>,
  /** トップバー用の短い表示 */
  objectiveShort: {
    annihilate: '敵を全滅',
    treasure: '宝探し',
    treasureHeld: '宝を階段へ!',
  } as Record<string, string>,

  start: {
    title: '難易度を選んでください',
    note: 'マップと目的(敵の全滅か宝探し)は毎回ランダムに決まります',
  },

  toast: {
    overlap: '止まるマスが重なっている味方がいる(片方は押し戻される)',
    foundFoe: '敵を見つけたので止まった',
    arrived: '行き先に着いた',
    rested: '全員の回復が終わった',
    resumed: (turn: number) => `前回の続き(ターン ${turn})から再開した`,
    stopped: '自動の操作を止めた',
    cleared: '予約をすべて取り消した',
  },

  formation: {
    title: '隊列(全員移動)',
    auto: '先頭に近い順(自動)',
    custom: '指定した順',
    up: '前へ',
    down: '後ろへ',
    note: '先頭は全員移動を始めたときに選んでいるキャラ。残りがこの順で後ろに並ぶ',
  },

  pointer: {
    stairs: '階段',
    treasure: '宝',
    party: '味方',
  },

  err: {
    noAp: 'AP が足りない',
    cannotRest: '敵が見えている間は休憩できない',
    cannotGroup: '敵が見えている間は全員移動できない',
    noPath: 'そこへは行けない',
    notTarget: 'そこには対象がいない',
    carrying: '担いでいる間は攻撃できない',
    toCharge:'届かないので、近づいて攻撃する(残りAP全部)',
  },
};
