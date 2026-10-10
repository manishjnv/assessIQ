import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiCallError, createApiClient, createApiRequest } from './index.js';

type FakeRes = Partial<Response> & { jsonBody?: unknown; jsonThrows?: boolean };

function mockFetch(res: FakeRes) {
  const fn = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: '',
    json: async () => {
      if (res.jsonThrows) throw new Error('bad json');
      return res.jsonBody;
    },
    ...res,
  }) as unknown as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

const initOf = (f: ReturnType<typeof mockFetch>, i: number): RequestInit =>
  (f.mock.calls[i] as unknown as [string, RequestInit])[1];

afterEach(() => vi.unstubAllGlobals());
const api = createApiClient('/api');
const fail = (p: Promise<unknown>): Promise<ApiCallError> =>
  p.then(() => { throw new Error('did not throw'); }, (e: unknown) => e as ApiCallError);

describe('http-client', () => {
  it('passes the error envelope through', async () => {
    mockFetch({ ok: false, status: 400, jsonBody: { error: { code: 'X', message: 'm', details: { a: 1 } } } });
    const e = await fail(api('/x'));
    expect(e).toBeInstanceOf(ApiCallError);
    expect(e.status).toBe(400);
    expect(e.apiError).toEqual({ code: 'X', message: 'm', details: { a: 1 } });
    expect(e.message).toBe('m');
    expect(e.name).toBe('ApiCallError');
  });

  it('401 throws ApiCallError with status 401', async () => {
    mockFetch({ ok: false, status: 401, jsonBody: { error: { code: 'UNAUTHENTICATED', message: 'no' } } });
    const e = await fail(api('/x'));
    expect(e).toBeInstanceOf(ApiCallError);
    expect(e.status).toBe(401);
    expect(e.apiError.code).toBe('UNAUTHENTICATED');
  });

  it('missing envelope -> HTTP_<status>', async () => {
    mockFetch({ ok: false, status: 502, statusText: 'Bad Gateway', jsonBody: {} });
    await expect(api('/x')).rejects.toMatchObject({ status: 502, apiError: { code: 'HTTP_502', message: 'Bad Gateway' } });
  });

  it('non-JSON error body -> {} fallback', async () => {
    mockFetch({ ok: false, status: 500, statusText: 'ISE', jsonThrows: true });
    await expect(api('/x')).rejects.toMatchObject({ apiError: { code: 'HTTP_500', message: 'ISE' } });
  });

  it('204 returns undefined', async () => {
    mockFetch({ status: 204 });
    await expect(api('/x')).resolves.toBeUndefined();
  });

  it('returns parsed JSON on 200', async () => {
    mockFetch({ jsonBody: { a: 1 } });
    await expect(api('/x')).resolves.toEqual({ a: 1 });
  });

  it('sets Content-Type only with a body; credentials include; caller headers win', async () => {
    const f = mockFetch({ jsonBody: {} });
    await api('/a', { method: 'POST' });
    expect(initOf(f, 0).credentials).toBe('include');
    expect(initOf(f, 0).headers).toEqual({});
    await api('/b', { method: 'POST', body: '{}', headers: { 'X-T': '1' } });
    expect(initOf(f, 1).headers).toEqual({ 'Content-Type': 'application/json', 'X-T': '1' });
    await api('/c', { body: null });
    expect(initOf(f, 2).headers).toEqual({});
  });

  it('base override per call, including empty string', async () => {
    const f = mockFetch({ jsonBody: {} });
    await api('/p');
    await api('/take/start', { base: '' });
    expect(f.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(['/api/p', '/take/start']);
  });

  it('custom error class is a subclass; createApiRequest exposes headers', async () => {
    class MyErr extends ApiCallError {
      constructor(s: number, a: { code: string; message: string }) {
        super(s, a);
        this.name = 'MyErr';
      }
    }
    mockFetch({ ok: false, status: 403, jsonBody: {} });
    const e = await fail(createApiClient('/api', MyErr)('/x'));
    expect(e).toBeInstanceOf(MyErr);
    expect(e).toBeInstanceOf(ApiCallError);
    expect(e.name).toBe('MyErr');
    mockFetch({ headers: new Headers({ 'X-Client-Revision': '7' }) });
    const res = await createApiRequest('/api')('/x');
    expect(res.headers.get('X-Client-Revision')).toBe('7');
  });
});
