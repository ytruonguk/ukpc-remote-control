const START = Buffer.from([0, 0, 0, 1]);

export function splitNals(buf) {
  const nals = [];
  let i = buf.indexOf(START);
  while (i !== -1) {
    const next = buf.indexOf(START, i + 4);
    nals.push(buf.subarray(i, next === -1 ? buf.length : next));
    i = next;
  }
  return nals;
}

/** @returns {{type: number, data: Buffer}[]} */
export function buildFrames(buf) {
  const frames = [];
  let config = [];
  let au = null;
  let auType = 0x03;

  for (const nal of splitNals(buf)) {
    const t = nal[4] & 0x1f;
    if (t === 7 || t === 8) {
      config.push(nal);
      continue;
    }
    if (t !== 1 && t !== 5) continue;

    if (config.length) {
      frames.push({ type: 0x01, data: Buffer.concat(config) });
      config = [];
    }
    if (au) frames.push({ type: auType, data: au });
    au = nal;
    auType = t === 5 ? 0x02 : 0x03;
  }
  if (au) frames.push({ type: auType, data: au });
  return frames;
}

export function pack(type, ptsUs, payload) {
  const h = Buffer.alloc(9);
  h[0] = type;
  h.writeBigUInt64BE(BigInt(Math.round(Number(ptsUs))), 1);
  return Buffer.concat([h, payload]);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
