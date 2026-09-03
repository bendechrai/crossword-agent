import { describe, expect, it } from 'vitest';

import { canonicalJson, sha1 } from '../../../src/util/hash.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('emits no incidental whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: 'x' })).toBe('{"a":[1,2],"b":"x"}');
  });

  it('drops undefined object fields', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('keeps array positions, turning undefined holes into null', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('keeps null distinct from absent', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
  });

  it('is insensitive to key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it('handles primitives and undefined at the top level', () => {
    expect(canonicalJson('a')).toBe('"a"');
    expect(canonicalJson(7)).toBe('7');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('is stable for nested arrays of objects', () => {
    const a = canonicalJson({ list: [{ z: 1, a: 2 }] });
    const b = canonicalJson({ list: [{ a: 2, z: 1 }] });
    expect(a).toBe(b);
    expect(a).toBe('{"list":[{"a":2,"z":1}]}');
  });
});

describe('sha1', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha1('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('matches the known digest of "abc"', () => {
    expect(sha1('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('is 40 hex characters', () => {
    expect(sha1('anything at all')).toMatch(/^[0-9a-f]{40}$/);
  });
});
