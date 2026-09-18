function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

export function norm(e: PointerEvent, canvas: HTMLCanvasElement) {
  const r = canvas.getBoundingClientRect();
  return {
    x: clamp01((e.clientX - r.left) / r.width),
    y: clamp01((e.clientY - r.top) / r.height),
  };
}

export function attachPointer(canvas: HTMLCanvasElement, send: (msg: unknown) => void) {
  canvas.style.touchAction = 'none';
  let lastMove = 0;
  const onDown = (e: PointerEvent) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    send({ t: 'pointer', a: 'down', ...norm(e, canvas) });
  };
  const onUp = (e: PointerEvent) => {
    send({ t: 'pointer', a: 'up', ...norm(e, canvas) });
  };
  const onMove = (e: PointerEvent) => {
    const now = Date.now();
    if (now - lastMove < 30) return;
    lastMove = now;
    send({ t: 'pointer', a: 'move', ...norm(e, canvas) });
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointermove', onMove);
  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointermove', onMove);
  };
}
