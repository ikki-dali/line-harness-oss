import { describe, expect, test } from 'vitest';
import { getEffectiveSearchParams } from './url-params.js';

describe('getEffectiveSearchParams', () => {
  test('reads LIFF params wrapped in liff.state', () => {
    const params = getEffectiveSearchParams(
      '?liff.state=%3FliffId%3D2010373013-o7pRF1um%26ref%3Dfive-rpo-rejection%26form%3Dform-saiyo-pro-candidate-intake',
    );

    expect(params.get('liffId')).toBe('2010373013-o7pRF1um');
    expect(params.get('ref')).toBe('five-rpo-rejection');
    expect(params.get('form')).toBe('form-saiyo-pro-candidate-intake');
  });

  test('lets direct query params override liff.state values', () => {
    const params = getEffectiveSearchParams(
      '?liff.state=%3FliffId%3Dold%26ref%3Dold-ref&liffId=new&ref=new-ref',
    );

    expect(params.get('liffId')).toBe('new');
    expect(params.get('ref')).toBe('new-ref');
  });
});
