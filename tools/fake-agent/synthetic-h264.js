const start = Buffer.from([0, 0, 0, 1]);
const nal = (hdr, n = 8) => Buffer.concat([start, Buffer.from([hdr, ...Buffer.alloc(n, 0xbb)])]);

/** GOP ~2s @30fps: 1 IDR + 59 P-slices */
export function syntheticH264() {
  const parts = [nal(0x67), nal(0x68), nal(0x65)];
  for (let i = 0; i < 59; i++) parts.push(nal(0x61));
  return Buffer.concat(parts);
}
