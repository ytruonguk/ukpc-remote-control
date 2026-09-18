import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capsHash } from './hash';
import type { Caps } from './types';

test('hash ổn định bất kể thứ tự key', () => {
  const a = { a11y: true, knox: 'licensed' } as Caps;
  const b = { knox: 'licensed', a11y: true } as Caps;
  assert.equal(capsHash(a, '1.2.0'), capsHash(b, '1.2.0'));
});

test('hash đổi khi giá trị đổi', () => {
  assert.notEqual(capsHash({ a11y: true } as Caps, '1.2.0'), capsHash({ a11y: false } as Caps, '1.2.0'));
});

test('agentVer nằm trong hash', () => {
  const caps = { a11y: true, knox: 'licensed' } as Caps;
  assert.notEqual(capsHash(caps, '1.2.0'), capsHash(caps, '1.3.0'));
});
