'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type ObjectName = 'companies' | 'people' | 'deals';
type View = ObjectName | 'tasks' | 'notes';
type Value = { value?: string; full_name?: string; email_address?: string; domain?: string; status?: { title: string }; currency_value?: number; currency_code?: string; target_record_id?: string; referenced_actor_id?: string };
type CrmRecord = { id: { record_id: string }; values: Record<string, Value[]>; object: ObjectName };
type Note = { id: { note_id: string }; parent_record_id: string; title: string; content_plaintext: string; created_at: string };
type Task = { id: { task_id: string }; content_plaintext: string; is_completed: boolean; deadline_at: string | null; linked_records: { target_record_id: string }[]; assignees: { referenced_actor_id: string }[] };
type Member = { id: { workspace_member_id: string }; first_name: string; last_name: string; email_address: string };
const objects: ObjectName[] = ['companies', 'people', 'deals'];
const labels = { companies: 'Companies', people: 'People', deals: 'Deals', tasks: 'Tasks', notes: 'Notes' };
const singular = { companies: 'company', people: 'person', deals: 'deal' };
const stages = ['Lead', 'In Progress', 'Won 🎉', 'Lost'];
const icons = { companies: '▦', people: '♙', deals: '◈', tasks: '☑', notes: '▤' };
const first = (r: CrmRecord, key: string) => r.values[key]?.[0];
const name = (r: CrmRecord) => first(r, 'name')?.full_name || first(r, 'name')?.value || 'Unnamed record';
const stage = (r: CrmRecord) => first(r, 'stage')?.status?.title || 'No stage';
const money = (r: CrmRecord) => { const v = first(r, 'value'); return v?.currency_value == null ? '—' : new Intl.NumberFormat('en-GB', { style: 'currency', currency: v.currency_code || 'USD', maximumFractionDigits: 0 }).format(v.currency_value); };
const date = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const initials = (s: string) => s.split(/[\s—]+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
async function api(path: string, method = 'GET', body?: unknown) {
  const res = await fetch(`/api/ui/${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store' });
  const result = await res.json();
  if (!res.ok) throw new Error(result.message || result.error || `Request failed (${res.status})`);
  return result;
}
async function allPages(path: string, post = false): Promise<unknown[]> {
  const rows: unknown[] = [];
  const limit = path === 'notes' ? 50 : 500;
  for (let offset = 0; ; offset += limit) {
    const result = post ? await api(path, 'POST', { limit, offset }) : await api(`${path}?limit=${limit}&offset=${offset}`);
    rows.push(...result.data);
    if (result.data.length < limit) return rows;
  }
}
function Badge({ value }: { value: string }) { return <span className={`badge stage-${stages.indexOf(value)}`}><span className="dot" />{value}</span>; }
function Avatar({ text }: { text: string }) { return <span className={`avatar tone-${text.length % 5}`}>{initials(text)}</span>; }

export default function AttioApp() {
  const [view, setView] = useState<View>('deals');
  const [workspace, setWorkspace] = useState('Workspace');
  const [records, setRecords] = useState<CrmRecord[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All stages');
  const [completed, setCompleted] = useState(false);
  const [board, setBoard] = useState(false);
  const [descending, setDescending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<'overview' | 'notes' | 'tasks'>('overview');
  const [modal, setModal] = useState<'record' | 'note' | 'task' | null>(null);
  const [editing, setEditing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try {
      const [self, roster, companies, people, deals, ns, ts] = await Promise.all([
        api('self'), api('workspace_members'), ...objects.map(o => allPages(`objects/${o}/records/query`, true)), allPages('notes'), allPages('tasks'),
      ]);
      setWorkspace(self.workspace_name || 'Workspace'); setMembers(roster.data);
      const loaded = objects.flatMap((object, i) => ([companies, people, deals][i] as CrmRecord[]).map(r => ({ ...r, object })));
      setRecords(loaded);
      setSelected(previous => loaded.some(r => r.id.record_id === previous) ? previous : null);
      setNotes(ns as Note[]); setTasks(ts as Task[]); setError('');
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const drawerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!selected) return;
    const previous = document.activeElement as HTMLElement | null;
    drawerRef.current?.querySelector<HTMLElement>('button')?.focus();
    return () => previous?.focus();
  }, [selected]);
  const record = records.find(r => r.id.record_id === selected);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (modal) setModal(null); else setSelected(null); }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [modal]);
  async function mutate(path: string, method: string, data: unknown) {
    setBusy(true); setError('');
    try { await api(path, method, { data }); await load(); setModal(null); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function toggleTask(task: Task) {
    setBusy(true); setError('');
    setTasks(items => items.map(t => t.id.task_id === task.id.task_id ? { ...t, is_completed: !task.is_completed } : t));
    try { await api(`tasks/${task.id.task_id}`, 'PATCH', { data: { is_completed: !task.is_completed } }); await load(); }
    catch (e) { setTasks(items => items.map(t => t.id.task_id === task.id.task_id ? task : t)); setError((e as Error).message); }
    finally { setBusy(false); }
  }
  function navigate(next: View) { setView(next); setSearch(''); setSelected(null); setFilter('All stages'); }
  function open(r: CrmRecord) { setSelected(r.id.record_id); setTab('overview'); }
  function linked(id?: string) { return records.find(r => r.id.record_id === id); }
  function reference(id?: string) { const r = linked(id); return r ? <button className="text-link" onClick={() => open(r)}>{name(r)}</button> : <span className="muted">—</span>; }
  function owner(id?: string) { const m = members.find(m => m.id.workspace_member_id === id); return m ? `${m.first_name} ${m.last_name}` : 'Unassigned'; }
  const matching = records.filter(r => r.object === view && JSON.stringify(r.values).toLowerCase().includes(search.toLowerCase()) && (view !== 'deals' || filter === 'All stages' || stage(r) === filter)).sort((a, b) => name(a).localeCompare(name(b)) * (descending ? -1 : 1));
  const recordNotes = notes.filter(n => n.parent_record_id === selected);
  const recordTasks = tasks.filter(t => t.linked_records.some(l => l.target_record_id === selected));
  const shownTasks = (record ? recordTasks : tasks).filter(t => (completed || !t.is_completed) && (record || t.content_plaintext.toLowerCase().includes(search.toLowerCase())));
  const shownNotes = record ? recordNotes : notes.filter(n => `${n.title} ${n.content_plaintext}`.toLowerCase().includes(search.toLowerCase()));
  function taskList(items: Task[]) { return <div className="task-list">{items.map(t => <div className={`task-row ${t.is_completed ? 'done' : ''}`} key={t.id.task_id}>
    <input type="checkbox" aria-label={`Complete ${t.content_plaintext}`} checked={t.is_completed} disabled={busy} onChange={() => void toggleTask(t)} />
    <div><p>{t.content_plaintext}</p><div className="task-meta">{t.linked_records.map(l => <span key={l.target_record_id}>{reference(l.target_record_id)}</span>)}<span>{t.deadline_at ? date(t.deadline_at) : 'No due date'}</span><span>{t.assignees.map(a => owner(a.referenced_actor_id)).join(', ') || 'Unassigned'}</span></div></div>
  </div>)}{!items.length && <div className="empty small">No tasks to show.</div>}</div>; }
  function noteList(items: Note[]) { return <div className="note-list">{items.map(n => <article className="note" key={n.id.note_id}><div className="note-meta">{reference(n.parent_record_id)}<time>{date(n.created_at)}</time></div><h3>{n.title}</h3><p>{n.content_plaintext}</p></article>)}{!items.length && <div className="empty small">No notes yet.</div>}</div>; }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget); const val = (k: string) => String(f.get(k) || '').trim();
    if (modal === 'note' && record) return mutate('notes', 'POST', { parent_object: record.object, parent_record_id: selected, title: val('title'), content: val('content'), format: 'plaintext' });
    if (modal === 'task') return mutate('tasks', 'POST', { content: val('content'), format: 'plaintext', deadline_at: val('deadline') ? new Date(`${val('deadline')}T17:00:00`).toISOString() : null, assignees: val('assignee') ? [val('assignee')] : [], linked_records: selected && record ? [{ target_object: record.object, target_record_id: selected }] : [] });
    const object = editing && record ? record.object : view as ObjectName;
    const values: Record<string, unknown> = { name: object === 'people' ? { full_name: val('name') } : val('name') };
    if (object === 'companies') { values.description = val('description'); if (val('domains')) values.domains = [val('domains')]; }
    if (object === 'people') { values.job_title = val('job_title'); if (val('email')) values.email_addresses = [val('email')]; }
    if (object === 'deals') { values.stage = val('stage'); if (val('value')) values.value = Number(val('value')); if (val('owner')) values.owner = [{ referenced_actor_type: 'workspace-member', referenced_actor_id: val('owner') }]; }
    if (object !== 'companies' && val('company')) values[object === 'deals' ? 'associated_company' : 'company'] = [{ target_object: 'companies', target_record_id: val('company') }];
    await mutate(`objects/${object}/records${editing ? `/${selected}` : ''}`, editing ? 'PATCH' : 'POST', { values });
  }
  const formObject = editing && record ? record.object : view as ObjectName;
  const editRecord = editing ? record : undefined;
  const current = (key: string) => editRecord ? first(editRecord, key) : undefined;
  return <div className="app-shell">
    <aside className="sidebar" inert={!!selected || !!modal}><a className="brand" href="/" aria-label="Attio home"><svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 19 11 4h3l7 15h-4l-5-11-5 11Z" fill="currentColor"/><path d="M8 14h9v3H8z" fill="currentColor"/></svg><span>attio</span></a>
      <div className="workspace"><span className="workspace-icon">{initials(workspace)}</span><strong>{workspace}</strong></div>
      <button className="search-shortcut" onClick={() => searchRef.current?.focus()}><span>⌕ &nbsp; Search this view</span><kbd>⌘ K</kbd></button>
      <nav aria-label="Workspace navigation">{(['tasks', 'notes'] as View[]).map(v => <button key={v} aria-label={labels[v]} className={view === v ? 'nav-item active' : 'nav-item'} onClick={() => navigate(v)}><span>{icons[v]}</span>{labels[v]}{v === 'tasks' && <span className="count">{tasks.filter(t => !t.is_completed).length}</span>}</button>)}<div className="nav-heading">Records</div>{objects.map(v => <button key={v} aria-label={labels[v]} className={view === v ? 'nav-item active' : 'nav-item'} onClick={() => navigate(v)}><span>{icons[v]}</span>{labels[v]}<span className="count">{records.filter(r => r.object === v).length}</span></button>)}</nav>
      <div className="sidebar-footer"><span className="local-dot" />Sonata replica<span className="muted">Local workspace</span></div>
    </aside>
    <main inert={!!selected || !!modal}><header className="topbar"><span className="muted">Workspace</span><span className="slash">/</span><span>{icons[view]} &nbsp; {labels[view]}</span><button className="button subtle refresh" disabled={loading || busy} onClick={() => { setLoading(true); void load(); }}>↻ &nbsp; Refresh</button></header>
      <div className="page-title"><div><h1>{labels[view]}</h1><p>{view === 'deals' ? 'Your pipeline, from first conversation to decision.' : view === 'companies' ? 'The companies and relationships in your workspace.' : view === 'people' ? 'Founders, colleagues and the people you work with.' : view === 'tasks' ? 'Follow-ups, deadlines and the next thing to do.' : 'Context and decisions, connected to your records.'}</p></div>{view !== 'notes' && <button className="button primary" disabled={loading || busy} onClick={() => { setEditing(false); setModal(view === 'tasks' ? 'task' : 'record'); }}>＋ {view === 'tasks' ? 'New task' : `New ${singular[view]}`}</button>}</div>
      {error && <div className="error" role="alert">{error}<button onClick={() => { setLoading(true); void load(); }}>Retry</button></div>}
      <div className="toolbar"><div className="view-tabs">{view === 'deals' ? <><button className={!board ? 'selected' : ''} onClick={() => setBoard(false)}>☷ All deals</button><button className={board ? 'selected' : ''} onClick={() => setBoard(true)}>▥ Pipeline</button></> : <span className="view-label">{view === 'tasks' ? 'Workspace tasks' : `All ${view}`}</span>}</div><div className="tools"><input ref={searchRef} className="search" aria-label={`Search ${view}`} placeholder={`Search ${view}…`} value={search} onChange={e => setSearch(e.target.value)} />{view === 'deals' && <select aria-label="Filter by stage" value={filter} onChange={e => setFilter(e.target.value)}>{['All stages', ...stages, 'No stage'].map(s => <option key={s}>{s}</option>)}</select>}{objects.includes(view as ObjectName) && <button className="button subtle" onClick={() => setDescending(!descending)}>Sort {descending ? 'Z–A' : 'A–Z'}</button>}{view === 'tasks' && <label className="check-label"><input type="checkbox" checked={completed} onChange={e => setCompleted(e.target.checked)} />Show completed</label>}</div></div>
      {loading ? <div className="empty" role="status">Loading your workspace…</div> : <>
        {objects.includes(view as ObjectName) && (matching.length === 0 ? <div className="empty"><span className="empty-icon">{icons[view]}</span><h2>{search || filter !== 'All stages' ? 'No matching records' : `No ${view} yet`}</h2><p>{search || filter !== 'All stages' ? 'Try another search or filter.' : 'Create a record, or load an environment from Sonata to bring its CRM into this workspace.'}</p></div> : view === 'deals' && board ? <div className="board">{[...stages, ...(matching.some(r => stage(r) === 'No stage') ? ['No stage'] : [])].filter(s => filter === 'All stages' || s === filter).map(s => <section className="board-column" key={s}><h2><Badge value={s} /><span className="muted">{matching.filter(r => stage(r) === s).length}</span></h2>{matching.filter(r => stage(r) === s).map(r => <button className="deal-card" key={r.id.record_id} onClick={() => open(r)}><strong><Avatar text={name(r)} />{name(r)}</strong><span>{linked(first(r, 'associated_company')?.target_record_id) ? name(linked(first(r, 'associated_company')?.target_record_id)!) : 'No company'}</span><footer><b>{money(r)}</b><span>{owner(first(r, 'owner')?.referenced_actor_id)}</span></footer></button>)}</section>)}</div> : <div className="table-scroll"><table><thead><tr><th>Name <span className="muted">{matching.length}</span></th>{view === 'companies' ? <><th>Domains</th><th>Description</th></> : view === 'people' ? <><th>Email address</th><th>Job title</th><th>Company</th></> : <><th>Stage</th><th>Deal value</th><th>Company</th><th>Owner</th></>}</tr></thead><tbody>{matching.map(r => <tr key={r.id.record_id}><td><button className="record-name" onClick={() => open(r)}><Avatar text={name(r)} />{name(r)}<span className="open-arrow">↗</span></button></td>{view === 'companies' ? <><td>{(r.values.domains || []).map(v => v.domain).join(', ') || '—'}</td><td className="description">{first(r, 'description')?.value || '—'}</td></> : view === 'people' ? <><td>{(r.values.email_addresses || []).map(v => v.email_address).join(', ') || '—'}</td><td>{first(r, 'job_title')?.value || '—'}</td><td>{reference(first(r, 'company')?.target_record_id)}</td></> : <><td><Badge value={stage(r)} /></td><td className="numeric">{money(r)}</td><td>{reference(first(r, 'associated_company')?.target_record_id)}</td><td>{owner(first(r, 'owner')?.referenced_actor_id)}</td></>}</tr>)}</tbody></table><div className="table-footer">{matching.length} {view} · Workspace records</div></div>)}
        {view === 'tasks' && taskList(shownTasks)}{view === 'notes' && noteList(shownNotes)}
      </>}
    </main>
    {record && <div className="drawer-backdrop" onClick={() => setSelected(null)}><section ref={drawerRef} inert={!!modal} className="drawer" onKeyDown={e => trapTab(e, drawerRef.current)} role="dialog" aria-modal="true" aria-label={name(record)} onClick={e => e.stopPropagation()}><div className="drawer-top"><span>{labels[record.object]} / Record</span><button className="icon-button" aria-label="Close record" onClick={() => setSelected(null)}>×</button></div><div className="record-heading"><Avatar text={name(record)} /><h2>{name(record)}</h2><button className="button" onClick={() => { setEditing(true); setModal('record'); }}>Edit record</button></div><div className="detail-tabs">{(['overview', 'notes', 'tasks'] as const).map(t => <button className={tab === t ? 'selected' : ''} key={t} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}{t === 'notes' ? ` ${recordNotes.length}` : t === 'tasks' ? ` ${recordTasks.length}` : ''}</button>)}</div><div className="drawer-body">
      {tab === 'overview' && <><h3 className="section-label">Record details</h3><dl>{Object.entries(record.values).map(([key, values]) => <div key={key}><dt>{key.replaceAll('_', ' ')}</dt><dd>{values.map((v, i) => <span className="attribute-value" key={i}>{v.target_record_id ? reference(v.target_record_id) : v.referenced_actor_id ? owner(v.referenced_actor_id) : v.status ? <Badge value={v.status.title} /> : v.currency_value != null ? money(record) : v.full_name || v.value || v.domain || v.email_address || '—'}</span>)}</dd></div>)}</dl><h3 className="section-label">Related records</h3><div className="related">{records.filter(r => r.id.record_id !== selected && Object.values(r.values).flat().some(v => v.target_record_id === selected)).map(r => <button key={r.id.record_id} onClick={() => open(r)}><Avatar text={name(r)} /><span>{name(r)}<small>{singular[r.object]}</small></span><span className="muted">↗</span></button>)}</div><div className="section-title"><h3>Latest notes</h3><button className="button" onClick={() => setModal('note')}>＋ Add note</button></div>{noteList(recordNotes.slice(0, 2))}</>}
      {tab === 'notes' && <><div className="section-title"><h3>Notes</h3><button className="button" onClick={() => setModal('note')}>＋ Add note</button></div>{noteList(recordNotes)}</>}
      {tab === 'tasks' && <><div className="section-title"><h3>Tasks</h3><button className="button" onClick={() => setModal('task')}>＋ New task</button></div>{taskList(recordTasks)}</>}
    </div></section></div>}
    {modal && <Modal close={() => setModal(null)}><form onSubmit={submit}><div className="modal-heading"><h2>{modal === 'record' ? `${editing ? 'Edit' : 'New'} ${singular[formObject]}` : modal === 'note' ? 'Add a note' : 'New task'}</h2><button type="button" className="icon-button" aria-label="Close form" onClick={() => setModal(null)}>×</button></div>{error && <p className="error" role="alert">{error}</p>}
      {modal === 'record' ? <><label>Name<input required name="name" defaultValue={editRecord ? name(editRecord) : ''} /></label>{formObject === 'companies' && <><label>{editing ? 'Add domain (optional)' : 'Domain'}<input name="domains" placeholder="company.example" /></label><label>Description<textarea name="description" defaultValue={current('description')?.value} /></label></>}{formObject === 'people' && <><label>{editing ? 'Add email address (optional)' : 'Email address'}<input type="email" name="email" /></label><label>Job title<input name="job_title" defaultValue={current('job_title')?.value} /></label></>}{formObject === 'deals' && <><div className="form-grid"><label>Stage<select aria-label="Stage" name="stage" defaultValue={editRecord ? stage(editRecord) : 'Lead'}>{stages.map(s => <option key={s}>{s}</option>)}</select></label><label>Deal value ({current('value')?.currency_code || 'USD'})<input type="number" min="0" step="any" name="value" defaultValue={current('value')?.currency_value} /></label></div><label>Owner<select aria-label="Owner" name="owner" defaultValue={current('owner')?.referenced_actor_id || ''}><option value="">{editing ? 'Keep current owner' : 'Unassigned'}</option>{members.map(m => <option key={m.id.workspace_member_id} value={m.id.workspace_member_id}>{m.first_name} {m.last_name}</option>)}</select></label></>}{formObject !== 'companies' && <label>Company<select aria-label="Company" name="company" defaultValue={current(formObject === 'deals' ? 'associated_company' : 'company')?.target_record_id || ''}><option value="">{editing ? 'Keep current company' : 'No company'}</option>{records.filter(r => r.object === 'companies').map(r => <option key={r.id.record_id} value={r.id.record_id}>{name(r)}</option>)}</select></label>}</> : <>{record && <p className="attached">Linked to <strong>{name(record)}</strong></p>}{modal === 'note' && <label>Title<input required name="title" /></label>}<label>{modal === 'note' ? 'Note' : 'What needs to be done?'}<textarea required rows={5} name="content" /></label>{modal === 'task' && <div className="form-grid"><label>Due date<input type="date" name="deadline" /></label><label>Assignee<select aria-label="Assignee" name="assignee"><option value="">Unassigned</option>{members.map(m => <option key={m.id.workspace_member_id} value={m.email_address}>{m.first_name} {m.last_name}</option>)}</select></label></div>}</>}
      <footer className="modal-footer"><button type="button" className="button" disabled={busy} onClick={() => setModal(null)}>Cancel</button><button className="button primary" type="submit" disabled={busy}>{busy ? 'Saving…' : modal === 'record' ? 'Save record' : modal === 'note' ? 'Save note' : 'Create task'}</button></footer></form></Modal>}
  </div>;
}

function Modal({ children, close }: { children: React.ReactNode; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, textarea, select')?.focus();
    return () => previous?.focus();
  }, []);
  return <div className="modal-backdrop" onClick={close}><div ref={ref} className="modal" role="dialog" aria-modal="true" aria-label="Record form" onClick={e => e.stopPropagation()} onKeyDown={e => trapTab(e, ref.current)}>{children}</div></div>;
}

function trapTab(e: React.KeyboardEvent, element: HTMLElement | null) {
  if (e.key !== 'Tab') return;
  const els = Array.from(element?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea, select') || []);
  const first = els[0], last = els[els.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
  if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
}
