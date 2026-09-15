import { describe,it,expect } from 'vitest';
import type { ExcelWorkbook } from '@sonata/core';
import { computeWorkbook } from '../src/lib/formulas';
const book=(formula:string):ExcelWorkbook=>({id:'b',title:'Reporting',revision:1,sheets:[
{id:'investors',name:'Investors',columns:[{key:'id',label:'Investor ID',type:'text'},{key:'amount',label:'Amount',type:'number'}],rows:[{id:'00101',values:{id:'00101',amount:100}},{id:'00102',values:{id:'00102',amount:200}}]},
{id:'totals',name:'Totals',columns:[{key:'result',label:'Result',type:'number'}],rows:[{id:'total',values:{result:formula}}]}
]});
describe('workbook calculations',()=>{
 it.each([
  ['=SUM(Investors!B2:B3)',300],['=(10+5)*2-4/2',28],['=COUNT(Investors!A2:B3)',2],
  ['=AVERAGE(Investors!B2:B3)',150],['=MIN(Investors!B2:B3)',100],['=MAX(Investors!B2:B3)',200],
  ['=A2','#CYCLE!'],['=Z999','#REF!'],['=2/0','#DIV/0!'],['=process.exit(1)','#NAME?'],['=SUM(B2:B1000000)','#REF!'],
 ])('evaluates %s or reports the unsupported/error state',(formula,result)=>{
  expect(computeWorkbook(book(formula)).totals.total.result).toBe(result);
 });
 it('recalculates from current cells without altering string identifiers',()=>{
  const w=book('=SUM(Investors!B2:B3)');w.sheets[0].rows[0].values.amount=150;
  expect(computeWorkbook(w).totals.total.result).toBe(350);
  expect(w.sheets[0].rows[0].values.id).toBe('00101');
 });
});
