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
  hints: { at: Pos; intent: Intent }[];
  effects: Effect[];
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
        this.drawTile(tileAt(map, x, y), this.sx(x) - z / 2, this.sy(y) - z / 2, z);
        if (view.visible && !view.visible[i]) {
          g.fillStyle = COLORS.fogDim;
          g.fillRect(this.sx(x) - z / 2, this.sy(y) - z / 2, z, z);
        }
      }
    }

    for (const m of view.marks) this.drawMark(m);

    // 気絶したユニットを先に、立っているユニットを後に描く
    const sorted = [...view.units].sort((a, b) => Number(b.down) - Number(a.down));
    for (const u of sorted) this.drawUnit(u);

    for (const h of view.hints) this.drawHint(h.at, h.intent);
    for (const e of view.effects) this.drawEffect(e);
  }

  private drawTile(t: string, px: number, py: number, z: number): void {
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
    if (t === '+') {
      g.fillStyle = COLORS.door;
      g.fillRect(px + z * 0.15, py + z * 0.15, z * 0.7, z * 0.7);
      g.fillStyle = '#e0c060';
      g.fillRect(px + z * 0.62, py + z * 0.48, z * 0.08, z * 0.08);
    } else if (t === 'H') {
      // 回復の泉
      g.fillStyle = '#2a6fa8';
      g.beginPath();
      g.ellipse(px + z / 2, py + z / 2, z * 0.38, z * 0.3, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#9ad8ff';
      g.fillRect(px + z * 0.32, py + z * 0.4, z * 0.14, z * 0.06);
      g.fillRect(px + z * 0.52, py + z * 0.56, z * 0.14, z * 0.06);
    } else if (t === 'S') {
      g.fillStyle = COLORS.stairs;
      for (let i = 0; i < 4; i++) g.fillRect(px + z * 0.15, py + z * (0.15 + i * 0.19), z * (0.7 - i * 0.15), z * 0.12);
    }
  }

  private drawUnit(u: DisplayUnit): void {
    const g = this.ctx;
    const z = this.zoom;
    const cx = this.sx(u.x);
    const cy = this.sy(u.y);
    const ring = u.side === 'party' ? COLORS.party : COLORS.enemy;

    if (u.selected) {
      g.strokeStyle = '#ffe14a';
      g.lineWidth = 2;
      g.strokeRect(cx - z / 2 + 1, cy - z / 2 + 1, z - 2, z - 2);
    }
    g.save();
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
    const s = Math.floor(z * 0.8);
    g.drawImage(iconCanvas(u.icon), Math.round(cx - s / 2), Math.round(cy - s / 2 - z * 0.04), s, s);
    g.restore();

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
  }

  private badge(x: number, y: number, color: string, text: string): void {
    const g = this.ctx;
    const r = Math.max(6, this.zoom * 0.2);
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#111';
    g.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, x, y + 0.5);
  }

  private drawHint(at: Pos, intent: Intent): void {
    const map: Record<Intent, [string, string]> = {
      attack: ['#ff4d4d', '!'],
      move: ['#ffd24d', '→'],
      guard: ['#5ab0ff', '■'],
      idle: ['#9a9aa8', '…'],
    };
    const [color, text] = map[intent];
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
