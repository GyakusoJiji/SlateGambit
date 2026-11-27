// Canvas 2D による盤面描画。ゲーム状態は直接持たず、毎フレーム View を受け取って描く。
import type { Intent } from '../core/ai';
import { tileAt } from '../core/map';
import type { FloorMap, Pos, Side } from '../core/types';
import { iconCanvas } from './icons';

export interface DisplayUnit {
  id: string;
  icon: string;
  side: Side;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  down: boolean;
  guard: boolean;
  watch: boolean;
  selected: boolean;
  /** 気絶した味方を担いでいる */
  carrying?: boolean;
  /** 宝を持っている */
  treasure?: boolean;
  /** ティック連動プレビューの開始位置に残す薄い残像か */
  faint?: boolean;
}

export type Mark =
  | { kind: 'path'; points: Pos[]; color: string; dashed?: boolean }
  | { kind: 'ghost'; at: Pos; icon: string }
  | { kind: 'target'; at: Pos; color: string }
  | { kind: 'area'; at: Pos; radius: number; color: string }
  | { kind: 'link'; from: Pos; to: Pos; color: string };

export type Effect =
  | { kind: 'line'; from: Pos; to: Pos; color: string; alpha: number }
  | { kind: 'burst'; at: Pos; radius: number; color: string; alpha: number }
  | { kind: 'slash'; at: Pos; alpha: number }
  | { kind: 'text'; at: Pos; text: string; color: string; rise: number; alpha: number };

export interface View {
  map: FloorMap;
  explored: ArrayLike<number>;
  /** null の場合は全マスを視界内として描く */
  visible: ArrayLike<number> | null;
  units: DisplayUnit[];
  marks: Mark[];
  /** 敵の予兆。area は範囲魔法の着弾範囲と発動ティック、aim は狙っている味方への点滅ライン */
  hints: {
    at: Pos;
    intent: Intent;
    area?: { at: Pos; radius: number; tick?: number };
    aim?: { to: Pos; charge?: boolean; power?: boolean };
    label?: string;
  }[];
  /** 点滅演出の位相(0〜1) */
  pulse?: number;
  effects: Effect[];
  /** 床に置かれている宝の位置(宝探しのとき) */
  treasureAt?: Pos | null;
  /** 画面の外にあるときだけ、画面の端に矢印で方向を示す目印(階段・宝・味方) */
  pointers?: { at: Pos; color: string; label: string }[];
}

const COLORS = {
  bg: '#0b0b10',
  floor: '#2b2a35',
  floorDot: '#36354300',
  wall: '#5b5566',
  wallLine: '#433e4c',
  door: '#8a6030',
  stairs: '#c8b070',
  fogDim: 'rgba(5,5,10,0.6)',
  party: '#5ab0ff',
  enemy: '#ff5a5a',
};

/** 地上の施設のタイルの絵文字(宿・馬小屋・道具屋・療養所・銀行・教会) */
const FACILITY_ICON: Record<string, string> = { I: '🛏️', B: '🐴', T: '🧺', C: '⚕️', G: '🏦', A: '⛪' };

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  /** カメラ中心(マス単位) */
  cx = 0;
  cy = 0;
  /** 1 マスの画面上の大きさ(CSS px) */
  zoom = 30;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  /** 画面座標(canvas 内の CSS px)→ マス座標 */
  screenToTile(sx: number, sy: number): Pos {
    return {
      x: Math.floor((sx - this.cssW / 2) / this.zoom + this.cx + 0.5),
      y: Math.floor((sy - this.cssH / 2) / this.zoom + this.cy + 0.5),
    };
  }

  panBy(dxPx: number, dyPx: number): void {
    this.cx -= dxPx / this.zoom;
    this.cy -= dyPx / this.zoom;
  }

  zoomAt(factor: number, sx: number, sy: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.max(12, Math.min(72, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
  }

  centerOn(p: Pos): void {
    this.cx = p.x;
    this.cy = p.y;
  }

  private screenToWorld(sx: number, sy: number): Pos {
    return { x: (sx - this.cssW / 2) / this.zoom + this.cx, y: (sy - this.cssH / 2) / this.zoom + this.cy };
  }

  /** マス中心の画面座標 */
  private sx(x: number): number {
    return (x - this.cx) * this.zoom + this.cssW / 2;
  }
  private sy(y: number): number {
    return (y - this.cy) * this.zoom + this.cssH / 2;
  }

  draw(view: View): void {
    const g = this.ctx;
    const z = this.zoom;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.fillStyle = COLORS.bg;
    g.fillRect(0, 0, this.cssW, this.cssH);

    const { map } = view;
    const x0 = Math.max(0, Math.floor(this.cx - this.cssW / 2 / z) - 1);
    const x1 = Math.min(map.w - 1, Math.ceil(this.cx + this.cssW / 2 / z) + 1);
    const y0 = Math.max(0, Math.floor(this.cy - this.cssH / 2 / z) - 1);
    const y1 = Math.min(map.h - 1, Math.ceil(this.cy + this.cssH / 2 / z) + 1);

    // 地形
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * map.w + x;
        if (view.visible && !view.explored[i] && !view.visible[i]) continue;
        this.drawTile(tileAt(map, x, y), this.sx(x) - z / 2, this.sy(y) - z / 2, z, map, x, y);
        if (view.visible && !view.visible[i]) {
          g.fillStyle = COLORS.fogDim;
          g.fillRect(this.sx(x) - z / 2, this.sy(y) - z / 2, z, z);
        }
      }
    }

    const ta = view.treasureAt;
    if (ta && (!view.visible || view.explored[ta.y * map.w + ta.x] || view.visible[ta.y * map.w + ta.x])) this.drawTreasure(ta);

    for (const m of view.marks) this.drawMark(m);
    for (const h of view.hints) if (h.area) this.drawDanger(h.area.at, h.area.radius, h.area.tick);
    for (const h of view.hints) if (h.aim) this.drawAimLine(h.at, h.aim.to, view.pulse ?? 0.5, h.aim.charge, h.aim.power);

    // 倒れた敵 → 気絶した味方 → 薄い残像 → 立っているユニットの順に描く(味方が水たまりに隠れて担げなくならないように)
    const rank = (u: DisplayUnit) => (!u.down ? (u.faint ? 1.5 : 2) : u.side === 'enemy' ? 0 : 1);
    const sorted = [...view.units].sort((a, b) => rank(a) - rank(b));
    for (const u of sorted) this.drawUnit(u);

    for (const h of view.hints) this.drawHint(h.at, h.intent, h.label);
    for (const e of view.effects) this.drawEffect(e);
    for (const p of view.pointers ?? []) this.drawPointer(p.at, p.color, p.label);
  }

  /** マスが画面の内側(端から margin 割合を除いた範囲)に入っているか */
  inView(p: Pos, margin = 0): boolean {
    const x = this.sx(p.x);
    const y = this.sy(p.y);
    const mx = this.cssW * margin;
    const my = this.cssH * margin;
    return x >= mx && y >= my && x <= this.cssW - mx && y <= this.cssH - my;
  }

  /** 画面の外にある目標へ向けて、画面の端に矢印とラベルを描く */
  private drawPointer(p: Pos, color: string, label: string): void {
    if (this.inView(p)) return;
    const g = this.ctx;
    const cx = this.cssW / 2;
    const cy = this.cssH / 2;
    const dx = this.sx(p.x) - cx;
    const dy = this.sy(p.y) - cy;
    const pad = 22;
    const k = Math.min((cx - pad) / Math.max(1e-6, Math.abs(dx)), (cy - pad) / Math.max(1e-6, Math.abs(dy)));
    const x = cx + dx * k;
    const y = cy + dy * k;
    const a = Math.atan2(dy, dx);
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(12, 0);
    g.lineTo(-6, -8);
    g.lineTo(-6, 8);
    g.closePath();
    g.fill();
    g.restore();
    g.font = 'bold 11px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lx = x - Math.cos(a) * 18;
    const ly = y - Math.sin(a) * 14;
    g.fillStyle = '#000b';
    const w = g.measureText(label).width + 8;
    g.fillRect(lx - w / 2, ly - 8, w, 16);
    g.fillStyle = color;
    g.fillText(label, lx, ly + 0.5);
  }

  private drawTile(t: string, px: number, py: number, z: number, map: FloorMap, x: number, y: number): void {
    const g = this.ctx;
    if (t === '#') {
      g.fillStyle = COLORS.wall;
      g.fillRect(px, py, z, z);
      g.strokeStyle = COLORS.wallLine;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(px, py + z / 2);
      g.lineTo(px + z, py + z / 2);
      g.moveTo(px + z / 2, py);
      g.lineTo(px + z / 2, py + z / 2);
      g.moveTo(px + z / 4, py + z / 2);
      g.lineTo(px + z / 4, py + z);
      g.stroke();
      return;
    }
    g.fillStyle = COLORS.floor;
    g.fillRect(px, py, z, z);
    g.strokeStyle = 'rgba(255,255,255,0.04)';
    g.strokeRect(px + 0.5, py + 0.5, z - 1, z - 1);
    if (t === '+' || t === 'D') {
      this.drawDoor(t === 'D', px, py, z, tileAt(map, x, y - 1) === '#' && tileAt(map, x, y + 1) === '#');
    } else if (t === 'H') {
      // 回復の泉
      g.fillStyle = '#2a6fa8';
      g.beginPath();
      g.ellipse(px + z / 2, py + z / 2, z * 0.38, z * 0.3, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#9ad8ff';
      g.fillRect(px + z * 0.32, py + z * 0.4, z * 0.14, z * 0.06);
      g.fillRect(px + z * 0.52, py + z * 0.56, z * 0.14, z * 0.06);
    } else if (t in FACILITY_ICON) {
      // 地上の施設(看板の色の床と絵文字)
      g.fillStyle = '#4a3a22';
      g.fillRect(px + 1, py + 1, z - 2, z - 2);
      g.strokeStyle = '#c8a060';
      g.lineWidth = 1.5;
      g.strokeRect(px + 2, py + 2, z - 4, z - 4);
      g.font = `${Math.round(z * 0.62)}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(FACILITY_ICON[t], px + z / 2, py + z / 2 + 1);
    } else if (t === 'h') {
      // 酸の泉(毒々しい緑の水たまりと泡)
      g.fillStyle = '#4a8a1a';
      g.beginPath();
      g.ellipse(px + z / 2, py + z / 2, z * 0.38, z * 0.3, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#b8f040';
      for (const [bx, by, br] of [
        [0.38, 0.45, 0.07],
        [0.58, 0.56, 0.05],
        [0.62, 0.42, 0.04],
      ]) {
        g.beginPath();
        g.arc(px + z * bx, py + z * by, z * br, 0, Math.PI * 2);
        g.fill();
      }
    } else if (t === 'S') {
      // 上り階段(上ほど細い段)
      g.fillStyle = COLORS.stairs;
      for (let i = 0; i < 4; i++) g.fillRect(px + z * 0.15, py + z * (0.15 + i * 0.19), z * (0.7 - i * 0.15), z * 0.12);
    } else if (t === '>') {
      // 下り階段(暗い穴に、奥ほど細くなる段)
      g.fillStyle = '#06060a';
      g.fillRect(px + z * 0.1, py + z * 0.1, z * 0.8, z * 0.8);
      g.fillStyle = COLORS.stairs;
      for (let i = 0; i < 4; i++) {
        const w = z * (0.7 - i * 0.15);
        g.globalAlpha = 1 - i * 0.2;
        g.fillRect(px + (z - w) / 2, py + z * (0.72 - i * 0.18), w, z * 0.1);
      }
      g.globalAlpha = 1;
    } else if (t === '$' || t === 'c') {
      // 宝箱(c は開けた後)
      const open = t === 'c';
      g.fillStyle = open ? '#4a3418' : '#8a5a20';
      g.fillRect(px + z * 0.2, py + z * 0.42, z * 0.6, z * 0.36);
      g.fillStyle = open ? '#5a4020' : '#a8702a';
      if (open) g.fillRect(px + z * 0.2, py + z * 0.24, z * 0.6, z * 0.1);
      else g.fillRect(px + z * 0.2, py + z * 0.3, z * 0.6, z * 0.14);
      g.fillStyle = open ? '#6a6050' : '#e8c060';
      g.fillRect(px + z * 0.46, py + z * 0.4, z * 0.08, z * 0.1);
    }
  }

  /**
   * 扉。closed=閉じた扉(板戸が通路をふさぐ)、開いた扉は枠と、壁側に開いた戸板だけを描く。
   * ew=通路が東西に通っている(扉の上下が壁)
   */
  private drawDoor(closed: boolean, px: number, py: number, z: number, ew: boolean): void {
    const g = this.ctx;
    // 枠(壁側の 2 か所の柱)
    g.fillStyle = '#5a3c1c';
    if (ew) {
      g.fillRect(px + z * 0.3, py, z * 0.4, z * 0.1);
      g.fillRect(px + z * 0.3, py + z * 0.9, z * 0.4, z * 0.1);
    } else {
      g.fillRect(px, py + z * 0.3, z * 0.1, z * 0.4);
      g.fillRect(px + z * 0.9, py + z * 0.3, z * 0.1, z * 0.4);
    }
    if (closed) {
      // 板戸(縦板の継ぎ目と取っ手)
      const [x, y, w, h] = ew ? [px + z * 0.32, py + z * 0.04, z * 0.36, z * 0.92] : [px + z * 0.04, py + z * 0.32, z * 0.92, z * 0.36];
      g.fillStyle = COLORS.door;
      g.fillRect(x, y, w, h);
      g.strokeStyle = '#4a2e12';
      g.lineWidth = 1;
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      g.beginPath();
      if (ew) {
        g.moveTo(px + z * 0.5, y);
        g.lineTo(px + z * 0.5, y + h);
      } else {
        g.moveTo(x, py + z * 0.5);
        g.lineTo(x + w, py + z * 0.5);
      }
      g.stroke();
      g.fillStyle = '#e0c060';
      if (ew) g.fillRect(px + z * 0.54, py + z * 0.56, z * 0.08, z * 0.08);
      else g.fillRect(px + z * 0.56, py + z * 0.54, z * 0.08, z * 0.08);
      return;
    }
    // 開いた扉: 戸板が片側の柱から通路に沿って開いている
    g.fillStyle = COLORS.door;
    g.globalAlpha = 0.85;
    if (ew) g.fillRect(px + z * 0.3, py + z * 0.1, z * 0.62, z * 0.1);
    else g.fillRect(px + z * 0.1, py + z * 0.3, z * 0.1, z * 0.62);
    g.globalAlpha = 1;
  }

  private drawUnit(u: DisplayUnit): void {
    const g = this.ctx;
    const z = this.zoom;
    const cx = this.sx(u.x);
    const cy = this.sy(u.y);
    const ring = u.side === 'party' ? COLORS.party : COLORS.enemy;

    if (u.selected && !u.faint) {
      g.strokeStyle = '#ffe14a';
      g.lineWidth = 2;
      g.strokeRect(cx - z / 2 + 1, cy - z / 2 + 1, z - 2, z - 2);
    }
    g.save();
    // 倒れた敵は種類に関係なく泥の水たまりで表す(横倒しにせず、足元のリングも付けない)
    const puddle = u.down && u.side === 'enemy';
    if (puddle) {
      g.globalAlpha = 0.85;
    } else if (u.faint) {
      g.globalAlpha = 0.28;
    } else {
      if (u.down) {
        g.globalAlpha = 0.45;
        g.translate(cx, cy);
        g.rotate(Math.PI / 2);
        g.translate(-cx, -cy);
      }
      // 足元の陣営リング
      g.fillStyle = ring + '55';
      g.beginPath();
      g.ellipse(cx, cy + z * 0.32, z * 0.36, z * 0.12, 0, 0, Math.PI * 2);
      g.fill();
    }
    const s = Math.floor(z * 0.8);
    g.drawImage(iconCanvas(puddle ? 'puddle' : u.icon), Math.round(cx - s / 2), Math.round(cy - s / 2 - z * 0.04), s, s);
    g.restore();

    if (u.faint) return;
    if (!u.down) {
      // HP バー
      const w = z * 0.8;
      const ratio = Math.max(0, u.hp / u.maxHp);
      g.fillStyle = '#000a';
      g.fillRect(cx - w / 2, cy + z * 0.4, w, Math.max(2, z * 0.08));
      g.fillStyle = ratio > 0.5 ? '#4cd964' : ratio > 0.25 ? '#ffcc00' : '#ff3b30';
      g.fillRect(cx - w / 2, cy + z * 0.4, w * ratio, Math.max(2, z * 0.08));
    }
    if (u.guard) this.badge(cx + z * 0.3, cy - z * 0.32, '#5ab0ff', '盾');
    if (u.watch) this.badge(cx + z * 0.3, cy - z * 0.32, '#ffb020', '構');
    if (u.carrying) this.badge(cx - z * 0.3, cy - z * 0.32, '#80d8ff', '担');
    if (u.treasure) this.badge(cx - z * 0.3, cy + z * 0.22, '#ffd23a', '宝');
  }

  /** 宝箱 */
  /** 秘宝(光る宝石。ゴールドの宝箱と見分けられるように) */
  private drawTreasure(p: Pos): void {
    const g = this.ctx;
    const z = this.zoom;
    const cx = this.sx(p.x);
    const cy = this.sy(p.y);
    g.fillStyle = '#ffd23a40';
    g.beginPath();
    g.arc(cx, cy, z * 0.48, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ff4fa0';
    g.beginPath();
    g.moveTo(cx, cy - z * 0.32);
    g.lineTo(cx + z * 0.26, cy - z * 0.05);
    g.lineTo(cx, cy + z * 0.32);
    g.lineTo(cx - z * 0.26, cy - z * 0.05);
    g.closePath();
    g.fill();
    g.fillStyle = '#ffd0e8';
    g.fillRect(cx - z * 0.1, cy - z * 0.16, z * 0.08, z * 0.08);
  }

  /** 頭上の印。2 文字以上(「笛2」など)は横長の角丸にする */
  private badge(x: number, y: number, color: string, text: string): void {
    const g = this.ctx;
    const r = Math.max(6, this.zoom * 0.2);
    g.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
    const w = Math.max(0, g.measureText(text).width - r * 1.2);
    g.fillStyle = color;
    g.beginPath();
    g.arc(x - w / 2, y, r, Math.PI / 2, Math.PI * 1.5);
    g.arc(x + w / 2, y, r, Math.PI * 1.5, Math.PI / 2);
    g.closePath();
    g.fill();
    g.fillStyle = '#111';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y + 0.5);
  }

  /** 範囲魔法の着弾範囲。tick があれば、発動するティックを範囲の左上に出す(例「5」= 5 ティック目) */
  private drawDanger(c: Pos, radius: number, tick?: number): void {
    const g = this.ctx;
    const z = this.zoom;
    const x = this.sx(c.x - radius) - z / 2;
    const y = this.sy(c.y - radius) - z / 2;
    const s = z * (radius * 2 + 1);
    g.fillStyle = 'rgba(255,90,32,0.22)';
    g.fillRect(x, y, s, s);
    g.strokeStyle = '#ff7a20';
    g.lineWidth = 2;
    g.setLineDash([z * 0.18, z * 0.12]);
    g.strokeRect(x + 1, y + 1, s - 2, s - 2);
    g.setLineDash([]);
    if (tick !== undefined) {
      const r = Math.max(7, z * 0.28);
      g.fillStyle = '#ff7a20';
      g.beginPath();
      g.arc(x + r + 2, y + r + 2, r, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#000';
      g.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(tick), x + r + 2, y + r + 3);
    }
  }

  /** 敵が狙っている味方へのオレンジの点滅ライン(charge=追尾は長破線、power=強攻撃は太線) */
  private drawAimLine(from: Pos, to: Pos, pulse: number, charge?: boolean, power?: boolean): void {
    const g = this.ctx;
    const z = this.zoom;
    const x0 = this.sx(from.x);
    const y0 = this.sy(from.y);
    const x1 = this.sx(to.x);
    const y1 = this.sy(to.y);
    const alpha = 0.32 + 0.63 * (0.5 + 0.5 * Math.sin(pulse * Math.PI * 2));
    g.save();
    g.globalAlpha = alpha;
    g.strokeStyle = power ? '#ff5a20' : '#ff9420';
    g.lineWidth = Math.max(power ? 2.5 : 1.75, z * (power ? 0.09 : charge ? 0.075 : 0.06));
    g.setLineDash(charge ? [z * 0.28, z * 0.12] : [z * 0.14, z * 0.14]);
    g.lineDashOffset = -pulse * z * 0.56;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
    g.setLineDash([]);
    // 狙われている味方の足元にも小さなオレンジの照準リングを添える
    g.beginPath();
    g.arc(x1, y1, z * 0.38, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  /** label があれば、印の文字の代わりに出す(警報役の残りターンなど) */
  private drawHint(at: Pos, intent: Intent, label?: string): void {
    const map: Record<Intent, [string, string]> = {
      attack: ['#ff4d4d', '!'],
      power: ['#ff5a20', '強5'],
      watch: ['#ffb020', '迎'],
      move: ['#ffd24d', '→'],
      guard: ['#5ab0ff', '■'],
      idle: ['#9a9aa8', '…'],
      sleep: ['#8a8ad0', 'z'],
      breath: ['#ff7a20', '炎'],
      cast: ['#ff3a80', '詠'],
      alarm: ['#ffb000', '笛'],
    };
    const [color, mark] = map[intent];
    const text = label ?? mark;
    this.badge(this.sx(at.x) - this.zoom * 0.3, this.sy(at.y) - this.zoom * 0.32, color, text);
  }

  private drawMark(m: Mark): void {
    const g = this.ctx;
    const z = this.zoom;
    switch (m.kind) {
      case 'path': {
        if (m.points.length < 2) return;
        g.strokeStyle = m.color;
        g.lineWidth = Math.max(2, z * 0.1);
        g.setLineDash(m.dashed ? [z * 0.2, z * 0.15] : []);
        g.beginPath();
        m.points.forEach((p, i) => (i === 0 ? g.moveTo(this.sx(p.x), this.sy(p.y)) : g.lineTo(this.sx(p.x), this.sy(p.y))));
        g.stroke();
        g.setLineDash([]);
        for (const p of m.points.slice(1)) {
          g.fillStyle = m.color;
          g.beginPath();
          g.arc(this.sx(p.x), this.sy(p.y), Math.max(2, z * 0.08), 0, Math.PI * 2);
          g.fill();
        }
        return;
      }
      case 'ghost': {
        const s = Math.floor(z * 0.8);
        g.save();
        g.globalAlpha = 0.4;
        g.drawImage(iconCanvas(m.icon), Math.round(this.sx(m.at.x) - s / 2), Math.round(this.sy(m.at.y) - s / 2), s, s);
        g.restore();
        return;
      }
      case 'target': {
        const x = this.sx(m.at.x);
        const y = this.sy(m.at.y);
        g.strokeStyle = m.color;
        g.lineWidth = 2;
        g.beginPath();
        g.arc(x, y, z * 0.42, 0, Math.PI * 2);
        g.moveTo(x - z * 0.55, y);
        g.lineTo(x - z * 0.25, y);
        g.moveTo(x + z * 0.25, y);
        g.lineTo(x + z * 0.55, y);
        g.moveTo(x, y - z * 0.55);
        g.lineTo(x, y - z * 0.25);
        g.moveTo(x, y + z * 0.25);
        g.lineTo(x, y + z * 0.55);
        g.stroke();
        return;
      }
      case 'area': {
        const r = m.radius + 0.5;
        g.fillStyle = m.color;
        g.fillRect(this.sx(m.at.x - r), this.sy(m.at.y - r), z * r * 2, z * r * 2);
        return;
      }
      case 'link': {
        g.strokeStyle = m.color;
        g.lineWidth = 1.5;
        g.setLineDash([4, 4]);
        g.beginPath();
        g.moveTo(this.sx(m.from.x), this.sy(m.from.y));
        g.lineTo(this.sx(m.to.x), this.sy(m.to.y));
        g.stroke();
        g.setLineDash([]);
        return;
      }
    }
  }

  private drawEffect(e: Effect): void {
    const g = this.ctx;
    const z = this.zoom;
    g.save();
    g.globalAlpha = Math.max(0, Math.min(1, e.alpha));
    switch (e.kind) {
      case 'line':
        g.strokeStyle = e.color;
        g.lineWidth = Math.max(2, z * 0.08);
        g.beginPath();
        g.moveTo(this.sx(e.from.x), this.sy(e.from.y));
        g.lineTo(this.sx(e.to.x), this.sy(e.to.y));
        g.stroke();
        break;
      case 'burst': {
        const r = (e.radius + 0.5) * z;
        const grad = g.createRadialGradient(this.sx(e.at.x), this.sy(e.at.y), 0, this.sx(e.at.x), this.sy(e.at.y), r);
        grad.addColorStop(0, e.color);
        grad.addColorStop(1, 'transparent');
        g.fillStyle = grad;
        g.fillRect(this.sx(e.at.x) - r, this.sy(e.at.y) - r, r * 2, r * 2);
        break;
      }
      case 'slash': {
        const x = this.sx(e.at.x);
        const y = this.sy(e.at.y);
        g.strokeStyle = '#fff';
        g.lineWidth = Math.max(2, z * 0.1);
        g.beginPath();
        g.moveTo(x - z * 0.35, y - z * 0.35);
        g.lineTo(x + z * 0.35, y + z * 0.35);
        g.moveTo(x + z * 0.35, y - z * 0.35);
        g.lineTo(x - z * 0.35, y + z * 0.35);
        g.stroke();
        break;
      }
      case 'text':
        g.font = `bold ${Math.round(Math.max(12, z * 0.5))}px sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.lineWidth = 3;
        g.strokeStyle = '#000';
        g.strokeText(e.text, this.sx(e.at.x), this.sy(e.at.y) - e.rise * z);
        g.fillStyle = e.color;
        g.fillText(e.text, this.sx(e.at.x), this.sy(e.at.y) - e.rise * z);
        break;
    }
    g.restore();
  }
}
