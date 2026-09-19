export function connectStream(wsUrl: string, token: string, canvas: HTMLCanvasElement) {
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
    },
    error: (e) => console.error(e),
  });
  decoder.configure({ codec: 'avc1.42E01E', optimizeForLatency: true });

  let gotKey = false;
  let jpegMode = false;
  let jpegBusy = false;
  let jpegLatest: Uint8Array | null = null;
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
    if (typeof ev.data === 'string') return;
    const buf = ev.data as ArrayBuffer;
    const v = new DataView(buf);
    const type = v.getUint8(0);
    const pts = Number(v.getBigUint64(1));
    if (type === 0x04) {
      jpegMode = true;
      jpegLatest = new Uint8Array(buf, 9).slice();
      paintJpeg(ctx);
      return;
    }
    if (type === 0x01) {
      jpegMode = false;
      return;
    }
    if (jpegMode) return;
    if (type === 0x02) {
      jpegMode = false;
      gotKey = true;
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
      decoder.close();
      ws.close();
    },
  };
}
