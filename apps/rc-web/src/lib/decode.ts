export function connectStream(
  wsUrl: string,
  token: string,
  canvas: HTMLCanvasElement,
  onLog?: (line: string) => void,
) {
  const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');

  const decoder = new VideoDecoder({
    output: (frame) => {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      ctx.drawImage(frame, 0, 0);
      frame.close();
      notePaint();
    },
    error: (e) => {
      console.error(e);
      onLog?.(`view: decode ${e.message}`);
    },
  });
  decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true });

  let gotKey = false;
  let jpegMode = false;
  let jpegBusy = false;
  let jpegLatest: Uint8Array | null = null;
  let n1 = 0;
  let n2 = 0;
  let n3 = 0;
  let n4 = 0;
  let painted = 0;
  let paintAt = performance.now();
  const notePaint = () => {
    painted += 1;
    const now = performance.now();
    if (now - paintAt < 2000) return;
    const fps = Math.round((painted * 1000) / (now - paintAt));
    onLog?.(`view: ${fps}fps in=${n1 + n2 + n3 + n4} key=${n2} jpeg=${n4}`);
    painted = 0;
    paintAt = now;
  };
  const warnNoKey = window.setTimeout(() => {
    if (!gotKey && !jpegMode) {
      onLog?.(`view: no keyframe after 2s cfg=${n1} key=${n2} delta=${n3} jpeg=${n4}`);
    }
  }, 2000);
  const paintJpeg = (ctx: CanvasRenderingContext2D) => {
    const jpeg = jpegLatest;
    if (!jpeg || jpegBusy) return;
    jpegLatest = null;
    jpegBusy = true;
    const copy = new Uint8Array(jpeg.byteLength);
    copy.set(jpeg);
    createImageBitmap(new Blob([copy.buffer], { type: 'image/jpeg' }))
      .then((img) => {
        canvas.width = img.width;
        canvas.height = img.height;
        ctx.drawImage(img, 0, 0);
        img.close();
        notePaint();
      })
      .catch(() => {})
      .finally(() => {
        jpegBusy = false;
        paintJpeg(ctx);
      });
  };
  ws.onopen = async () => {
    const support = {
      h264: (await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E' })).supported,
      h265: (await VideoDecoder.isConfigSupported({ codec: 'hev1.1.6.L93.B0' })).supported,
    };
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ws.send(JSON.stringify({
      t: 'hello',
      codecs: support,
      jpeg: true,
      maxW: Math.round(Math.min(1920, window.innerWidth * dpr)),
      maxH: Math.round(Math.min(1920, window.innerHeight * dpr)),
    }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') {
      onLog?.(formatAgentLog(ev.data));
      return;
    }
    const buf = ev.data as ArrayBuffer;
    const v = new DataView(buf);
    const type = v.getUint8(0);
    if (type === 0x7b) {
      onLog?.(formatAgentLog(new TextDecoder().decode(buf)));
      return;
    }
    const pts = Number(v.getBigUint64(1));
    if (type === 0x04) {
      n4 += 1;
      jpegMode = true;
      window.clearTimeout(warnNoKey);
      jpegLatest = new Uint8Array(buf, 9).slice();
      paintJpeg(ctx);
      return;
    }
    if (type === 0x01) {
      n1 += 1;
      jpegMode = false;
      if (n1 === 1) onLog?.('view: cfg 0x01');
      return;
    }
    if (jpegMode) return;
    if (type === 0x02) {
      n2 += 1;
      jpegMode = false;
      gotKey = true;
      window.clearTimeout(warnNoKey);
      if (n2 === 1) onLog?.(`view: key 0x02 n=${buf.byteLength}`);
    } else if (type === 0x03) {
      n3 += 1;
    }
    if (!gotKey) return;
    decoder.decode(
      new EncodedVideoChunk({
        type: type === 0x02 ? 'key' : 'delta',
        timestamp: pts,
        data: new Uint8Array(buf, 9),
      }),
    );
  };

  return {
    ws,
    send(msg: unknown) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      window.clearTimeout(warnNoKey);
      decoder.close();
      ws.close();
    },
  };
}

function formatAgentLog(raw: string): string {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (o.t === 'meta') {
      const why = o.why ? ` why=${o.why}` : '';
      return `meta ${o.codec} ${o.w}x${o.h}${why}`;
    }
    if (o.t !== 'log') return raw;
    if (o.msg === 'stats') {
      const q = Number(o.q) || 0;
      const qk = q >= 1024 ? `${Math.round(q / 1024)}k` : String(q);
      return `stats ${o.fps}fps ${o.kbps}kbps target=${o.br} q=${qk} · ${o.enc}`;
    }
    if (o.msg === 'h264.fail' || o.msg === 'jpeg.fallback') {
      return ['FAIL', o.code, o.why, o.ex, o.fault, o.crash, o.step]
        .map((x) => (x == null || x === '' ? '' : String(x)))
        .filter(Boolean)
        .join(' · ');
    }
    const bits = [o.msg, o.enc, o.step, o.err, o.why, o.code, o.lastFail, o.ex, o.fault]
      .map((x) => (x == null || x === '' ? '' : String(x)))
      .filter(Boolean);
    return bits.join(' · ');
  } catch {
    return raw;
  }
}
