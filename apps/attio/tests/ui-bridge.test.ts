import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/ui/[...path]/route';
const params = (path: string) => ({ params: Promise.resolve({ path: path.split('/') }) });
afterEach(() => vi.unstubAllEnvs());
describe('browser CRM boundary', () => {
  it('refuses cross-origin reads and writes before reaching the database', async () => {
    const read = await GET(new Request('http://localhost:3500/api/ui/self', { headers: { origin: 'https://other.example' } }), params('self'));
    expect(read.status).toBe(403);
    const write = await POST(new Request('http://localhost:3500/api/ui/notes', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' }), params('notes'));
    expect(write.status).toBe(403);
  });
  it('does not forward reset, arbitrary objects or unknown operations', async () => {
    for (const path of ['sandbox/reset', 'api/sandbox/seed', 'objects/private/records', 'notes/delete']) {
      const result = await POST(new Request(`http://localhost:3500/api/ui/${path}`, { method: 'POST', body: '{}' }), params(path));
      expect(result.status).toBe(404);
    }
  });
  it('checks the public browser origin behind the workplace proxy', async () => {
    vi.stubEnv('SANDBOX_PUBLIC_URL', 'http://localhost:45678');
    // An allowed origin reaches the operation allowlist; hostile origins stop before dispatch.
    const req = (origin: string) => new Request('http://attio:3000/api/ui/unsupported', {
      method: 'POST', headers: { origin, 'sec-fetch-site': 'same-origin' }, body: '{}',
    });
    expect((await POST(req('http://localhost:45678'), params('unsupported'))).status).toBe(404);
    expect((await POST(req('http://localhost:45679'), params('unsupported'))).status).toBe(403);
    expect((await POST(req('http://attio:3000'), params('unsupported'))).status).toBe(403);
  });
});
