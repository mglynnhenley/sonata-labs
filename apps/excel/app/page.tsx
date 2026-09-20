'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Value = string | number;
type Column = { key: string; label: string; type: 'text' | 'number' };
type Row = { id: string; values: Record<string, Value> };
type Sheet = { id: string; name: string; readOnly?: boolean; columns: Column[]; rows: Row[] };
type Workbook = { id: string; title: string; revision: number; sheets: Sheet[] };
type Payload = { workbook: Workbook; computed: Record<string, Record<string, Record<string, Value>>> };
type Change = { id: string; revision: number; actor: string; at: string; sheetId: string; rowId: string; column: string; before: unknown; after: unknown; reason: string; evidence: string };
type Selection = { rowId: string; column: string };
type Editor = { kind: 'cell' | 'row'; values: Record<string, string>; rowId?: string; column?: string; revision: number };

function letters(index: number): string {
  let result = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}

function readable(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 409) throw new Error('This workbook changed while you were editing. Reload the workbook and review the latest values before saving again.');
    throw new Error(typeof body.error === 'string' ? body.error : `The request failed (${response.status}). Please try again.`);
  }
  return body as T;
}

function Icon({ name }: { name: 'grid' | 'search' | 'history' | 'download' | 'plus' | 'edit' | 'close' | 'refresh' }) {
  const paths = {
    grid: <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
    history: <><path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/><path d="M12 7v5l3 2"/></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    edit: <><path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-5-5L4 14z"/></>,
    close: <path d="m6 6 12 12M6 18 18 6"/>,
    refresh: <><path d="M20 7a9 9 0 1 0 1 8M20 2v6h-6"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function WorkbookPage() {
  const [workbooks, setWorkbooks] = useState<{ id: string; title: string; revision: number }[]>([]);
  const [workbookId, setWorkbookId] = useState('');
  const [data, setData] = useState<Payload | null>(null);
  const [sheetId, setSheetId] = useState('');
  const [original, setOriginal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [history, setHistory] = useState<Change[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; direction: 1 | -1 } | null>(null);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    request<{ workbooks: typeof workbooks }>('/api/ui/workbooks', { signal: controller.signal })
      .then(result => { setWorkbooks(result.workbooks); setWorkbookId(current => current || new URLSearchParams(window.location.search).get('workbook') || result.workbooks[0]?.id || ''); if (!result.workbooks.length) setLoading(false); })
      .catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoading(false); } });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!workbookId) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setData(null); setSelection(null);
    request<Payload>(`/api/ui/workbooks/${encodeURIComponent(workbookId)}${original ? '?original=1' : ''}`, { signal: controller.signal })
      .then(result => { setData(result); setSheetId(current => result.workbook.sheets.some(sheet => sheet.id === current) ? current : result.workbook.sheets[0]?.id || ''); })
      .catch(err => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workbookId, original, reload]);

  useEffect(() => {
    if (!workbookId) return;
    const controller = new AbortController();
    setHistoryLoading(true); setHistoryError(''); setHistory([]);
    request<{ changes: Change[] }>(`/api/ui/workbooks/${encodeURIComponent(workbookId)}/history`, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setHistory(result.changes); })
      .catch(err => { if (!controller.signal.aborted) setHistoryError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setHistoryLoading(false); });
    return () => controller.abort();
  }, [workbookId, data?.workbook.revision, reload]);

  useEffect(() => { if (editor && !dialogRef.current?.open) dialogRef.current?.showModal(); }, [editor]);

  const workbook = data?.workbook;
  const sheet = workbook?.sheets.find(item => item.id === sheetId);
  const computed = data?.computed?.[sheetId] || {};
  const rows = useMemo(() => {
    const matching = (sheet?.rows || []).filter(row => !query || sheet?.columns.some(column => String(computed[row.id]?.[column.key] ?? row.values[column.key] ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase())));
    if (!sort) return matching;
    return [...matching].sort((a, b) => {
      const av = computed[a.id]?.[sort.key] ?? a.values[sort.key] ?? '';
      const bv = computed[b.id]?.[sort.key] ?? b.values[sort.key] ?? '';
      return (typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), undefined, { numeric: true })) * sort.direction;
    });
  }, [sheet, query, sort, computed]);
  const selectedRow = sheet?.rows.find(row => row.id === selection?.rowId);
  const selectedColumn = sheet?.columns.find(column => column.key === selection?.column);
  const address = selectedRow && selectedColumn && sheet ? `${letters(sheet.columns.indexOf(selectedColumn))}${sheet.rows.indexOf(selectedRow) + 2}` : '—';
  const rawValue = selectedRow && selectedColumn ? selectedRow.values[selectedColumn.key] ?? '' : '';
  const canEdit = Boolean(sheet && !sheet.readOnly && !original);
  const changedCells = new Set(history.filter(change => change.sheetId === sheetId).map(change => `${change.rowId}:${change.column}`));

  function changeSheet(id: string) { setSheetId(id); setSelection(null); setQuery(''); setSort(null); }
  function openEditor(kind: 'cell' | 'row', cell = selection) {
    if (!sheet || !workbook || !canEdit) return;
    const row = sheet.rows.find(item => item.id === cell?.rowId);
    if (kind === 'cell' && (!row || !cell)) return;
    setReason(''); setEvidence(''); setSaveError('');
    setEditor({ kind, revision: workbook.revision, rowId: row?.id, column: cell?.column, values: kind === 'row' ? Object.fromEntries(sheet.columns.map(column => [column.key, ''])) : { [cell!.column]: String(row!.values[cell!.column] ?? '') } });
  }
  function closeEditor() { if (!saving) { dialogRef.current?.close(); setEditor(null); } }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!editor || !sheet || !reason.trim() || !evidence.trim()) return;
    setSaving(true); setSaveError('');
    const values = Object.fromEntries(Object.entries(editor.values).map(([key, value]) => [key, sheet.columns.find(column => column.key === key)?.type === 'number' && value.trim() !== '' && !value.startsWith('=') && Number.isFinite(Number(value)) ? Number(value) : value]));
    try {
      const result = await request<Payload>(`/api/ui/workbooks/${encodeURIComponent(workbookId)}/${editor.kind === 'cell' ? 'cells' : 'rows'}`, {
        method: editor.kind === 'cell' ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: editor.revision, reason: reason.trim(), evidence: evidence.trim(), ...(editor.kind === 'cell' ? { changes: [{ sheetId, rowId: editor.rowId, column: editor.column, value: values[editor.column!] }] } : { sheetId, values }) }),
      });
      setData(result); setNotice(`${editor.kind === 'cell' ? 'Cell updated' : 'Row added'} · saved in revision ${result.workbook.revision}`); dialogRef.current?.close(); setEditor(null);
    } catch (err) { setSaveError(err instanceof Error ? err.message : 'The change could not be saved.'); }
    finally { setSaving(false); }
  }

  return <main className="workbook-app">
    <header className="titlebar">
      <a className="app-mark" href="/" aria-label="Reporting workbooks"><span className="excel-mark">X</span><span>Excel <span className="title-divider">/</span> <strong>Reporting</strong></span></a>
      <div className="titlebar-center"><span className="cloud-check" aria-hidden="true">✓</span> Local simulation</div>
      <div className="reviewer-avatar" title="Human reviewer">R</div>
    </header>

    <section className="workbook-heading" aria-label="Workbook details">
      <div className="heading-main"><span className="file-icon"><Icon name="grid" /></span><div><div className="eyebrow">REPORTING WORKSPACE</div><h1>{workbook?.title || 'Reporting workbook'}</h1></div></div>
      {workbooks.length > 1 && <label className="workbook-picker"><span className="sr-only">Choose workbook</span><select value={workbookId} onChange={event => { setWorkbookId(event.target.value); setQuery(''); setSort(null); setNotice(''); }}>{workbooks.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>}
      <div className="heading-actions"><button className={showHistory ? 'button active' : 'button'} aria-pressed={showHistory} onClick={() => setShowHistory(value => !value)}><Icon name="history"/>Changes</button>{workbook && sheet && <a className="button" href={`/api/ui/workbooks/${encodeURIComponent(workbookId)}/export?sheetId=${encodeURIComponent(sheetId)}${original ? '&original=1' : ''}`} download><Icon name="download"/>Export CSV</a>}</div>
    </section>

    <section className="ribbon" aria-label="Workbook controls">
      <div className="view-toggle" role="group" aria-label="Workbook version"><button className={!original ? 'selected' : ''} aria-pressed={!original} onClick={() => { setOriginal(false); setNotice(''); }}>Working copy</button><button className={original ? 'selected' : ''} aria-pressed={original} onClick={() => { setOriginal(true); setNotice(''); }}>Original</button></div>
      <span className="ribbon-divider"/>
      <button className="button quiet" disabled={!canEdit || !selection} onClick={() => openEditor('cell')}><Icon name="edit"/>Edit cell</button>
      <button className="button quiet" disabled={!canEdit} onClick={() => openEditor('row')}><Icon name="plus"/>Add row</button>
      <div className="ribbon-spacer"/>
      <label className="sheet-search"><Icon name="search"/><input type="search" placeholder="Find in this sheet" aria-label="Find in this sheet" value={query} onChange={event => setQuery(event.target.value)} disabled={!sheet}/></label>
      <button className="icon-button" aria-label="Reload workbook" title="Reload workbook" onClick={() => { setReload(value => value + 1); setNotice(''); }} disabled={loading}><Icon name="refresh"/></button>
    </section>

    <div className={`version-banner ${original || sheet?.readOnly ? 'source' : ''}`}><span className="status-dot"/><span>{original ? 'Original snapshot' : sheet?.readOnly ? 'Source data' : 'Working copy'}</span><span className="banner-detail">{original ? 'Preserved for comparison · read only' : sheet?.readOnly ? 'Reference values · read only' : 'Select a cell to review its value or formula. Every saved edit includes a reason and evidence.'}</span></div>
    <section className="formula-bar" aria-label="Selected cell"><output className="cell-address" aria-label="Cell address">{address}</output><span className="formula-symbol" aria-hidden="true">ƒx</span><input aria-label="Cell value or formula" value={String(rawValue)} readOnly placeholder="Select a cell to inspect its value or formula"/><span className="formula-label">{String(rawValue).startsWith('=') ? 'Formula' : selectedColumn?.label || ''}</span></section>
    {notice && <div className="save-notice" role="status">✓ {notice}<button aria-label="Dismiss notification" onClick={() => setNotice('')}><Icon name="close"/></button></div>}

    <div className="work-area">
      <section className="sheet-area" aria-label={sheet?.name || 'Worksheet'}>
        {loading ? <div className="empty-state" role="status"><span className="loading-ring"/><h2>Opening your workbook</h2><p>Loading worksheets and formulas…</p></div> : error ? <div className="empty-state" role="alert"><h2>Workbook unavailable</h2><p>{error}</p><button className="button primary" onClick={() => setReload(value => value + 1)}>Try again</button></div> : !sheet ? <div className="empty-state"><Icon name="grid"/><h2>{workbooks.length ? 'No worksheets yet' : 'No workbooks yet'}</h2><p>A reporting workbook will appear here when one has been prepared.</p></div> : <>
          <div className="grid-scroll">
            <table className="worksheet"><caption className="sr-only">{sheet.name}. Select a cell to inspect it, or double-click to edit. Sort columns using their headings.</caption>
              <thead><tr className="column-letters"><th className="corner" aria-label="Row number"/>{sheet.columns.map((column, index) => <th key={column.key} scope="col">{letters(index)}</th>)}</tr><tr className="column-headings"><th className="row-number">1</th>{sheet.columns.map(column => <th key={column.key} aria-sort={sort?.key === column.key ? sort.direction === 1 ? 'ascending' : 'descending' : 'none'}><button onClick={() => setSort(current => ({ key: column.key, direction: current?.key === column.key && current.direction === 1 ? -1 : 1 }))}>{column.label}<span aria-hidden="true" className="sort-indicator">{sort?.key === column.key ? sort.direction === 1 ? '↑' : '↓' : '⌄'}</span></button></th>)}</tr></thead>
              <tbody>{rows.map(row => <tr key={row.id}><th scope="row" className="row-number">{sheet.rows.indexOf(row) + 2}</th>{sheet.columns.map(column => {
                const raw = row.values[column.key] ?? '';
                const value = computed[row.id]?.[column.key] ?? raw;
                const selected = selection?.rowId === row.id && selection.column === column.key;
                const changed = !original && changedCells.has(`${row.id}:${column.key}`);
                return <td key={column.key} className={`${column.type === 'number' ? 'numeric' : ''} ${selected ? 'selected-cell' : ''} ${changed ? 'changed-cell' : ''}`}><button className="cell-button" aria-label={`${column.label}, row ${sheet.rows.indexOf(row) + 2}: ${value === '' ? 'blank' : value}${changed ? ', changed' : ''}`} aria-pressed={selected} onClick={() => setSelection({ rowId: row.id, column: column.key })} onDoubleClick={() => openEditor('cell', { rowId: row.id, column: column.key })} title={String(raw).startsWith('=') ? `${raw}\nResult: ${value}` : String(value)}>{typeof value === 'number' ? value.toLocaleString('en-GB', { maximumFractionDigits: 6 }) : value}{String(raw).startsWith('=') && <span className="formula-corner" aria-label="Calculated value"/>}</button></td>;
              })}</tr>)}{Array.from({ length: Math.max(0, 12 - rows.length) }, (_, index) => <tr className="blank-row" key={`blank-${index}`} aria-hidden="true"><th className="row-number">{query ? '' : sheet.rows.length + index + 2}</th>{sheet.columns.map(column => <td key={column.key}/>)}</tr>)}</tbody>
            </table>
            {rows.length === 0 && <div className="grid-empty">{query ? <>No rows match “{query}”. <button onClick={() => setQuery('')}>Clear search</button></> : <>This worksheet is empty.{canEdit && <button onClick={() => openEditor('row')}>Add the first row</button>}</>}</div>}
          </div>
          <nav className="sheet-tabs" aria-label="Worksheets"><span className="tabs-grid"><Icon name="grid"/></span>{workbook?.sheets.map(item => <button className={sheetId === item.id ? 'active-sheet' : ''} aria-current={sheetId === item.id ? 'page' : undefined} onClick={() => changeSheet(item.id)} key={item.id}>{item.readOnly && <span className="sheet-lock" aria-label="Read only">▧</span>}{item.name}</button>)}</nav>
        </>}
      </section>
      {showHistory && <aside className="history-panel" aria-label="Review history"><div className="panel-heading"><div><h2>Changes</h2><p>Review the working copy’s history</p></div><button className="icon-button" aria-label="Close changes" onClick={() => setShowHistory(false)}><Icon name="close"/></button></div><div className="history-list">{historyLoading ? <p className="muted" role="status">Loading changes…</p> : historyError ? <p role="alert" className="inline-error">{historyError}</p> : history.length === 0 ? <div className="history-empty"><Icon name="history"/><h3>No changes yet</h3><p>Saved edits will appear here with their reason and supporting evidence.</p></div> : [...history].sort((a, b) => b.revision - a.revision).map(change => <article className="change-card" key={change.id}><div className="change-meta"><strong>{change.actor}</strong><span>r{change.revision}</span></div><div className="change-location">{workbook?.sheets.find(item => item.id === change.sheetId)?.name || change.sheetId} · {change.column || 'New row'}</div><div className="change-values"><span className="previous-value">{readable(change.before)}</span><span aria-hidden="true">→</span><span>{readable(change.after)}</span></div><p>{change.reason}</p><div className="change-evidence"><strong>Evidence</strong><span>{change.evidence || 'No evidence recorded'}</span></div><time dateTime={change.at}>{new Date(change.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</time></article>)}</div></aside>}
    </div>
    <footer className="statusbar"><span><span className="status-dot"/>{loading ? 'Loading' : original || sheet?.readOnly ? 'Read only' : 'Ready'}</span><span>{sheet ? `${rows.length} of ${sheet.rows.length} rows` : 'No worksheet'}</span><span className="status-spacer"/><span>{!original && changedCells.size > 0 && <><span className="change-key"/>Changed cells</>}</span><span>{workbook ? `Revision ${workbook.revision}` : ''}</span><span>100%</span></footer>

    {editor && <dialog ref={dialogRef} className="edit-dialog" onCancel={event => { event.preventDefault(); closeEditor(); }}><form onSubmit={save}><div className="dialog-heading"><div><div className="eyebrow">WORKING COPY · HUMAN REVIEW</div><h2>{editor.kind === 'cell' ? `Edit ${address}` : `Add row to ${sheet?.name}`}</h2></div><button type="button" className="icon-button" aria-label="Cancel edit" disabled={saving} onClick={closeEditor}><Icon name="close"/></button></div><div className="dialog-fields">{(editor.kind === 'row' ? sheet?.columns : sheet?.columns.filter(column => column.key === editor.column))?.map((column, index) => <label key={column.key}>{column.label}<input autoFocus={index === 0} value={editor.values[column.key] || ''} onChange={event => setEditor({ ...editor, values: { ...editor.values, [column.key]: event.target.value } })} placeholder={column.type === 'number' ? 'Value or =formula' : 'Enter a value'} disabled={saving}/></label>)}<label>Reason for this change<textarea required value={reason} onChange={event => setReason(event.target.value)} placeholder="What changed, and why?" disabled={saving}/></label><label>Supporting evidence<textarea required value={evidence} onChange={event => setEvidence(event.target.value)} placeholder="Source, reference, or calculation supporting the change" disabled={saving}/></label>{saveError && <p role="alert" className="inline-error">{saveError}</p>}</div><div className="dialog-footer"><span>Saved edits appear in Changes.</span><button type="button" className="button" disabled={saving} onClick={closeEditor}>Cancel</button><button className="button primary" type="submit" disabled={saving || !reason.trim() || !evidence.trim()}>{saving ? 'Saving…' : 'Save change'}</button></div></form></dialog>}
  </main>;
}
