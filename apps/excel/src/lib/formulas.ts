import type { ExcelWorkbook } from '@sonata/core';

type Value = string | number;
type Operand = Value | Value[];
class FormulaError extends Error {}
const fail = (message: string): never => { throw new FormulaError(message); };
export function computeWorkbook(workbook: ExcelWorkbook): Record<string, Record<string, Record<string, Value>>> {
  const cache = new Map<string, Value>();
  const active = new Set<string>();
  function cell(sheetId: string, address: string): Value {
    const sheet = workbook.sheets.find(s => s.id === sheetId || s.name === sheetId);
    const match = /^\$?([A-Z]+)\$?(\d+)$/i.exec(address);
    if (!sheet || !match) return fail('#REF!');
    const col = [...match[1].toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const row = Number(match[2]) - 2;
    if (!sheet.columns[col] || row < -1 || row >= sheet.rows.length) return fail('#REF!');
    if (row === -1) return sheet.columns[col].label;
    const value = sheet.rows[row].values[sheet.columns[col].key] ?? '';
    const key = `${sheet.id}/${row}/${col}`;
    if (cache.has(key)) return cache.get(key)!;
    if (active.has(key)) return fail('#CYCLE!');
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    if (active.size > 100) return fail('#LIMIT!');
    active.add(key);
    let result: Value;
    try { result = evaluate(value.slice(1), sheet.id); }
    catch (error) { result = error instanceof FormulaError ? error.message : '#VALUE!'; }
    active.delete(key); cache.set(key, result); return result;
  }
  function evaluate(source: string, sheetId: string): Value {
    if (source.length > 2000) return fail('#LIMIT!');
    const tokens: string[] = [];
    let remainder = source.trim();
    while (remainder) {
      const m = /^(?:'(?:[^']|'')*'|\$?[A-Za-z_][A-Za-z_0-9.$]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[()+\-*/,:!])/.exec(remainder);
      if (!m) return fail('#NAME?');
      tokens.push(m[0]); remainder = remainder.slice(m[0].length).trimStart();
    }
    let at = 0;
    const number = (x: Operand): number => {
      if (Array.isArray(x)) return fail('#VALUE!');
      if (typeof x === 'string' && x.startsWith('#')) return fail(x);
      const n = x === '' ? 0 : Number(x);
      return Number.isFinite(n) ? n : fail('#VALUE!');
    };
    const take = (token: string) => tokens[at] === token ? (at++, true) : false;
    function primary(): Operand {
      if (take('+')) return number(primary());
      if (take('-')) return -number(primary());
      if (take('(')) { const x = expression(); if (!take(')')) fail('#VALUE!'); return x; }
      const token = tokens[at++];
      if (!token) return fail('#VALUE!');
      if (/^(?:\d|\.)/.test(token)) return Number(token);
      if (take('(')) {
        const args: Operand[] = [];
        if (!take(')')) {
          do { args.push(expression()); } while (take(','));
          if (!take(')')) fail('#VALUE!');
        }
        const all = args.flat();
        const error = all.find(v => typeof v === 'string' && v.startsWith('#'));
        if (error) return fail(String(error));
        const nums = all.filter((v): v is number => typeof v === 'number');
        switch (token.toUpperCase()) {
          case 'SUM': return nums.reduce((n,v) => n + v, 0);
          case 'COUNT': return nums.length;
          case 'AVERAGE': return nums.length ? nums.reduce((n,v) => n + v, 0) / nums.length : fail('#DIV/0!');
          case 'MIN': return nums.length ? Math.min(...nums) : 0;
          case 'MAX': return nums.length ? Math.max(...nums) : 0;
          default: return fail('#NAME?');
        }
      }
      let target = sheetId, address = token;
      if (take('!')) { target = token.replace(/^'|'$/g, '').replaceAll("''", "'"); address = tokens[at++]; }
      if (!address) return fail('#REF!');
      if (!take(':')) return cell(target, address);
      const end = tokens[at++];
      const startMatch = /^\$?([A-Z]+)\$?(\d+)$/i.exec(address);
      const endMatch = /^\$?([A-Z]+)\$?(\d+)$/i.exec(end ?? '');
      if (!startMatch || !endMatch) return fail('#REF!');
      const index = (letters: string) => [...letters.toUpperCase()].reduce((n,c) => n * 26 + c.charCodeAt(0) - 64, 0);
      const c1=index(startMatch[1]), c2=index(endMatch[1]), r1=Number(startMatch[2]), r2=Number(endMatch[2]);
      if (c2<c1 || r2<r1 || (c2-c1+1)*(r2-r1+1)>10000) return fail('#REF!');
      const values: Value[] = [];
      for (let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++) values.push(cell(target, `${columnLetter(c-1)}${r}`));
      return values;
    }
    function product(): Operand {
      let x=primary();
      while (tokens[at]==='*' || tokens[at]==='/') {
        const op=tokens[at++], y=number(primary());
        x=op==='*' ? number(x)*y : y===0 ? fail('#DIV/0!') : number(x)/y;
      }
      return x;
    }
    function expression(): Operand {
      let x=product();
      while(tokens[at]==='+' || tokens[at]==='-') {
        const op=tokens[at++], y=number(product()); x=op==='+' ? number(x)+y : number(x)-y;
      }
      return x;
    }
    const result = expression();
    if (at!==tokens.length || Array.isArray(result)) return fail('#VALUE!');
    if (typeof result==='number' && !Number.isFinite(result)) return fail('#NUM!');
    return result;
  }
  return Object.fromEntries(workbook.sheets.map(sheet => [sheet.id, Object.fromEntries(sheet.rows.map((row, r) => [row.id, Object.fromEntries(sheet.columns.map((col,c) => [col.key, cell(sheet.id, `${columnLetter(c)}${r+2}`)]))]))]));
}
export function columnLetter(index: number): string {
  let value=index+1,out='';
  while(value>0){value--;out=String.fromCharCode(65+value%26)+out;value=Math.floor(value/26);}
  return out;
}
