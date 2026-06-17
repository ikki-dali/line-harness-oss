import { describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { saiyoProJobs } from './saiyo-pro-jobs.js';

const getFriendByIdMock = vi.hoisted(() => vi.fn());
const getSaiyoProCompanyJobsMock = vi.hoisted(() => vi.fn());
const getSaiyoProJobApplicationsForCompanyMock = vi.hoisted(() => vi.fn());
const createSaiyoProCompanyJobMock = vi.hoisted(() => vi.fn());
const getSaiyoProCompanyJobByIdMock = vi.hoisted(() => vi.fn());
const updateSaiyoProCompanyJobMock = vi.hoisted(() => vi.fn());
const createSaiyoProJobApplicationMock = vi.hoisted(() => vi.fn());

vi.mock('@line-crm/db', () => ({
  getFriendById: getFriendByIdMock,
  getSaiyoProCompanyJobs: getSaiyoProCompanyJobsMock,
  getSaiyoProJobApplicationsForCompany: getSaiyoProJobApplicationsForCompanyMock,
  createSaiyoProCompanyJob: createSaiyoProCompanyJobMock,
  getSaiyoProCompanyJobById: getSaiyoProCompanyJobByIdMock,
  updateSaiyoProCompanyJob: updateSaiyoProCompanyJobMock,
  createSaiyoProJobApplication: createSaiyoProJobApplicationMock,
}));

function setupApp() {
  const app = new Hono();
  app.route('/', saiyoProJobs);
  return {
    request: (path: string, init?: RequestInit) => app.request(path, init, {
      DB: {} as D1Database,
      WORKER_URL: 'https://worker.example',
    }),
  };
}

describe('saiyo-pro production job routes', () => {
  test('company job page is scoped to the company friend account', async () => {
    getFriendByIdMock.mockResolvedValueOnce({
      id: 'friend-company',
      line_account_id: 'saiyo-pro-company',
      display_name: '山田商店',
    });
    getSaiyoProCompanyJobsMock.mockResolvedValueOnce([]);
    getSaiyoProJobApplicationsForCompanyMock.mockResolvedValueOnce([]);

    const app = setupApp();
    const res = await app.request('/company/jobs?accountId=saiyo-pro-company&friendId=friend-company');
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('求人管理');
    expect(html).toContain('山田商店');
    expect(getSaiyoProCompanyJobsMock).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'saiyo-pro-company',
      companyFriendId: 'friend-company',
      status: 'all',
      limit: 20,
    });
  });

  test('company job submit creates a published job for the current company friend', async () => {
    getFriendByIdMock.mockResolvedValueOnce({
      id: 'friend-company',
      line_account_id: 'saiyo-pro-company',
      display_name: '山田商店',
    });
    createSaiyoProCompanyJobMock.mockResolvedValueOnce({ id: 'job-1' });

    const body = new URLSearchParams({
      accountId: 'saiyo-pro-company',
      friendId: 'friend-company',
      companyName: '山田商店',
      title: '店舗スタッフ',
      wageLabel: '時給1,300円',
      status: 'published',
    });
    const app = setupApp();
    const res = await app.request('/company/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    expect(res.status).toBe(303);
    expect(createSaiyoProCompanyJobMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      lineAccountId: 'saiyo-pro-company',
      companyFriendId: 'friend-company',
      companyName: '山田商店',
      title: '店舗スタッフ',
      status: 'published',
    }));
  });

  test('candidate can apply to a published production job once', async () => {
    getFriendByIdMock.mockResolvedValueOnce({
      id: 'friend-candidate',
      line_account_id: 'saiyo-pro-candidate',
      display_name: '応募者',
    });
    getSaiyoProCompanyJobByIdMock.mockResolvedValueOnce({
      id: 'job-1',
      status: 'published',
      company_friend_id: 'friend-company',
    });
    createSaiyoProJobApplicationMock.mockResolvedValueOnce({ id: 'application-1' });

    const body = new URLSearchParams({
      accountId: 'saiyo-pro-candidate',
      friendId: 'friend-candidate',
      jobId: 'job-1',
    });
    const app = setupApp();
    const res = await app.request('/candidate/jobs/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    expect(res.status).toBe(303);
    expect(createSaiyoProJobApplicationMock).toHaveBeenCalledWith(expect.anything(), {
      jobId: 'job-1',
      candidateFriendId: 'friend-candidate',
      candidateLineAccountId: 'saiyo-pro-candidate',
      companyFriendId: 'friend-company',
      message: null,
    });
  });
});
