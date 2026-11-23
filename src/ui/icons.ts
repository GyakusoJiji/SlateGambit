// 8×8 のドット絵風アイコン。画像素材に差し替える場合はこのファイルだけを置き換える。

interface Icon {
  palette: Record<string, string>;
  rows: string[];
}

const SKIN = '#f0c090';
const DARK = '#1c1c28';
const BOOT = '#5a3a20';
const WOOD = '#a0703a';

const ICONS: Record<string, Icon> = {
  warrior: {
    palette: { H: '#c8d0d8', K: DARK, F: SKIN, B: '#3a6ee8', S: '#eef0f8', L: BOOT },
    rows: ['..HHHH..', '.HHHHHH.', '.HKFFKH.', '..FFFF..', '.BBBBBBS', 'BBBBBBBS', '.BBBBB.S', '.LL..LL.'],
  },
  thief: {
    palette: { G: '#3fa34d', K: DARK, F: SKIN, W: WOOD, L: BOOT },
    rows: ['..GGGG..', '.GGGGGG.', '.GKFFKG.', '..FFFF.W', '.GGGGGW.', 'GGGGGGW.', '.GGGG..W', '.LL..LL.'],
  },
  mage: {
    palette: { P: '#9a5ff0', K: DARK, F: SKIN, T: WOOD },
    rows: ['...PP...', '..PPPP..', '.PPPPPP.', 'PPKFFKPP', '..FFFF.T', '.PPPPPPT', '.PPPPP.T', '.PPPPP.T'],
  },
  priest: {
    palette: { W: '#ecece4', K: DARK, F: SKIN, Y: '#e8c040' },
    rows: ['..WWWW..', '.WFFFFW.', '.WKFFKW.', '..FFFF..', '.WWYWWW.', 'WWYYYWWW', '.WWYWWW.', '.WWWWWW.'],
  },
  goblin: {
    palette: { G: '#6aa84f', E: '#3f7a2f', R: '#ff3b3b', K: DARK },
    rows: ['........', '.E....E.', '.GGGGGG.', '.GRGGRG.', '..GGGG..', '.GGGGGGK', '..GGGG.K', '..G..G..'],
  },
  archer: {
    palette: { W: '#ddd8c8', K: DARK, B: WOOD },
    rows: ['..WWWW..', '.WKWWKW.', '.WWWWWW.', '..WKKW..', '...WW..B', '.WWWWWBB', '..W..W.B', '.W....W.'],
  },
  orc: {
    palette: { O: '#7a8a3a', K: '#ff4040', T: '#f4f0e0', L: BOOT },
    rows: ['.OOOOOO.', 'OOKOOKOO', 'OOOOOOOO', 'OTOOOOTO', '.OOOOOO.', 'OOOOOOOO', 'OO.OO.OO', '.LL..LL.'],
  },
  ogre: {
    palette: { Q: '#b0603a', K: '#ffd040', T: '#f4f0e0' },
    rows: ['.QQQQQQ.', 'QQKQQKQQ', 'QQQQQQQQ', 'QQTTTTQQ', 'QQQQQQQQ', 'QQQQQQQQ', 'QQQ..QQQ', 'QQ....QQ'],
  },
  slime: {
    palette: { B: '#4a9ef0', W: '#c8e8ff', K: DARK },
    rows: ['........', '........', '...BB...', '..BWBB..', '.BKBBKB.', '.BBBBBB.', 'BBBBBBBB', '.BBBBBB.'],
  },
  bat: {
    palette: { B: '#6a5070', R: '#ff3b3b' },
    rows: ['........', 'B..BB..B', 'BB.BB.BB', 'BBBRRBBB', 'BBBBBBBB', '.B.BB.B.', '...BB...', '........'],
  },
  shaman: {
    palette: { P: '#8040b0', G: '#6aa84f', R: '#ffd040', W: WOOD, K: '#ff7a20' },
    rows: ['..PPP..K', '.PPPPP.W', '.GRGRG.W', '..GGGG.W', '.PPPPPPW', 'PPPPPP.W', '.PPPP..W', '..G..G..'],
  },
  warlock: {
    palette: { R: '#b02030', G: '#6aa84f', Y: '#ffd040', W: WOOD, K: '#ff4020' },
    rows: ['..RRR.KK', '.RRRRR.Y', '.GYGYG.W', '..GGGG.W', '.RRRRRRW', 'RRYRRR.W', '.RRRR..W', '..G..G..'],
  },
  darkelf: {
    palette: { D: '#6a5a8a', H: '#e8e8f0', K: '#ff5050', B: WOOD, C: '#2a2a40' },
    rows: ['..HHHH..', '.HDDDDH.', '.HKDDKH.', 'H.DDDD.B', '.CCCCCBB', 'CCCCCC.B', '.CCCC..B', '.C....C.'],
  },
  troll: {
    palette: { T: '#4a7a6a', K: '#ffd040', W: '#f4f0e0', L: BOOT },
    rows: ['..TTTT..', '.TKTTKT.', '.TTTTTT.', 'TTWTTWTT', 'TTTTTTTT', 'TTTTTTTT', '.TT..TT.', '.LL..LL.'],
  },
  // 倒した敵の跡(どの敵も共通)。高さ 3 ドットの平たい赤茶色の泥の水たまりで、水面の照り返しが少し見える
  puddle: {
    palette: { M: '#7a3e2c', D: '#52261a', H: '#b8887a' },
    rows: ['........', '........', '........', '........', '........', '..MMMM..', 'MMHHMMMM', '.MMMDMM.'],
  },
  dragon: {
    palette: { D: '#c8302c', W: '#7a1a40', K: '#ffe040', T: '#f4f0e0' },
    rows: ['.T....T.', '.DDDDDD.', 'DDKDDKDD', 'WDDTTDDW', 'WWDDDDWW', 'W.DDDD.W', '..DDDD..', '.DD..DD.'],
  },
};

const cache = new Map<string, HTMLCanvasElement>();

/** アイコンを 8×8 のオフスクリーン canvas として返す(拡大はドットを保ったまま行う) */
export function iconCanvas(name: string): HTMLCanvasElement {
  const hit = cache.get(name);
  if (hit) return hit;
  const icon = ICONS[name] ?? ICONS.goblin;
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const g = c.getContext('2d')!;
  icon.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const color = icon.palette[ch];
      if (!color) return;
      g.fillStyle = color;
      g.fillRect(x, y, 1, 1);
    });
  });
  cache.set(name, c);
  return c;
}

/** パネル用に data URL を返す */
export function iconUrl(name: string): string {
  return iconCanvas(name).toDataURL();
}
