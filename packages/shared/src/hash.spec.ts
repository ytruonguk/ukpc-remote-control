import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capsHash } from './hash';
import type { Caps } from './types';

test('hash is stable regardless of key order', () => {
  const a = { a11y: true, knox: 'licensed' } as Caps;
  const b = { knox: 'licensed', a11y: true } as Caps;
  assert.equal(capsHash(a, '1.2.0'), capsHash(b, '1.2.0'));
});

test('hash changes when a value changes', () => {
  assert.notEqual(capsHash({ a11y: true } as Caps, '1.2.0'), capsHash({ a11y: false } as Caps, '1.2.0'));
});

test('agentVer is included in the hash', () => {
  const caps = { a11y: true, knox: 'licensed' } as Caps;
  assert.notEqual(capsHash(caps, '1.2.0'), capsHash(caps, '1.3.0'));
});
