const API = 'https://marketplace-api.wildberries.ru';
const checks = [
  ['warehouses', '/api/v3/warehouses'],
  ['new_orders', '/api/v3/orders/new'],
  ['supplies', '/api/v3/supplies?limit=100&next=0'],
  ['pass_offices', '/api/v3/passes/offices']
];
function summary(name, value) {
  if (name === 'warehouses' && Array.isArray(value)) return { count:value.length, items:value.map(x=>({id:x.id,name:x.name,officeId:x.officeId})) };
  if (name === 'new_orders') return { count:Array.isArray(value?.orders)?value.orders.length:null, warehouseIds:[...new Set((value?.orders||[]).map(x=>x.warehouseId).filter(Boolean))] };
  if (name === 'supplies') return { count:Array.isArray(value?.supplies)?value.supplies.length:null, statusCounts:(value?.supplies||[]).reduce((a,x)=>(a[String(x.status||'unknown')]=(a[String(x.status||'unknown')]||0)+1,a),{}) };
  if (name === 'pass_offices') { const a=Array.isArray(value)?value:[]; return { count:a.length, caucasusMatches:a.filter(x=>/кавказ|kavkaz/i.test(`${x.name||''} ${x.address||''}`)).map(x=>({id:x.id,name:x.name,address:x.address})) }; }
  return {shape:Array.isArray(value)?'array':typeof value};
}
async function diagnose(env) {
  const output={at:new Date().toISOString(),mode:'READ_ONLY',target:'Кавказский бульвар',checks:{}};
  if (!env.WB_API_TOKEN) return {...output,error:'WB_API_TOKEN secret not configured'};
  for(const [name,path] of checks) {
    try {
      const response=await fetch(API+path,{headers:{Authorization:env.WB_API_TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
      const body=await response.text(); let parsed; try{parsed=JSON.parse(body)}catch{parsed=null}
      output.checks[name]={http:response.status,ok:response.ok,...(response.ok?summary(name,parsed):{error:response.status===401?'unauthorized':response.status===403?'forbidden':response.status===429?'rate_limited':'request_failed'})};
    } catch(e){output.checks[name]={ok:false,error:'network_or_timeout'};}
  }
  return output;
}
export default {
  async fetch(request,env){
    const url=new URL(request.url);
    if(request.method==='GET' && (url.pathname==='/' || url.pathname==='/health')) return Response.json({ok:true,service:'wb-fbs-automation',version:'0.1.1',mode:'READ_ONLY',next:'configure ADMIN_KEY and check /diagnostics'});
    if(url.pathname!=='/diagnostics'||request.method!=='GET') return new Response('Not found',{status:404});
    if(!env.ADMIN_KEY) return Response.json({error:'ADMIN_KEY not configured'},{status:503});
    const provided=request.headers.get('X-Admin-Key');
    if(!provided||provided!==env.ADMIN_KEY) return new Response('Unauthorized',{status:401});
    return Response.json(await diagnose(env),{headers:{'Cache-Control':'no-store'}});
  },
  async scheduled(_event,env){console.log(JSON.stringify({service:'wb-fbs-automation',mode:'READ_ONLY',at:new Date().toISOString(),configured:!!env.WB_API_TOKEN}));}
};