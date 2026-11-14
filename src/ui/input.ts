// Pointer Events による入力。マウスとタッチを同じ処理で扱う。
// - 1 本指(マウス)の短い押下 → タップ
// - 1 本指のドラッグ → パン
// - 2 本指 → ピンチズーム + パン
// - ホイール → ズーム
import type { Renderer } from './renderer';

const TAP_SLOP = 8;

export function attachInput(canvas: HTMLCanvasElement, renderer: Renderer, onTap: (sx: number, sy: number) => void, onChange: () => void): void {
  const pointers = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number } | null = null;
  let dragging = false;
  let pinchDist = 0;

  const local = (e: PointerEvent | WheelEvent) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = local(e);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) {
      downAt = p;
      dragging = false;
    } else if (pointers.size === 2) {
      downAt = null;
      pinchDist = spread();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (pointers.size === 1) {
      if (!dragging && downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) > TAP_SLOP) dragging = true;
      if (dragging) {
        renderer.panBy(p.x - prev.x, p.y - prev.y);
        onChange();
      }
      pointers.set(e.pointerId, p);
    } else if (pointers.size === 2) {
      const before = center();
      pointers.set(e.pointerId, p);
      const after = center();
      const d = spread();
      if (pinchDist > 0 && d > 0) renderer.zoomAt(d / pinchDist, after.x, after.y);
      renderer.panBy(after.x - before.x, after.y - before.y);
      pinchDist = d;
      onChange();
    }
  });

  const end = (e: PointerEvent) => {
    if (!pointers.has(e.pointerId)) return;
    const p = local(e);
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (wasSingle && downAt && !dragging && e.type === 'pointerup') onTap(p.x, p.y);
    if (pointers.size === 0) downAt = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      renderer.zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, p.x, p.y);
      onChange();
    },
    { passive: false },
  );

  function center() {
    const ps = [...pointers.values()];
    return { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
  }
  function spread() {
    const ps = [...pointers.values()];
    return Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
  }
}
