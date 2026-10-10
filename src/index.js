import { DurableObject } from 'cloudflare:workers';

// Stores only aggregate diagnostics. Never stores API tokens, order IDs or customer data.
export class DiagnosticHistory extends DurableObject {
  async record(snapshot) {
    const existing=(await this.ctx.storage.get('history')) || [];
    const history=[snapshot,...existing].slice(0,72);
    await this.ctx.storage.put('history',history);
    await this.ctx.storage.put('publicStatus',{
      service:'wb-fbs-automation',
      version:'0.4.0',
      mode:'READ_ONLY',
      lastCheck:snapshot.at,
      healthy:!!snapshot.healthy,
      endpoints:{
        newOrders:snapshot.checks.newOrders?.ok?'ok':'error',
        supplies:snapshot.checks.supplies?.ok?'ok':'error',
        shippingPoint:snapshot.checks.shippingPoint?.ok===true?'confirmed':snapshot.checks.shippingPoint?.ok===false?'error':'not_checked'
      }
    });
  }
  async publicStatus() {
    return (await this.ctx.storage.get('publicStatus')) || null;
  }
  async recentHistory() {
    return (await this.ctx.storage.get('history')) || [];
  }
}
function historyStore(env) {
  return env.DIAG_HISTORY.get(env.DIAG_HISTORY.idFromName('wb-fbs-diagnostics-v1'));
}

// WB FBS Automation v0.4.0 — scheduled read-only diagnostics, safe durable history.
const API = 'https://marketplace-api.wildberries.ru';
const TARGET = 'Кавказский бульвар';
const CHECKS = [
  ['warehouses', '/api/v3/warehouses'],
  ['new_orders', '/api/v3/orders/new'],
  ['supplies', '/api/v3/supplies?limit=100&next=0'],
  ['pass_offices', '/api/v3/passes/offices'],
  ['shipping_points_cargo_1', '/api/marketplace/v3/fbs/shipping-points?city=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0&cargoType=1'],
  ['shipping_points_cargo_2', '/api/marketplace/v3/fbs/shipping-points?city=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0&cargoType=2'],
  ['shipping_points_cargo_3', '/api/marketplace/v3/fbs/shipping-points?city=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0&cargoType=3']
];
const matchTarget = value => /кавказ|kavkaz/i.test(String(value || ''));
const safePoint = x => ({
  id: x.id ?? x.officeId ?? x.shippingPointId ?? null,
  name: x.name ?? x.officeName ?? x.title ?? null,
  address: x.address ?? x.fullAddress ?? null,
  officeType: x.officeType ?? x.type ?? null,
  cargoType: x.cargoType ?? null,
  fulfillment: x.fulfillment ?? null
});
function pointRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  for (const key of ['points','shippingPoints','offices','items','data','result']) {
    if (Array.isArray(data[key])) return data[key];
    if (data[key] && typeof data[key] === 'object') {
      const nested = pointRows(data[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}
function summarize(name, data) {
  if (name === 'warehouses') {
    const rows = Array.isArray(data) ? data : [];
    return {count:rows.length,items:rows.map(x=>({id:x.id,name:x.name,officeId:x.officeId}))};
  }
  if (name === 'new_orders') {
    const rows = Array.isArray(data?.orders) ? data.orders : [];
    return {count:rows.length,warehouseIds:[...new Set(rows.map(x=>x.warehouseId).filter(x=>x!=null))],officeIds:[...new Set(rows.map(x=>x.officeId ?? x.officeID).filter(x=>x!=null))]};
  }
  if (name === 'supplies') {
    const rows = Array.isArray(data?.supplies) ? data.supplies : [];
    const countBy = key => rows.reduce((acc,x)=>{const k=String(x[key] ?? 'missing');acc[k]=(acc[k]||0)+1;return acc;},{});
    const recent = [...rows].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,5);
    return {
      count:rows.length,hasMore:!!data?.next,
      doneCounts:countBy('done'),
      shippingTypeCounts:countBy('shippingType'),
      shippingDatePresent:rows.filter(x=>!!x.shippingDt).length,
      shippingPointPresent:rows.filter(x=>x.shippingPointId!=null).length,
      destinationOfficeIds:[...new Set(rows.map(x=>x.destinationOfficeId).filter(x=>x!=null))],
      recentSample:recent.map(x=>({
        createdAt:x.createdAt ?? null,
        done:x.done ?? null,
        scanRecorded:!!x.scanDt,
        destinationOfficeId:x.destinationOfficeId ?? null,
        shippingType:x.shippingType ?? null,
        shippingDt:x.shippingDt ?? null,
        shippingPointId:x.shippingPointId ?? null,
        cargoType:x.cargoType ?? null
      }))
    };
  }
  if (name === 'pass_offices' || name.startsWith('shipping_points_')) {
    const rows = pointRows(data);
    return {
      count:rows.length,
      matches:rows.filter(x=>matchTarget([x.name,x.officeName,x.title,x.address,x.fullAddress].join(' '))).slice(0,15).map(safePoint),
      responseShape: Array.isArray(data) ? 'array' : (data && typeof data==='object' ? Object.keys(data).slice(0,10) : typeof data)
    };
  }
  return {shape:typeof data};
}
// Focused audit of the dates already stored by WB for historical supplies.
// This is NOT evidence of how the seller cabinet populated those dates.
async function auditShippingDates(env) {
  const result={at:new Date().toISOString(),version:'0.3.0',mode:'READ_ONLY',note:'Historical fields only; no supply changes'};
  if (!env.WB_API_TOKEN) return {...result,error:'WB_API_TOKEN secret not configured'};
  try {
    const response=await fetch(API+'/api/v3/supplies?limit=100&next=0',{
      method:'GET',headers:{Authorization:env.WB_API_TOKEN,Accept:'application/json'},
      signal:AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      return {...result,http:response.status,error:response.status===429?'rate_limited':'request_failed'};
    }
    const data=await response.json();
    const supplies=Array.isArray(data?.supplies)?data.supplies:[];
    const periodStats=rows=>({
      count:rows.length,
      withShippingDate:rows.filter(x=>!!x.shippingDt).length,
      withoutShippingDate:rows.filter(x=>!x.shippingDt).length,
      withShippingPoint:rows.filter(x=>x.shippingPointId!=null).length,
      toCaucasus:rows.filter(x=>Number(x.shippingPointId)===353731).length,
      selfShipping:rows.filter(x=>x.shippingType==='selfShipping').length,
      scanned:rows.filter(x=>!!x.scanDt).length
    });
    const recent=[...supplies].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,12);
    return {
      ...result,http:response.status,
      note:'Dates stored in WB; manual UI request capture still needed to learn how dates are set',
      returnedCount:supplies.length,hasNextPage:!!data?.next,
      sinceOct1:periodStats(supplies.filter(x=>String(x.createdAt||'')>='2026-10-01')),
      beforeOct1:periodStats(supplies.filter(x=>String(x.createdAt||'')<'2026-10-01')),
      recent:recent.map(x=>({
        createdDay:String(x.createdAt||'').slice(0,10),
        shippingDay:x.shippingDt||null,
        shippingPointId:x.shippingPointId??null,
        shippingType:x.shippingType??null,
        scanned:!!x.scanDt,
        done:x.done??null
      }))
    };
  } catch {
    return {...result,error:'network_or_timeout'};
  }
}
async function runDiagnostics(env) {
  const out = {at:new Date().toISOString(),version:'0.3.0',mode:'READ_ONLY',target:TARGET,checks:{}};
  if (!env.WB_API_TOKEN) return {...out,error:'WB_API_TOKEN secret not configured'};
  for (const [name,path] of CHECKS) {
    try {
      const response=await fetch(API+path,{
        method:'GET',
        headers:{Authorization:env.WB_API_TOKEN,Accept:'application/json'},
        signal:AbortSignal.timeout(12000)
      });
      // Do not log or return raw WB response; it may contain personal or sensitive data.
      let data=null;
      if (response.ok) {
        try { data=await response.json(); } catch { /* invalid JSON */ }
      } else {
        await response.body?.cancel();
      }
      out.checks[name]={
        http:response.status,
        ok:response.ok,
        ...(response.ok ? summarize(name,data) : {
          error: response.status===401?'unauthorized':response.status===403?'forbidden':response.status===429?'rate_limited':'request_failed'
        })
      };
    } catch {
      out.checks[name]={ok:false,error:'network_or_timeout'};
    }
  }
  return out;
}
// Runs automatically in Cloudflare on a cron trigger. GET only, no FBS writes.
async function runScheduledDiagnostics(env) {
  const now=new Date();
  const snapshot={
    at:now.toISOString(),
    version:'0.4.0',
    mode:'READ_ONLY',
    checks:{},
    healthy:false
  };
  if (!env.WB_API_TOKEN) {
    snapshot.checks.configuration={ok:false,error:'token_not_configured'};
    return snapshot;
  }
  async function query(name,path,parse) {
    try {
      const response=await fetch(API+path,{
        method:'GET',
        headers:{Authorization:env.WB_API_TOKEN,Accept:'application/json'},
        signal:AbortSignal.timeout(12000)
      });
      if (!response.ok) {
        await response.body?.cancel();
        snapshot.checks[name]={ok:false,http:response.status};
        return;
      }
      const body=await response.json();
      snapshot.checks[name]={ok:true,http:response.status,...parse(body)};
    } catch {
      snapshot.checks[name]={ok:false,error:'network_or_timeout'};
    }
  }
  await Promise.all([
    query('newOrders','/api/v3/orders/new',data=>({
      count:Array.isArray(data?.orders)?data.orders.length:null
    })),
    query('supplies','/api/v3/supplies?limit=100&next=0',data=>{
      const rows=Array.isArray(data?.supplies)?data.supplies:[];
      const recent=rows.filter(x=>String(x.createdAt||'')>='2026-10-01');
      return {
        count:rows.length,
        hasNextPage:!!data?.next,
        sinceOct1:recent.length,
        sinceOct1WithShippingDate:recent.filter(x=>!!x.shippingDt).length,
        sinceOct1WithShippingPoint:recent.filter(x=>x.shippingPointId!=null).length,
        sinceOct1ToCaucasus:recent.filter(x=>Number(x.shippingPointId)===353731).length
      };
    })
  ]);
  // Validate the target SC once per day; avoid downloading 5,000+ offices hourly.
  if (now.getUTCHours()===0) {
    await query('shippingPoint','/api/marketplace/v3/fbs/shipping-points?city=%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0&cargoType=1',data=>{
      const found=pointRows(data).find(x=>Number(x.id)===353731 && x.officeType==='sc');
      return {confirmed:!!found};
    });
    if (snapshot.checks.shippingPoint?.ok===true && !snapshot.checks.shippingPoint.confirmed) {
      snapshot.checks.shippingPoint.ok=false;
      snapshot.checks.shippingPoint.error='target_sc_not_found';
    }
  }
  snapshot.healthy=!!snapshot.checks.newOrders?.ok && !!snapshot.checks.supplies?.ok &&
    snapshot.checks.shippingPoint?.ok!==false;
  return snapshot;
}
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if (request.method==='GET' && (path==='/' || path==='/health')) {
      return Response.json({ok:true,service:'wb-fbs-automation',version:'0.4.0',mode:'READ_ONLY',scheduled:'hourly'});
    }
    if (request.method==='GET' && path==='/status') {
      if (!env.DIAG_HISTORY) return Response.json({ok:false,error:'history_binding_not_configured'},{status:503});
      const latest=await historyStore(env).publicStatus();
      return Response.json(latest || {service:'wb-fbs-automation',version:'0.4.0',mode:'READ_ONLY',status:'waiting_for_first_scheduled_check'},{
        headers:{'Cache-Control':'no-store'}
      });
    }
    if (!['/diagnostics','/diagnostics/shipping-dates','/diagnostics/history'].includes(path) || request.method!=='GET') return new Response('Not found',{status:404});
    if (!env.ADMIN_KEY) return Response.json({error:'ADMIN_KEY not configured'},{status:503});
    const provided=request.headers.get('X-Admin-Key');
    if (!provided || provided!==env.ADMIN_KEY) return new Response('Unauthorized',{status:401});
    if (path==='/diagnostics/history') {
      if (!env.DIAG_HISTORY) return Response.json({error:'history_binding_not_configured'},{status:503});
      return Response.json({version:'0.4.0',mode:'READ_ONLY',history:await historyStore(env).recentHistory()},{headers:{'Cache-Control':'no-store'}});
    }
    return Response.json(path==='/diagnostics/shipping-dates' ? await auditShippingDates(env) : await runDiagnostics(env),{headers:{'Cache-Control':'no-store'}});
  },
  async scheduled(_event,env,ctx) {
    ctx.waitUntil((async()=>{
      try {
        const snapshot=await runScheduledDiagnostics(env);
        await historyStore(env).record(snapshot);
        console.log(JSON.stringify({event:'scheduled_diagnostics',at:snapshot.at,healthy:snapshot.healthy}));
      } catch {
        console.error(JSON.stringify({event:'scheduled_diagnostics_failed',reason:'internal_error'}));
      }
    })());
  }
};
