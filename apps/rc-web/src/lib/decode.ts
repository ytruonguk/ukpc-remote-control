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
  ws.onopen = async () => {
    const support = {
      h264: (await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E' })).supported,
      h265: (await VideoDecoder.isConfigSupported({ codec: 'hev1.1.6.L93.B0' })).supported,
    };
    ws.send(JSON.stringify({ t: 'hello', codecs: support, maxW: 960, maxH: 1536 }));
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') return;
    const v = new DataView(ev.data as ArrayBuffer);
    const type = v.getUint8(0);
    const pts = Number(v.getBigUint64(1));
    if (type === 0x01) return;
    if (type === 0x02) gotKey = true;
    if (!gotKey) return;
    decoder.decode(
      new EncodedVideoChunk({
        type: type === 0x02 ? 'key' : 'delta',
        timestamp: pts,
        data: new Uint8Array(ev.data as ArrayBuffer, 9),
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
