import { describe, it, expect } from 'vitest';
import { splitForLine } from './ai-reply-handler.js';

describe('splitForLine', () => {
  it('keeps short text as single chunk', () => {
    expect(splitForLine('短い返信')).toEqual(['短い返信']);
  });

  it('splits long text on sentence boundaries under the limit', () => {
    const long = 'あ'.repeat(700);
    const chunks = splitForLine(long);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(500));
  });

  it('prefers sentence boundaries when splitting', () => {
    const text = 'これは一文目です。' + 'い'.repeat(495) + '。' + 'これは三文目です。';
    const chunks = splitForLine(text);
    expect(chunks.length).toBeGreaterThan(1);
    // 最初のチャンクは一文目で区切られる（句点で割れている）
    expect(chunks[0].endsWith('。')).toBe(true);
  });
});
