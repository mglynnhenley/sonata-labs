import Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ExcelWorkbook, ExcelChange } from '@sonata/core';
import { computeWorkbook } from './formulas';

export class WorkbookError extends Error { constructor(message: string, public status = 400) { super(message); } }
function bad(message: string): never { throw new WorkbookError(message); }
export const DATA_DIR = path.resolve(process.env.EXCEL_DATA_DIR || path.join(process.cwd(), 'data'));
const working = path.join(DATA_DIR, 'working.db');
const snapshot = path.join(DATA_DIR, 'snapshot.db');
const state = globalThis as unknown as { __excelDb?: Database.Database; __excelSession?: string };
const auditSchema = `CREATE TABLE IF NOT EXISTS audit.sessions (id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,note TEXT);
CREATE TABLE IF NOT EXISTS audit.action_log (id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,ts INTEGER NOT NULL,method TEXT NOT NULL,endpoint TEXT NOT NULL,action_type TEXT,target_type TEXT,target_id TEXT,request_json TEXT,response_code INTEGER,summary TEXT);`;
export function db(): Database.Database {
  if (!state.__excelDb) {
    mkdirSync(DATA_DIR, {recursive:true});
    const conn = new Database(working);
    conn.pragma('journal_mode = DELETE'); conn.pragma('busy_timeout = 5000');
    conn.exec(readFileSync(path.join(process.cwd(),'db/schema.sql'),'utf8'));
    conn.prepare('ATTACH DATABASE ? AS audit').run(path.join(DATA_DIR,'audit.db'));
    conn.exec(auditSchema);
    state.__excelDb=conn;
    newSession('opened workbook workspace');
    if (!existsSync(snapshot)) copyFileSync(working,snapshot);
  }
  return state.__excelDb;
}
function newSession(note:string) {
  state.__excelSession=randomUUID();
  state.__excelDb!.prepare('INSERT INTO audit.sessions VALUES (?,?,?)').run(state.__excelSession,Date.now(),note);
}
export function closeDb() { state.__excelDb?.close();state.__excelDb=undefined; }
const object = (value:unknown): Record<string,unknown> => value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : bad('Expected an object.');
const text = (value:unknown,label:string,max=2000): string => typeof value==='string' && value.trim() && value.length<=max ? value : bad(`${label} must be nonempty text (up to ${max} characters).`);
const identifier = (v:unknown): string => {const s=text(v,'Identifier',120);if(['__proto__','constructor','prototype'].includes(s))bad('Reserved identifier.');return s;};
function unique(items:string[],label:string) {if(new Set(items).size!==items.length)bad(`Duplicate ${label}.`);}
function validateCell(value:unknown,type:unknown) {
  if (typeof value!=='string' && (typeof value!=='number' || !Number.isFinite(value))) bad('A cell must contain text or a finite number.');
  if(typeof value==='string' && value.length>10000)bad('Cell exceeds 10000 characters.');
  if(type==='text' && typeof value==='number')bad('Text columns require strings, preserving identifiers and leading zeros.');
  if(type==='number' && typeof value==='string' && value!=='' && !value.startsWith('='))bad('Number columns require a number, blank, or formula.');
}
export function validateWorkbook(value:unknown): ExcelWorkbook {
  const w=object(value);identifier(w.id);text(w.title,'Workbook title',200);
  if(!Number.isSafeInteger(w.revision) || Number(w.revision)<1)bad('Revision must be a positive integer.');
  if(!Array.isArray(w.sheets) || !w.sheets.length || w.sheets.length>30)bad('A workbook needs 1–30 sheets.');
  unique(w.sheets.map(s=>identifier(object(s).id)),'sheet ID');
  unique(w.sheets.map(s=>text(object(s).name,'Sheet name',100)),'sheet name');
  let cells=0;
  for(const raw of w.sheets) {
    const s=object(raw);
    if(s.readOnly!==undefined && typeof s.readOnly!=='boolean')bad('readOnly must be boolean.');
    if(!Array.isArray(s.columns)||!s.columns.length||s.columns.length>100)bad('A sheet needs 1–100 columns.');
    const columns=s.columns.map(c=>object(c));unique(columns.map(c=>identifier(c.key)),'column key');
    for(const c of columns){text(c.label,'Column label',200);if(!['text','number'].includes(String(c.type)))bad('Column type must be text or number.');}
    if(!Array.isArray(s.rows)||s.rows.length>10000)bad('A sheet supports up to 10000 rows.');
    unique(s.rows.map(r=>identifier(object(r).id)),'row ID');
    for(const rawRow of s.rows){const row=object(rawRow),values=object(row.values);for(const [key,v] of Object.entries(values)){const col=columns.find(c=>c.key===key);if(!col)bad(`Unknown column ${key}.`);validateCell(v,col.type);}}
    cells+=s.rows.length*columns.length;
  }
  if(cells>30000)bad('This workbook exceeds the pilot limit of 30000 cells.');
  return JSON.parse(JSON.stringify(w)) as ExcelWorkbook;
}
export function listWorkbooks() {return db().prepare('SELECT id,title,revision FROM workbooks ORDER BY title,id').all();}
export function getWorkbook(id:string,original=false): ExcelWorkbook {
  const row=db().prepare('SELECT original_json,working_json FROM workbooks WHERE id=?').get(id) as {original_json:string;working_json:string}|undefined;
  if(!row)throw new WorkbookError('Workbook not found.',404);
  return JSON.parse(original?row.original_json:row.working_json);
}
export function viewWorkbook(id:string,original=false) {const workbook=getWorkbook(id,original);return {workbook,computed:computeWorkbook(workbook)};}
export function history(id?:string): ExcelChange[] {
  const rows=db().prepare(`SELECT * FROM changes ${id?'WHERE workbook_id=?':''} ORDER BY id`).all(...(id?[id]:[])) as Array<Record<string,unknown>>;
  return rows.map(r=>({id:Number(r.id),workbookId:String(r.workbook_id),revision:Number(r.revision),actor:String(r.actor),at:String(r.at),sheetId:String(r.sheet_id),rowId:String(r.row_id),column:String(r.column_key),before:JSON.parse(String(r.before_json)),after:JSON.parse(String(r.after_json)),reason:String(r.reason),evidence:String(r.evidence)}));
}
export function seedWorkbooks(input:unknown,promote=true) {
  if(!Array.isArray(input)||input.length>30)bad('workbooks must be an array of up to 30 workbooks.');
  const books=input.map(validateWorkbook);unique(books.map(w=>w.id),'workbook ID');
  const conn=db();
  conn.transaction(()=>{
    conn.exec('DELETE FROM changes; DELETE FROM workbooks;');
    const insert=conn.prepare('INSERT INTO workbooks VALUES (?,?,?,?,?)');
    for(const w of books){const json=JSON.stringify(w);insert.run(w.id,w.title,w.revision,json,json);}
  })();
  newSession('world seeded; supplied workbook versions retained');
  // No agent audit rows for world setup. DELETE journalling leaves a complete file.
  if(promote)copyFileSync(working,snapshot);
  return {workbooks:books.length,rows:books.reduce((n,w)=>n+w.sheets.reduce((m,s)=>m+s.rows.length,0),0)};
}
export function resetWorkbooks() {
  db();closeDb();copyFileSync(snapshot,working);db();newSession('reset to supplied snapshot');
  return {workbooks:listWorkbooks().length};
}
export function mutate(id:string,input:unknown,actor:'agent'|'human',addRow=false) {
  const body=object(input),reason=text(body.reason,'Reason'),evidence=text(body.evidence,'Evidence/source reference');
  db().transaction(()=>{
    const w=getWorkbook(id);
    if(body.revision!==w.revision)throw new WorkbookError('This workbook changed. Reload it before editing; your changes were not applied.',409);
    const edits:Array<{sheetId:string;rowId:string;column:string;before:string|number|null;after:string|number}>=[];
    if(addRow) {
      const sheet=w.sheets.find(s=>s.id===body.sheetId);if(!sheet)bad('Sheet not found.');if(sheet.readOnly)bad('This source sheet is read-only.');
      const values=object(body.values);const rowId=`row-${randomUUID()}`;
      for(const col of sheet.columns) {const v=values[col.key]??'';validateCell(v,col.type);edits.push({sheetId:sheet.id,rowId,column:col.key,before:null,after:v as string|number});}
      for(const key of Object.keys(values))if(!sheet.columns.some(c=>c.key===key))bad(`Unknown column ${key}.`);
      sheet.rows.push({id:rowId,values:Object.fromEntries(edits.map(e=>[e.column,e.after]))});
    } else {
      if(!Array.isArray(body.changes)||!body.changes.length||body.changes.length>2000)bad('Provide 1–2000 cell changes.');
      const seen=new Set<string>();
      for(const item of body.changes) {
        const change=object(item);const sheet=w.sheets.find(s=>s.id===change.sheetId);if(!sheet)bad('Sheet not found.');if(sheet.readOnly)bad('This source sheet is read-only.');
        const row=sheet.rows.find(r=>r.id===change.rowId),col=sheet.columns.find(c=>c.key===change.column);if(!row||!col)bad('Row or column not found.');
        const key=JSON.stringify([sheet.id,row.id,col.key]);if(seen.has(key))bad('Duplicate cell in the update.');seen.add(key);
        validateCell(change.value,col.type);const before=row.values[col.key]??'';if(before===change.value)continue;
        row.values[col.key]=change.value as string|number;
        edits.push({sheetId:sheet.id,rowId:row.id,column:col.key,before,after:change.value as string|number});
      }
    }
    if(!edits.length)return;
    w.revision++;validateWorkbook(w);
    const at=new Date().toISOString();
    const insert=db().prepare('INSERT INTO changes (workbook_id,revision,actor,at,sheet_id,row_id,column_key,before_json,after_json,reason,evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for(const e of edits)insert.run(id,w.revision,actor,at,e.sheetId,e.rowId,e.column,JSON.stringify(e.before),JSON.stringify(e.after),reason,evidence);
    db().prepare('UPDATE workbooks SET revision=?,working_json=? WHERE id=?').run(w.revision,JSON.stringify(w),id);
    if(actor==='agent')db().prepare('INSERT INTO audit.action_log (session_id,ts,method,endpoint,action_type,target_type,target_id,request_json,response_code,summary) VALUES (?,?,?,?,?,?,?,?,?,?)').run(state.__excelSession,Date.now(),addRow?'POST':'PATCH',`/api/workbooks/${id}/${addRow?'rows':'cells'}`,addRow?'addRow':'updateCells','workbook',id,JSON.stringify(body),200,`${addRow?'Added row':'Updated '+edits.length+' cells'} in ${w.title} at revision ${w.revision}: ${edits.map(e=>`${e.sheetId}/${e.rowId}/${e.column}: ${JSON.stringify(e.before)} → ${JSON.stringify(e.after)}`).join('; ')}. Reason: ${reason}. Evidence: ${evidence}`);
  })();
  return viewWorkbook(id);
}
export function activity(sinceId:number) {return db().prepare('SELECT * FROM audit.action_log WHERE id>? ORDER BY id').all(sinceId);}
export function snapshotWorkbooks() {return {twin:'excel',capturedAt:Date.now(),workbooks:(listWorkbooks() as {id:string}[]).map(w=>getWorkbook(w.id)),changes:history()};}
export function csvExport(id:string,sheetId:string,original=false) {
  const {workbook,computed}=viewWorkbook(id,original);const sheet=workbook.sheets.find(s=>s.id===sheetId);if(!sheet)throw new WorkbookError('Sheet not found.',404);
  // CSV is a values-only view, never the editable workbook or its type metadata.
  const quote=(value:string|number)=>'"'+String(value).replaceAll('"','""')+'"';
  return [sheet.columns.map(c=>quote(c.label)).join(','),...sheet.rows.map(r=>sheet.columns.map(c=>quote(computed[sheet.id][r.id][c.key]??'')).join(','))].join('\r\n')+'\r\n';
}
