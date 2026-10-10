// WB FBS Automation v0.2.0 — read-only diagnostics; no write API calls.
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
async function runDiagnostics(env) {
  const out = {at:new Date().toISOString(),version:'0.2.0',mode:'READ_ONLY',target:TARGET,checks:{}};
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
export default {
  async fetch(request,env) {
    const path=new URL(request.url).pathname;
    if (request.method==='GET' && (path==='/' || path==='/health')) {
      return Response.json({ok:true,service:'wb-fbs-automation',version:'0.2.0',mode:'READ_ONLY'});
    }
    if (path!=='/diagnostics' || request.method!=='GET') return new Response('Not found',{status:404});
    if (!env.ADMIN_KEY) return Response.json({error:'ADMIN_KEY not configured'},{status:503});
    const provided=request.headers.get('X-Admin-Key');
    if (!provided || provided!==env.ADMIN_KEY) return new Response('Unauthorized',{status:401});
    return Response.json(await runDiagnostics(env),{headers:{'Cache-Control':'no-store'}});
  },
  async scheduled(_event,env) {
    // Intentionally no FBS writes or background order processing.
    console.log(JSON.stringify({service:'wb-fbs-automation',version:'0.2.0',mode:'READ_ONLY',configured:!!env.WB_API_TOKEN}));
  }
};
