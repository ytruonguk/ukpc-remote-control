import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFrames, pack, splitNals } from './annexb.js';

const START = Buffer.from([0, 0, 0, 1]);
const nal = (hdr, extra = 3) => Buffer.concat([START, Buffer.from([hdr, ...Buffer.alloc(extra, 0xaa)])]);

test('splitNals splits on start codes', () => {
  const buf = Buffer.concat([nal(0x67), nal(0x65)]);
  const nals = splitNals(buf);
  assert.equal(nals.length, 2);
  assert.equal(nals[0][4] & 0x1f, 7);
  assert.equal(nals[1][4] & 0x1f, 5);
});

test('buildFrames: SPS/PPS → 0x01, IDR → 0x02, P → 0x03', () => {
  const buf = Buffer.concat([nal(0x67), nal(0x68), nal(0x65), nal(0x61)]);
  const frames = buildFrames(buf);
  assert.equal(frames.map((f) => f.type).join(','), '1,2,3');
});

test('pack ghi type + pts big-endian 8 byte', () => {
  const p = pack(0x02, 33_000, Buffer.from([9, 9]));
  assert.equal(p[0], 0x02);
  assert.equal(p.readBigUInt64BE(1), 33000n);
  assert.deepEqual([...p.subarray(9)], [9, 9]);
});
