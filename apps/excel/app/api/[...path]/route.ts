import { activity,csvExport,history,listWorkbooks,mutate,resetWorkbooks,seedWorkbooks,snapshotWorkbooks,viewWorkbook,WorkbookError } from '@/lib/store';
import { authorizedControlRequest } from '@sonata/core/controlAuth';
import { allowedBrowserOrigin } from '@sonata/core/browserOrigin';
export const dynamic='force-dynamic';
export const runtime='nodejs';
async function dispatch(req:Request,{params}:{params:Promise<{path:string[]}>}) {
  try {
    const url=new URL(req.url);let {path}=await params;const method=req.method;
    if(path.join('/')==='health' && method==='GET')return Response.json({status:'ok',workbooks:listWorkbooks().length});
    const control=path[0]==='sandbox'||path[0]==='activity';
    if(control&&!authorizedControlRequest(req))return Response.json({error:'Control token required.'},{status:401});
    const browser=path[0]==='ui';
    if(browser) {
      if(!allowedBrowserOrigin(req))return Response.json({error:'Open the workbook app directly.'},{status:403});
      path=path.slice(1);
      if(path[0]!=='workbooks')return Response.json({error:'Unknown workbook operation.'},{status:404});
    } else if(!control&&req.headers.get('authorization')!==`Bearer ${process.env.SANDBOX_TOKEN||'sandbox-token'}`)return Response.json({error:'Bearer token required.'},{status:401});
    const route=path.join('/');
    if(route==='workbooks'&&method==='GET')return Response.json({workbooks:listWorkbooks()});
    if(path[0]==='workbooks'&&path[1]) {
      const id=path[1],original=url.searchParams.get('original')==='1';
      if(path.length===2&&method==='GET')return Response.json(viewWorkbook(id,original));
      if(path.length===3&&path[2]==='history'&&method==='GET'){viewWorkbook(id);return Response.json({changes:history(id)});}
      if(path.length===3&&path[2]==='export'&&method==='GET') {
        return new Response(csvExport(id,url.searchParams.get('sheetId')||'',original),{headers:{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="worksheet-values.csv"','cache-control':'no-store'}});
      }
      if(path.length===3&&((path[2]==='cells'&&method==='PATCH')||(path[2]==='rows'&&method==='POST'))) {
        const view=mutate(id,await req.json(),browser?'human':'agent',path[2]==='rows');
        // The browser re-renders from the whole workbook. An agent gets the
        // receipt: a full workbook per edit (~60k characters) is what filled a
        // model's context by mid-morning. It reads the workbook when it wants it.
        if(browser)return Response.json(view);
        const {id:workbookId,title,revision}=view.workbook;
        const changes=history(workbookId).filter(c=>c.revision===revision).map(({sheetId,rowId,column,before,after})=>({sheetId,rowId,column,before,after}));
        return Response.json({applied:true,workbook:{id:workbookId,title,revision},changes,note:'Applied at this revision. Use read_workbook for current values and computed formulas; the next edit needs this revision number.'});
      }
    }
    if(!browser) {
      if(route==='activity'&&method==='GET') {
        const since=Number(url.searchParams.get('sinceId')||url.searchParams.get('since')||0);
        if(!Number.isSafeInteger(since)||since<0)throw new WorkbookError('Invalid audit cursor.');
        return Response.json({actions:activity(since)});
      }
      if(route==='sandbox/snapshot'&&method==='GET')return Response.json(snapshotWorkbooks());
      if(route==='sandbox/reset'&&method==='POST')return Response.json({ok:true,...resetWorkbooks()});
      if(route==='sandbox/seed'&&method==='POST') {
        const body=await req.json();
        if(body?.twin!=='excel'||!body.seed)throw new WorkbookError('Expected {twin:"excel",seed:{workbooks:[...]}}.');
        const counts=seedWorkbooks(body.seed.workbooks,body.seed.promoteToSnapshot!==false);
        return Response.json({ok:true,counts,...counts});
      }
    }
    return Response.json({error:'Unknown workbook operation.'},{status:404});
  } catch(error) {
    const status=error instanceof WorkbookError?error.status:error instanceof SyntaxError?400:500;
    const message=error instanceof Error?error.message:String(error);
    return Response.json({error:message,message},{status});
  }
}
export const GET=dispatch;
export const PATCH=dispatch;
export const POST=dispatch;
