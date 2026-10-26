// One-shot, bounded, read-only audit of historic FBS assembly orders and supplies.
// Never writes to WB; private DO state contains only supply/order IDs and product identifiers.
const API='https://marketplace-api.wildberries.ru';
const KEY='ff_reconcile_20261026_v1';
const START='2026-08-08', END='2026-10-27', SKU='brcutt1green';
const MAX_PAGES=12, MAX_SUPPLIES=1200, BATCH=8;
const now=()=>new Date().toISOString();
const day=v=>String(v||'').slice(0,10);
const uniq=xs=>[...new Set(xs)];
const numericId=v=>v===null||v===undefined?'':String(v);
const matches=o=>[o.article,o.supplierArticle,o.vendorCode].some(x=>String(x||'').toLowerCase()===SKU);
async function get(token,path) {
  const r=await fetch(API+path,{method:'GET',headers:{Authorization:token,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
  if(!r.ok){const code=r.status;await r.body?.cancel();const e=new Error('wb_http_'+code);e.status=code;throw e;}
  return r.json();
}
function fresh(){return {phase:'orders',startedAt:now(),updatedAt:now(),orderNext:0,orderPages:0,orders:[],supplyNext:0,supplyPages:0,supplies:[],supplyIndex:0,assignments:[],unknownSupplyOrderIds:0,totalSupplyOrderIds:0,duplicateSupplyOrderIds:0,failures:0,stopReason:null,earliestOrderDay:null,earliestSupplyDay:null};}
function nextCursor(data,current) {
  const n=data?.next;
  if(n===null||n===undefined||n===''||n===0||n==='0')return null;
  if(!/^[0-9]+$/.test(String(n))||String(n)===String(current))throw new Error('invalid_next_cursor');
  return n;
}
function summarized(st){
  if(!st)return {state:'waiting_for_first_alarm',readOnly:true};
  const matchesAssigned=st.assignments||[];
  const ids=uniq(matchesAssigned.map(x=>x.orderId));
  const supplied=matchesAssigned.filter(x=>x.done===true||x.scanned===true);
  return {
    state:st.phase,readOnly:true,updatedAt:st.updatedAt,startedAt:st.startedAt,
    pages:{orders:st.orderPages,supplies:st.supplyPages},
    foundTargetAssemblyOrders:st.orders?.length||0,
    suppliesFound:st.supplies?.length||0,
    suppliesChecked:st.supplyIndex||0,
    targetOrdersLinkedToSupplies:ids.length,
    targetOrdersInDoneOrScannedSupplies:uniq(supplied.map(x=>x.orderId)).length,
    unknownSupplyOrderIds:st.unknownSupplyOrderIds||0,
    totalSupplyOrderIds:st.totalSupplyOrderIds||0,
    earliestOrderDay:st.earliestOrderDay||null,earliestSupplyDay:st.earliestSupplyDay||null,
    coverageFrom:START,coverageTo:'2026-10-26',
    completeness:st.phase==='complete'?'api_pages_exhausted_not_physical_proof':'not_yet_complete',
    stopReason:st.stopReason||null,
    retryAfter:st.retryAfter||null
  };
}
export async function ffPublicSummary(storage) {
  return summarized(await storage.get(KEY));
}
export async function ffPrivateReport(storage) {
  const st=await storage.get(KEY);
  if(!st)return {state:'not_started'};
  return {...summarized(st),matchedAssignments:st.assignments,unlinkedTargetOrders:(st.orders||[]).filter(o=>!(st.assignments||[]).some(a=>a.orderId===o.id)),errors:st.lastError||null};
}
export async function runFfReconcileStep(storage,token) {
  if(!token)return;
  let st=(await storage.get(KEY))||fresh();
  if(st.phase==='complete'||st.phase==='blocked')return;
  if(st.retryAfter&&Date.parse(st.retryAfter)>Date.now())return;
  try {
    if(st.phase==='orders') {
      const data=await get(token,'/api/v3/orders?limit=100&next='+encodeURIComponent(st.orderNext));
      if(!Array.isArray(data?.orders))throw new Error('orders_shape');
      const seen=new Set(st.orders.map(x=>x.id));
      for(const o of data.orders) {
        if(!matches(o)||day(o.createdAt)<START||day(o.createdAt)>=END)continue;
        const id=numericId(o.id);if(!id||seen.has(id))continue;
        seen.add(id);st.orders.push({id,createdAt:day(o.createdAt),article:String(o.article||o.supplierArticle||''),warehouseId:o.warehouseId??null});
      }
      for(const o of data.orders){const d=day(o.createdAt);if(d&&(!st.earliestOrderDay||d<st.earliestOrderDay))st.earliestOrderDay=d;}
      st.orderPages++;
      const next=nextCursor(data,st.orderNext);
      if(next===null||data.orders.length===0){st.phase='supplies';}
      else if(st.orderPages>=MAX_PAGES){st.phase='blocked';st.stopReason='orders_page_cap_reached';}
      else st.orderNext=next;
    } else if(st.phase==='supplies') {
      const data=await get(token,'/api/v3/supplies?limit=100&next='+encodeURIComponent(st.supplyNext));
      if(!Array.isArray(data?.supplies))throw new Error('supplies_shape');
      const seen=new Set(st.supplies.map(x=>x.id));
      for(const s of data.supplies) {
        const d=day(s.createdAt);if(d&&(!st.earliestSupplyDay||d<st.earliestSupplyDay))st.earliestSupplyDay=d;
        if(d<START||d>=END)continue;
        const id=numericId(s.id);if(!id||seen.has(id))continue;
        seen.add(id);st.supplies.push({id,createdAt:d,done:s.done===true,scanned:!!s.scanDt});
      }
      st.supplyPages++;
      const next=nextCursor(data,st.supplyNext);
      if(next===null||data.supplies.length===0){st.phase='supply_orders';}
      else if(st.supplyPages>=MAX_PAGES||st.supplies.length>=MAX_SUPPLIES){st.phase='blocked';st.stopReason='supplies_page_cap_reached';}
      else st.supplyNext=next;
    } else if(st.phase==='supply_orders') {
      const known=new Set(st.orders.map(x=>x.id));
      const seen=new Set(st.assignments.map(x=>x.orderId));
      for(let n=0;n<BATCH&&st.supplyIndex<st.supplies.length;n++) {
        const supply=st.supplies[st.supplyIndex];
        const data=await get(token,'/api/marketplace/v3/supplies/'+encodeURIComponent(supply.id)+'/order-ids');
        if(!Array.isArray(data?.orderIds))throw new Error('supply_order_ids_shape');
        const ids=uniq(data.orderIds.map(numericId).filter(Boolean));
        st.totalSupplyOrderIds+=ids.length;
        for(const id of ids) {
          if(known.has(id)) {
            if(seen.has(id))st.duplicateSupplyOrderIds++;
            else {st.assignments.push({orderId:id,supplyId:supply.id,createdAt:supply.createdAt,done:supply.done,scanned:supply.scanned});seen.add(id);}
          } else st.unknownSupplyOrderIds++;
        }
        st.supplyIndex++;
        // Avoid bursts against the Marketplace API. No retries inside the batch.
        if(n<BATCH-1&&st.supplyIndex<st.supplies.length)await new Promise(resolve=>setTimeout(resolve,300));
      }
      if(st.supplyIndex>=st.supplies.length){st.phase='complete';st.finishedAt=now();}
    }
    st.failures=0;st.lastError=null;st.retryAfter=null;
  } catch(e) {
    st.failures=(st.failures||0)+1;
    st.lastError=String(e?.message||'unknown_error').slice(0,80);
    const delay=e?.status===429?60:15;
    st.retryAfter=new Date(Date.now()+delay*60000).toISOString();
    if(st.failures>=4){st.phase='blocked';st.stopReason='repeated_'+st.lastError;}
  }
  st.updatedAt=now();
  await storage.put(KEY,st);
}
