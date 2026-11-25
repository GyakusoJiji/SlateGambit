// 画面に表示する文言。多言語化する場合はこのファイルを差し替える。

export const T = {
  title: 'Slate Gambit',
  turn: (n: number) => `ターン ${n}`,
  /** 上部バー用の短い表示 */
  turnShort: (n: number) => `T${n}`,
  floor: (n: number) => (n <= 0 ? '地上' : `B${n}F`),
  floorLong: (n: number) => (n <= 0 ? '地上の町' : `地下 ${n} 階`),
  gold: (n: number) => `${n.toLocaleString()} G`,
  level: (n: number) => `Lv${n}`,
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
    stairs: '階段を使う',
    undo: '1手戻す',
    execute: '実行',
    rest: '全員休憩',
    group: '全員移動',
    watch: '迎撃',
  },

  /** 行動ボタンにマウスを乗せたときの 1 行説明 */
  desc: {
    move: '1AP/マス(上下左右のみ)。味方は通り抜けられるが重なって止まれない',
    attack: '3AP。近接は斜めを含む隣の敵に届く。届かない敵を選ぶと近づいて攻撃(残りAP全部)',
    carry: '1AP。隣(斜めも可)の気絶した味方を担ぐ。移動 2AP/マス',
    potion: '2AP。自分か隣の味方に回復薬を使う(HP 薬は HP+25、MP 薬は MP+8)。もう一度押すと HP 薬と MP 薬を切り替える',
    drop: '1AP。担いでいる味方をその場に降ろす',
    fireball: '3AP。マス指定、3×3 を爆破。味方も巻き込む。見えないマスにも撃てるが、着弾点が最大 1 マスずれる',
    smite: '3AP。マス指定、3×3 の敵だけに光を落とす(味方は巻き込まない)',
    trip: '3AP。敵 1 体の足を払い、その次の 2 ティックは何もできなくする(ダメージなし。構えも中断)',
    cover: '3AP。3 ティック防御し、隣の味方への単体攻撃を代わりに受ける(範囲魔法は防げない)',
    power: '5AP。敵 1 体に 2 倍のダメージ。届く位置からだけ使える',
    heal: '3AP。味方の HP を回復(射程 4)',
    revive: '3AP。隣の気絶した味方を起こす',
    undo: '最後の予約を取り消す(長押しで全部)',
    guard: '1AP。そのティックの被ダメージ半減。HP は回復しない',
    wait: '1AP。休んだ分だけ HP・MP が回復(戦闘中は半分)。休んで回復したターンは食料を 1 つ使い、食料が無いと回復しない。被ダメージは減らない',
    watch: '残りAP全部。近接は隣の敵を攻撃(迎撃)、遠隔は射線に入った敵を撃つ(警戒射撃)',
    rest: '全快するまで休憩を続ける(1 ターンごとに食料を 1 つ使い、HP 20%・MP 2 回復。敵が見えている間は半分)。敵が近づいてくる様子は再生して見せる。攻撃を受ける・敵が隣に来る・食料が尽きるとやめる',
    group: '敵がいない間、行き先をタップすると全員が隊列で自動で向かう',
    execute: '全員の予約を同時に解決(リターンキー可)',
  } as Record<string, string>,

  prompt: {
    move: '移動先のマスをタップ(敵をタップで攻撃)',
    attack: '攻撃する敵をタップ(届かなければ近づいて攻撃)',
    carry: '担ぐ気絶した味方(隣のマス)をタップ',
    potion: '回復薬を使う味方(自分か隣)をタップ。ボタンをもう一度押すと薬の種類を切り替える',
    fireball: '撃ち込むマスをタップ(3×3・味方も巻き込む。薄い橙のマスは見えないので最大 1 マスずれる)',
    smite: '光を落とすマスをタップ(3×3・敵だけに当たる)',
    trip: '足を払う敵をタップ',
    power: '強攻撃する敵をタップ(届く位置の敵だけ)',
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
    wonTreasure: '勝利! 秘宝を地上へ持ち帰った',
    wonEscape: '勝利! 戦士を連れ出した',
    retry: 'もう一度',
    lost: '全滅した…',
    summary: (deepest: number, gold: string) => `最も深く潜った階: 地下 ${deepest} 階 · 手に入れたゴールド: ${gold}`,
  },

  log: {
    attack: (a: string, b: string, n: number, guarded: boolean) => `${a} → ${b} に ${n} ダメージ${guarded ? '(防御)' : ''}`,
    heal: (b: string, n: number) => `${b} が ${n} 回復`,
    healMp: (b: string, n: number) => `${b} の MP が ${n} 回復`,
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
    treasureGot: (a: string) => `${a} が秘宝を手に入れた! 地下 1 階の入口へ戻ろう`,
    treasureDrop: (a: string) => `${a} が秘宝を落とした`,
    awaken: (a: string) => `${a} が目を覚ました!`,
    flank: '(挟み撃ち)',
    cover: (a: string, b: string) => `${a} が ${b} をかばった`,
    stun: (a: string) => `${a} は足を払われて動けない`,
    interrupt: (a: string, spell?: string) => `${a} の${spell ? `${spell}の詠唱` : '構え'}が止まった!`,
    wander: '遠くから物音が近づいてくる…',
    alarm: (a: string, n: number) => `${a} が角笛を吹き鳴らした! 増援が ${n} 体やってくる`,
    bounty: (a: string, gold: number) => `${a} を止めた。持っていた宝 +${gold} G`,
    chest: (a: string, gold: number) => `${a} が宝箱を開けた(+${gold} G)`,
    loot: (gold: number) => `倒した敵から +${gold} G を手に入れた`,
    steal: (a: string, gold: number) => `${a} に ${gold} G 盗まれた! 逃げられる前に倒せば取り返せる`,
    recover: (a: string, gold: number) => `${a} から盗まれた ${gold} G を取り返した`,
    escape: (a: string, gold: number) => `${a} に逃げ切られた(${gold} G は戻らない)`,
    dry: '回復の泉が枯れてしまった(地上から潜り直すと戻る)',
    noFood: '食料が無いので、休んでも回復しなかった',
    exp: (n: number) => `全員が経験値 ${n} を得た`,
    levelup: (a: string, lv: number) => `${a} はレベル ${lv} に上がった!`,
    levelupAll: (lv: number) => `全員がレベル ${lv} に上がった!`,
    stairs: (from: number, to: number) => (to <= 0 ? '地上の町へ戻った' : to > from ? `地下 ${to} 階へ降りた` : `地下 ${to} 階へ上った`),
    noHit: (a: string, spell: string) => `${a} の${spell}は誰にも当たらなかった`,
    scatter: (a: string) => `${a} の火球は狙いが逸れた(見えないマスを狙った)`,
  },

  /** ターン後の結果の要約(味方ごとに 1 行) */
  sum: {
    kind: {
      melee: '攻撃',
      ranged: '射撃',
      fireball: '火球',
      smite: '聖光',
      breath: '炎のブレス',
      heal: '回復',
      revive: '蘇生',
      trip: '足払い',
      hellfire: '業火',
      potion: '薬',
    } as Record<string, string>,
    interrupted: (spell?: string) => `(${spell ? `${spell}の詠唱` : '構え'}を止めた)`,
    hit: (b: string, n: number, killed: boolean) => `${b}に ${n}${killed ? '(撃破)' : ''}`,
    missed: (label: string) => `${label}: 外れた`,
    area: (label: string, foes: number, total: number, kills: number, allies: number) =>
      `${label}: 命中 ${foes} 体${foes > 0 ? `(計 ${total}${kills > 0 ? `・撃破 ${kills}` : ''})` : ''}${allies > 0 ? `・味方 ${allies} 人を巻き込んだ` : ''}`,
    fizzle: (why: string) => `不発(${why})`,
    cover: (b: string) => `${b}をかばった`,
    halt: '敵を見て停止',
    carry: (b: string) => `${b}を担いだ`,
    taken: (n: number) => `被ダメ ${n}`,
    down: '気絶!',
    revived: '起き上がった',
    rest: (s: string) => `休憩 ${s}`,
    moved: '移動',
    idle: '待機',
  },

  timeline: {
    tickTitle: (t: number) => `${t} ティック目の終わりの予定位置を盤面に出す`,
  },

  /** 地上の施設 */
  facility: {
    inn: {
      name: '宿',
      note: '泊まると、立っている全員の HP と MP が全快する(気絶している味方は療養所へ)。宿代はレベルの合計で決まる',
      use: (cost: number) => `泊まる(${cost} G)`,
      done: '宿に泊まった。全員の HP と MP が全快した',
    },
    stable: {
      name: '馬小屋',
      note: '無料で休める。HP は半分までしか戻らず、MP は回復しない',
      use: (pct: number) => `休む(無料・HP ${pct}% まで)`,
      done: '馬小屋で休んだ',
      nothing: 'これ以上は馬小屋では回復しない',
    },
    shop: {
      name: '道具屋',
      note: '食料(休憩 1 ターンに 1 つ使う)と回復薬を買える。持ち物はパーティ共通',
    },
    clinic: {
      name: '療養所',
      note: '気絶した味方を復帰させ、HP と MP を全快する。費用はその味方のレベルで決まる',
      use: (cost: number) => `治療する(${cost} G)`,
      none: '気絶している味方はいない',
      done: (name: string) => `${name} が療養所で復帰した`,
    },
  },

  shop: {
    gold: (g: number) => `所持金 ${g} G`,
    have: (n: number) => `持っている数 ${n}`,
    buy: (name: string, price: number) => `${name}を買う(${price} G)`,
    noItem: (name: string) => `${name}を持っていない(地上の道具屋で買える)`,
    reserved: (name: string) => `${name}は予約済みの分で足りなくなる`,
  },

  perk: {
    title: (name: string, lv: number) => `${name}(Lv ${lv})の成長を 1 つ選んでください`,
    note: '選んだ成長はこのゲームの間ずっと続く(後から変えられない)',
  },

  history: {
    title: '履歴',
    turn: (n: number) => `ターン ${n}`,
    empty: 'まだ何も起きていない',
    summary: '要約',
    detail: '経過',
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
    boss: 'どの難易度でも、地下 5 階の最も奥でボスのドラゴンが秘宝を守っている',
  } as Record<string, string>,

  objective: {
    annihilate: '敵を全滅させる',
    treasure: '地下 5 階の秘宝を見つけ、地下 1 階の入口の階段まで持ち帰る',
    escape: '気絶した戦士を、出口の階段まで連れ出す(担ぐか蘇生する)',
  } as Record<string, string>,
  /** トップバー用の短い表示 */
  objectiveShort: {
    annihilate: '敵を全滅',
    treasure: '秘宝を探す',
    treasureHeld: '秘宝を地上へ!',
    escape: '戦士を出口へ',
  } as Record<string, string>,

  start: {
    title: '難易度を選んでください',
    encounters: '固定遭遇(同じ部屋で作戦を試す。Lv 3・保存しない)',
    note: '地下 5 階まであるダンジョンは毎回ランダムに作られます。階段を行き先に選んで誰か 1 人が着くと、全員で別の階へ移ります(通り過ぎるだけなら移りません)。宝箱でゴールドを集め、敵を倒して経験値をためるとレベルが上がります',
  },

  /** 持ち物の欄 */
  inv: {
    relic: (name: string) => `秘宝: ${name}`,
  },

  toast: {
    overlap: '止まるマスが重なっている味方がいる(片方は押し戻される)',
    foundFoe: '敵を見つけたので止まった',
    arrived: '行き先に着いた',
    rested: '全員の回復が終わった',
    /** 全員休憩をまとめて処理した結果。why=止めた理由 */
    restDone: (turns: number, why: string) => `${turns} ターン休憩した。${why}`,
    restHurt: '攻撃を受けたので休憩をやめた',
    restNoFood: '食料が尽きたので休憩をやめた(食料は店で買える)',
    restFoeNear: '敵がすぐそばまで来たので休憩をやめた',
    restLimit: 'まだ回復しきっていない(もう一度押すと続ける)',
    resumed: (turn: number) => `前回の続き(ターン ${turn})から再開した`,
    stopped: '自動の操作を止めた',
    cleared: '予約をすべて取り消した',
    stairsLater: '階段に着くのは次のターン以降。着いたらもう一度階段をタップ',
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
    stairs: '上り階段',
    surface: '地上へ',
    down: '下り階段',
    treasure: '秘宝',
    party: '味方',
    rescue: (name: string) => `救出: ${name}`,
  },

  err: {
    noAp: 'AP が足りない',
    cannotRest: '敵が見えている間は休憩できない',
    cannotGroup: '敵が見えている間は全員移動できない',
    noPath: 'そこへは行けない',
    notTarget: 'そこには対象がいない',
    carrying: '担いでいる間は攻撃できない',
    powerReach: '強攻撃は、予定位置から届く敵にしか使えない',
    /** 攻撃が届かず接近攻撃にしたときの通知。steps=経路の目安のマス数(行けなければ null) */
    toCharge: (why: string, ap: number, steps: number | null, attackCost: number) =>
      `${why}ので、近づいて攻撃する(残り ${ap}AP 全部)
` +
      (steps === null ? '今は近づける道がない(相手が動けば変わる)' : steps === 0 ? '' : `目安: ${steps} マス進んでから攻撃` + (steps + attackCost > ap ? '(このターンには届かない見込み)' : '')),
  },
};
