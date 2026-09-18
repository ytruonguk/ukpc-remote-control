import { WebSocket } from 'ws';

export class FakeViewer {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.json = [];
    this.connectedAt = Date.now();
    ws.on('message', (data, isBinary) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!isBinary && typeof data === 'string') {
        this.json.push(JSON.parse(data));
        return;
      }
      if (!isBinary && buf[0] !== 0x01 && buf[0] !== 0x02 && buf[0] !== 0x03) {
        try {
          this.json.push(JSON.parse(buf.toString()));
          return;
        } catch {
          // binary mis-flagged
        }
      }
      this.frames.push({ type: buf[0], pts: buf.readBigUInt64BE(1), at: Date.now() });
    });
  }

  static connect(wsUrl, token) {
    const url = `${wsUrl}?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    const viewer = new FakeViewer(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(viewer));
      ws.once('error', reject);
    });
  }

  gotCodecConfig() {
    return this.frames.some((f) => f.type === 0x01);
  }

  firstKeyframeLatency() {
    const k = this.frames.find((f) => f.type === 0x02);
    return k ? k.at - this.connectedAt : null;
  }

  waitForFirstKeyframe(ms) {
    const deadline = Date.now() + ms;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.frames.some((f) => f.type === 0x02)) return resolve(true);
        if (Date.now() > deadline) return reject(new Error('no keyframe'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  close() {
    this.ws.close();
  }
}
