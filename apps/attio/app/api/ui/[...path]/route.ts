import { SANDBOX_TOKEN } from '@/lib/attio/auth';
import { allowedBrowserOrigin } from '@sonata/core/browserOrigin';
import { GET as self } from '../../../v2/self/route';
import { GET as members } from '../../../v2/workspace_members/route';
import { POST as query } from '../../../v2/objects/[object]/records/query/route';
import { POST as create } from '../../../v2/objects/[object]/records/route';
import { GET as record, PATCH as update } from '../../../v2/objects/[object]/records/[recordId]/route';
import { GET as notes, POST as addNote } from '../../../v2/notes/route';
import { GET as tasks, POST as addTask } from '../../../v2/tasks/route';
import { PATCH as updateTask } from '../../../v2/tasks/[taskId]/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The browser never receives the sandbox credential. Dispatch only these CRM
// operations to their existing handlers, preserving validation and the audit log.
async function dispatch(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const url = new URL(req.url);
  if (!allowedBrowserOrigin(req)) {
    return Response.json({ message: 'Open this app directly to access the CRM.' }, { status: 403 });
  }
  const { path } = await params;
  const route = path.join('/');
  const method = req.method;
  const headers = new Headers({ authorization: `Bearer ${SANDBOX_TOKEN}`, 'content-type': 'application/json' });
  const forwarded = new Request(new URL(`/v2/${route}${url.search}`, url), {
    method, headers, ...(method === 'GET' ? {} : { body: await req.text() }),
  });
  if (route === 'self' && method === 'GET') return self(forwarded);
  if (route === 'workspace_members' && method === 'GET') return members(forwarded);
  if (route === 'notes' && method === 'GET') return notes(forwarded);
  if (route === 'notes' && method === 'POST') return addNote(forwarded);
  if (route === 'tasks' && method === 'GET') return tasks(forwarded);
  if (route === 'tasks' && method === 'POST') return addTask(forwarded);
  if (path.length === 2 && path[0] === 'tasks' && method === 'PATCH') {
    return updateTask(forwarded, { params: Promise.resolve({ taskId: path[1] }) });
  }
  if (path[0] === 'objects' && ['companies', 'people', 'deals'].includes(path[1]) && path[2] === 'records') {
    const object = path[1];
    if (path.length === 3 && method === 'POST') return create(forwarded, { params: Promise.resolve({ object }) });
    if (path.length === 4 && path[3] === 'query' && method === 'POST') return query(forwarded, { params: Promise.resolve({ object }) });
    if (path.length === 4 && path[3] !== 'query') {
      const context = { params: Promise.resolve({ object, recordId: path[3] }) };
      if (method === 'GET') return record(forwarded, context);
      if (method === 'PATCH') return update(forwarded, context);
    }
  }
  return Response.json({ message: 'This operation is not available in the browser.' }, { status: 404 });
}
export const GET = dispatch;
export const POST = dispatch;
export const PATCH = dispatch;
