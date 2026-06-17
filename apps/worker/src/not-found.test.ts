import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';

// The notFound handler imports DB query helpers transitively (via the
// /r/:ref routes file isn't reached here, but `buildOgForLiffPath` reads
// from `@line-crm/db`-shaped tables through `c.env.DB.prepare`). The bot UA
// path is not exercised by these tests; everything else stays inside the
// handler so no DB calls happen.
vi.mock('@line-crm/db', () => ({
  // index.ts pulls these eagerly at module load; provide no-op stubs so the
  // import graph resolves under Vitest.
  getLineAccounts: vi.fn().mockResolvedValue([]),
  getTrafficPoolBySlug: vi.fn(),
  getTrafficPoolById: vi.fn(),
  getRandomPoolAccount: vi.fn(),
  getPoolAccounts: vi.fn(),
  getEntryRouteByRefCode: vi.fn(),
  getStaffByApiKey: vi.fn(),
  recoverStalledBroadcasts: vi.fn(),
  recoverStuckDeliveries: vi.fn(),
}));

import worker, { notFoundHandler, type Env } from './index.js';

function makeApp(env: Partial<Env['Bindings']>) {
  const app = new Hono<Env>();
  app.notFound(notFoundHandler);
  return (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://worker.example.com${path}`, init), env as Env['Bindings']);
}

describe('notFoundHandler — root / request', () => {
  it('redirects the public root to the company applicant workspace', async () => {
    const res = await worker.fetch(
      new Request('https://worker.example.com/'),
      { DB: {} as D1Database } as Env['Bindings'],
      { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/demo-chat');
  });

  it('serves the saiyo-pro harness root from static assets instead of demo-chat', async () => {
    const assets: Fetcher = {
      fetch: vi.fn().mockResolvedValue(new Response('saiyo-pro-liff', { status: 200 })),
    } as unknown as Fetcher;
    const res = await worker.fetch(
      new Request('https://worker.example.com/'),
      {
        DB: {} as D1Database,
        ASSETS: assets,
        WORKER_NAME: 'saiyo-pro-harness',
      } as Env['Bindings'],
      { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('saiyo-pro-liff');
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it('returns 404 JSON when ASSETS binding is undefined (no TypeError)', async () => {
    const fetchApp = makeApp({ DB: {} as D1Database });
    const res = await fetchApp('/');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body).toEqual({ success: false, error: 'Not found' });
  });

  it('returns 404 JSON when ASSETS exists but has no fetch method', async () => {
    const fetchApp = makeApp({
      DB: {} as D1Database,
      ASSETS: {} as unknown as Fetcher,
    });
    const res = await fetchApp('/');
    expect(res.status).toBe(404);
  });

  it('delegates to ASSETS.fetch when the binding is present', async () => {
    const assets: Fetcher = {
      fetch: vi.fn().mockResolvedValue(new Response('static', { status: 200 })),
    } as unknown as Fetcher;
    const fetchApp = makeApp({ DB: {} as D1Database, ASSETS: assets });
    const res = await fetchApp('/some-spa-path');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('static');
    expect(assets.fetch).toHaveBeenCalledOnce();
  });

  it('returns JSON 404 (not ASSETS lookup) for /api/* unknown paths', async () => {
    const assets: Fetcher = {
      fetch: vi.fn().mockResolvedValue(new Response('should not be called', { status: 200 })),
    } as unknown as Fetcher;
    const fetchApp = makeApp({ DB: {} as D1Database, ASSETS: assets });
    const res = await fetchApp('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(assets.fetch).not.toHaveBeenCalled();
  });
});
