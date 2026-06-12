import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { images } from './images.js';

function setupApp(object: R2ObjectBody | null) {
  const app = new Hono();
  app.route('/', images);
  const getMock = vi.fn(async () => object);
  const r2 = { get: getMock } as unknown as R2Bucket;
  return {
    getMock,
    request: (path: string, init?: RequestInit) => app.request(path, init, { IMAGES: r2 }),
  };
}

describe('public image routes', () => {
  test('serves uploaded images stored under nested R2 keys', async () => {
    const body = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    const { request, getMock } = setupApp({
      body,
      etag: 'etag-1',
      httpMetadata: { contentType: 'image/jpeg' },
    } as unknown as R2ObjectBody);

    const res = await request('/images/demo-job-banners/banner-1.jpg');

    expect(res.status).toBe(200);
    expect(getMock).toHaveBeenCalledWith('demo-job-banners/banner-1.jpg');
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });
});
