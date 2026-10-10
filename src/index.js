import { DurableObject } from 'cloudflare:workers';
import { officialPngPdf } from './pdf.js';

// Private durable state: aggregate diagnostics plus order IDs for idempotency. No tokens or buyer details.
export class DiagnosticHistory extends DurableObject {
  async record(snapshot) {
    const existing=(await this.ctx.storage.get('history')) || [];
    const history=[snapshot,...existing].slice(0,72);
    await this.ctx.storage.put('history',history);
    const previousStatus=(await this.ctx.storage.get('publicStatus'))||{};
    await this.ctx.storage.put('publicStatus',{
      ...previousStatus,
      service:'wb-fbs-automation',
      version:'0.11.0',
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
  // Private idempotency ledger: no buyer details, only WB order ID and warehouse ID.
  // Records survive Worker restarts and redeployments.
  async observeOrders(orders, at) {
    const valid=orders.filter(x=>x && (typeof x.id==='number' || typeof x.id==='string'));
    let newlySeen=0;
    await this.ctx.storage.transaction(async tx=>{
      for (const order of valid) {
        const key='order:'+String(order.id);
        const previous=await tx.get(key);
        if (!previous) {
          newlySeen++;
          await tx.put(key,{
            id:String(order.id),
            warehouseId:order.warehouseId??null,
            firstSeenAt:at,
            lastSeenAt:at,
            state:'observed',
            supplyId:null
          });
        } else {
          await tx.put(key,{...previous,lastSeenAt:at});
        }
      }
      const stats=(await tx.get('orderMonitor'))||{totalSeen:0};
      await tx.put('orderMonitor',{
        ...stats,
        totalSeen:(stats.totalSeen||0)+newlySeen,
        lastPoll:at,
        lastPollOk:true,
        lastPollReturned:valid.length,
        lastNewlySeen:newlySeen,
        lastError:null
      });
    });
    const current=(await this.ctx.storage.get('publicStatus'))||{};
    await this.ctx.storage.put('publicStatus',{
      ...current,service:'wb-fbs-automation',version:'0.11.0',
      mode:'READ_ONLY',orderMonitoring:'active',lastOrderPoll:at
    });
    return {newlySeen,seenInPoll:valid.length};
  }
  async recordPollError(at,reason,http=null) {
    const stats=(await this.ctx.storage.get('orderMonitor'))||{totalSeen:0};
    await this.ctx.storage.put('orderMonitor',{
      ...stats,lastPoll:at,lastPollOk:false,lastError:reason,lastHttp:http
    });
    const current=(await this.ctx.storage.get('publicStatus'))||{};
    await this.ctx.storage.put('publicStatus',{
      ...current,service:'wb-fbs-automation',version:'0.11.0',
      mode:'READ_ONLY',orderMonitoring:'error',lastOrderPoll:at
    });
  }
  async orderMonitorSummary() {
    const stats=(await this.ctx.storage.get('orderMonitor'))||{};
    return {version:'0.11.0',mode:'READ_ONLY',...stats};
  }
  // Bootstrap one persistent five-minute alarm without a Cron Trigger.
  async ensureAlarm() {
    const existing=await this.ctx.storage.getAlarm();
    if (existing!==null) return {scheduled:true,nextRun:new Date(existing).toISOString()};
    if (!this.env.WB_API_TOKEN) return {scheduled:false,error:'token_not_configured'};
    const next=Date.now()+60*1000;
    await this.ctx.storage.setAlarm(next);
    return {scheduled:true,nextRun:new Date(next).toISOString()};
  }
  async alarm() {
    const at=new Date().toISOString();
    try {
      if (!this.env.WB_API_TOKEN) {
        await this.recordPollError(at,'token_not_configured');
      } else {
        const response=await fetch(API+'/api/v3/orders/new',{
          method:'GET',
          headers:{Authorization:this.env.WB_API_TOKEN,Accept:'application/json'},
          signal:AbortSignal.timeout(12000)
        });
        if (!response.ok) {
          await response.body?.cancel();
          await this.recordPollError(at,response.status===429?'rate_limited':'wb_api_error',response.status);
        } else {
          const data=await response.json();
          if (!Array.isArray(data?.orders)) {
            await this.recordPollError(at,'unexpected_response_shape',response.status);
          } else {
            await this.observeOrders(data.orders.map(x=>({id:x.id,warehouseId:x.warehouseId})),at);
          }
        }
      }
      // Pair Telegram only until a private recipient is registered; no extra polling afterward.
      try { await this.pairTelegramIfNeeded(); }
      catch { console.error(JSON.stringify({event:'telegram_pairing_poll_failed'})); }
      try { await this.sendTelegramConnectionTestOnce(); }
      catch { console.error(JSON.stringify({event:'telegram_connection_test_failed'})); }
      try { await this.probeDocumentSourcesOnce(); }
      catch { console.error(JSON.stringify({event:'document_source_probe_failed'})); }
      try { await this.probeOrderMetadataOnce(); }
      catch { console.error(JSON.stringify({event:'order_metadata_probe_failed'})); }
      try { await this.probePdfEngineOnce(); }
      catch { console.error(JSON.stringify({event:'pdf_engine_probe_failed'})); }
      const hour=at.slice(0,13);
      if (this.env.WB_API_TOKEN && (await this.ctx.storage.get('lastHourlyBucket'))!==hour) {
        const snapshot=await runScheduledDiagnostics(this.env);
        await this.record(snapshot);
        await this.ctx.storage.put('lastHourlyBucket',hour);
      }
    } catch {
      try { await this.recordPollError(at,'alarm_internal_error'); }
      catch { console.error(JSON.stringify({event:'alarm_record_error'})); }
    } finally {
      await this.ctx.storage.setAlarm(Date.now()+5*60*1000);
    }
  }
  // One-time private Telegram pairing. No chat IDs or bot tokens in public endpoints.
  // Uses the existing five-minute alarm, without another Cron Trigger or webhook.
  async telegramPairingState() {
    const bound=await this.ctx.storage.get('telegramRecipient');
    return bound ? 'connected' : 'waiting_for_pairing';
  }
  async pairTelegramIfNeeded() {
    const token=this.env.TELEGRAM_BOT_TOKEN;
    const code=this.env.TELEGRAM_PAIR_CODE;
    if (!token || !code || code.length<10) return;
    if (await this.ctx.storage.get('telegramRecipient')) return;
    const offset=(await this.ctx.storage.get('telegramUpdateOffset'))||0;
    const base='https://api.telegram.org/bot'+token+'/';
    const response=await fetch(base+'getUpdates',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({offset,limit:30,timeout:0,allowed_updates:['message']}),
      signal:AbortSignal.timeout(12000)
    });
    if (!response.ok) { await response.body?.cancel(); return; }
    const data=await response.json();
    if (!data?.ok || !Array.isArray(data.result)) return;
    let nextOffset=offset;
    for (const update of data.result) {
      if (typeof update.update_id==='number') nextOffset=Math.max(nextOffset,update.update_id+1);
      const message=update.message;
      const chat=message?.chat;
      if (!chat || chat.type!=='private' || !Number.isSafeInteger(chat.id)) continue;
      const text=String(message.text||'').trim();
      const match=/^\/start(?:@[A-Za-z0-9_]+)?\s+([A-Za-z0-9_-]+)$/.exec(text);
      if (!match || match[1]!==code) continue;
      // A single recipient is locked on first successful pairing.
      await this.ctx.storage.put('telegramRecipient',{chatId:chat.id,pairedAt:new Date().toISOString()});
      const confirmation=await fetch(base+'sendMessage',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:chat.id,text:'✅ Telegram-бот подключён к WB FBS Automation. Мониторинг заказов работает. Автоматическая отправка документов будет включена после проверки сценария WB.'}),
        signal:AbortSignal.timeout(12000)
      });
      await confirmation.body?.cancel();
      break;
    }
    if (nextOffset>offset) await this.ctx.storage.put('telegramUpdateOffset',nextOffset);
  }
  // Send exactly one harmless connection test to the already-paired private chat.
  // Mark attempted before network I/O: an uncertain Telegram response never causes a duplicate.
  async sendTelegramConnectionTestOnce() {
    const recipient=await this.ctx.storage.get('telegramRecipient');
    if (!recipient?.chatId || !this.env.TELEGRAM_BOT_TOKEN) return;
    if (await this.ctx.storage.get('telegramConnectionTest')) return;
    const at=new Date().toISOString();
    await this.ctx.storage.put('telegramConnectionTest',{state:'attempted',at});
    try {
      const response=await fetch('https://api.telegram.org/bot'+this.env.TELEGRAM_BOT_TOKEN+'/sendMessage',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          chat_id:recipient.chatId,
          text:'🟢 WB FBS Automation: тестовое сообщение доставлено. Мониторинг заказов активен. Создание поставок и отправка PDF пока отключены.'
        }),
        signal:AbortSignal.timeout(12000)
      });
      const ok=response.ok && !!(await response.json())?.ok;
      await this.ctx.storage.put('telegramConnectionTest',{
        state:ok?'sent':'failed',at,http:response.status
      });
    } catch {
      await this.ctx.storage.put('telegramConnectionTest',{state:'unconfirmed',at});
    }
  }
  async telegramConnectionTestState() {
    const result=await this.ctx.storage.get('telegramConnectionTest');
    return result?.state || 'not_sent';
  }
  // One-time document-source check on an EXISTING closed supply for target SC.
  // No WB mutations: GET barcode, GET order IDs, POST sticker retrieval (read operation).
  // Never return or persist raw QR, sticker, supply ID or order ID.
  async probeDocumentSourcesOnce() {
    if (!this.env.WB_API_TOKEN || await this.ctx.storage.get('documentProbe')) return;
    const at=new Date().toISOString();
    const result={state:'attempted',at,qr:'not_checked',sticker:'not_checked'};
    await this.ctx.storage.put('documentProbe',result);
    const headers={Authorization:this.env.WB_API_TOKEN,Accept:'application/json'};
    const request=async(path,init={})=>{
      const r=await fetch(API+path,{...init,headers:{...headers,...(init.headers||{})},signal:AbortSignal.timeout(12000)});
      if (!r.ok) {await r.body?.cancel();return {http:r.status,body:null};}
      return {http:r.status,body:await r.json()};
    };
    try {
      const list=await request('/api/v3/supplies?limit=100&next=0');
      if (!list.body) {result.state='failed';result.stage='supplies';result.http=list.http;}
      else {
        const rows=Array.isArray(list.body.supplies)?list.body.supplies:[];
        const supply=rows.find(x=>x.done===true && Number(x.shippingPointId)===353731 && /^WB-GI-[0-9]+$/.test(String(x.id||'')));
        if (!supply) {result.state='no_eligible_historical_supply';}
        else {
          const id=encodeURIComponent(supply.id);
          const qr=await request('/api/v3/supplies/'+id+'/barcode?type=png');
          result.qr=qr.http===200 && typeof qr.body?.file==='string' && qr.body.file.startsWith('iVBOR')?'available':'unavailable';
          result.qrHttp=qr.http;
          const orderIds=await request('/api/marketplace/v3/supplies/'+id+'/order-ids');
          result.orderIds=orderIds.http===200 && Array.isArray(orderIds.body?.orderIds)?'available':'unavailable';
          result.orderIdsHttp=orderIds.http;
          const orderId=orderIds.body?.orderIds?.find(x=>Number.isSafeInteger(x) && x>0);
          if (orderId) {
            const stickers=await request('/api/v3/orders/stickers?type=png&width=40&height=30',{
              method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orders:[orderId]})
            });
            const sticker=stickers.body?.stickers?.find(x=>x.orderId===orderId);
            result.sticker=stickers.http===200 && typeof sticker?.file==='string' && sticker.file.startsWith('iVBOR')?'available':'unavailable';
            result.stickerHttp=stickers.http;
          } else {result.sticker='no_order_id';}
          result.state=result.qr==='available' && result.sticker==='available'?'complete':'partial';
        }
      }
    } catch {
      result.state='failed';
      result.stage='network_or_timeout';
    }
    await this.ctx.storage.put('documentProbe',result);
  }
  async documentProbeSummary() {
    return (await this.ctx.storage.get('documentProbe')) || {state:'not_started'};
  }
  // Check whether Marketplace API provides all fields needed for the first three
  // product-label pages. Store field presence only; never store product/buyer data.
  async probeOrderMetadataOnce() {
    if (!this.env.WB_API_TOKEN || await this.ctx.storage.get('orderMetadataProbe')) return;
    const result={state:'attempted',at:new Date().toISOString()};
    await this.ctx.storage.put('orderMetadataProbe',result);
    try {
      const response=await fetch(API+'/api/v3/orders?limit=100&next=0',{
        method:'GET',headers:{Authorization:this.env.WB_API_TOKEN,Accept:'application/json'},
        signal:AbortSignal.timeout(12000)
      });
      result.http=response.status;
      if (!response.ok) {
        await response.body?.cancel();
        result.state='api_error';
      } else {
        const data=await response.json();
        const orders=Array.isArray(data?.orders)?data.orders:[];
        result.ordersReturned=orders.length;
        if (!orders.length) result.state='no_recent_orders';
        else {
          const fields=['id','article','skus','nmId','chrtId','colorCode','warehouseId','createdAt',
            'brand','name','title','subject','size','color','supplierArticle','sellerName'];
          result.availableFields=fields.filter(key=>orders.some(o=>{
            const value=o?.[key];
            return Array.isArray(value)?value.length>0:value!==undefined && value!==null && value!=='';
          }));
          result.missingFields=fields.filter(key=>!result.availableFields.includes(key));
          result.skuArrayPresent=orders.some(o=>Array.isArray(o.skus)&&o.skus.length>0);
          result.state='complete';
        }
      }
    } catch {
      result.state='network_or_timeout';
    }
    await this.ctx.storage.put('orderMetadataProbe',result);
  }
  async orderMetadataProbeSummary() {
    return (await this.ctx.storage.get('orderMetadataProbe')) || {state:'not_started'};
  }
  // Validate the PDF renderer against a real historical WB supply QR.
  // Generated PDF bytes are discarded; no supply/order ID or QR is persisted.
  async probePdfEngineOnce() {
    if (!this.env.WB_API_TOKEN || await this.ctx.storage.get('pdfEngineProbe')) return;
    const result={state:'attempted',at:new Date().toISOString()};
    await this.ctx.storage.put('pdfEngineProbe',result);
    const headers={Authorization:this.env.WB_API_TOKEN,Accept:'application/json'};
    try {
      const list=await fetch(API+'/api/v3/supplies?limit=100&next=0',{
        headers,signal:AbortSignal.timeout(12000)
      });
      if (!list.ok) {
        result.state='supplies_api_error';result.http=list.status;
        await list.body?.cancel();
      } else {
        const body=await list.json();
        const supply=(body.supplies||[]).find(x=>x.done===true && Number(x.shippingPointId)===353731 && /^WB-GI-[0-9]+$/.test(String(x.id||'')));
        if (!supply) result.state='no_eligible_historical_supply';
        else {
          const response=await fetch(API+'/api/v3/supplies/'+encodeURIComponent(supply.id)+'/barcode?type=png',{
            headers,signal:AbortSignal.timeout(12000)
          });
          if (!response.ok) {
            result.state='qr_api_error';result.http=response.status;
            await response.body?.cancel();
          } else {
            const data=await response.json();
            if (typeof data.file!=='string') result.state='invalid_qr_response';
            else {
              const pdf=await officialPngPdf(data.file,{widthMm:58,heightMm:40});
              const head=new TextDecoder().decode(pdf.subarray(0,8));
              result.state=head.startsWith('%PDF-') && pdf.length>300?'complete':'invalid_pdf';
              result.pdfBytes=pdf.length;
              result.page='58x40mm';
            }
          }
        }
      }
    } catch(error) {
      result.state='renderer_or_network_error';
      result.errorCode=String(error?.message||'unknown').slice(0,60).replace(/[^A-Za-z0-9_]/g,'_');
    }
    await this.ctx.storage.put('pdfEngineProbe',result);
  }
  async pdfEngineProbeSummary() {
    return (await this.ctx.storage.get('pdfEngineProbe')) || {state:'not_started'};
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

// WB FBS Automation v0.11.0 — read-only monitoring, order field audit and actual QR PDF renderer probe.
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
// Polls every minute. GET-only and idempotent: never creates or modifies supplies.
async function pollNewFbsOrders(env) {
  const at=new Date().toISOString();
  if (!env.WB_API_TOKEN) {
    await historyStore(env).recordPollError(at,'token_not_configured');
    return;
  }
  try {
    const response=await fetch(API+'/api/v3/orders/new',{
      method:'GET',
      headers:{Authorization:env.WB_API_TOKEN,Accept:'application/json'},
      signal:AbortSignal.timeout(12000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      await historyStore(env).recordPollError(at,
        response.status===429?'rate_limited':'wb_api_error',response.status);
      return;
    }
    const data=await response.json();
    if (!Array.isArray(data?.orders)) {
      await historyStore(env).recordPollError(at,'unexpected_response_shape',response.status);
      return;
    }
    const orders=data.orders.map(x=>({id:x.id,warehouseId:x.warehouseId}));
    const result=await historyStore(env).observeOrders(orders,at);
    console.log(JSON.stringify({event:'read_only_order_poll',at,ok:true,newlySeen:result.newlySeen}));
  } catch {
    await historyStore(env).recordPollError(at,'network_or_timeout');
  }
}
async function runScheduledDiagnostics(env) {
  const now=new Date();
  const snapshot={
    at:now.toISOString(),
    version:'0.11.0',
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
      return Response.json({ok:true,service:'wb-fbs-automation',version:'0.11.0',mode:'READ_ONLY',orderPolling:'every_5_minutes',diagnostics:'hourly',scheduler:'durable_object_alarm'});
    }
    if (request.method==='GET' && path==='/status') {
      if (!env.DIAG_HISTORY) return Response.json({ok:false,error:'history_binding_not_configured'},{status:503});
      const store=historyStore(env);
      const alarm=await store.ensureAlarm();
      const latest=await store.publicStatus();
      return Response.json({
        ...(latest || {service:'wb-fbs-automation',mode:'READ_ONLY',status:'waiting_for_first_alarm'}),
        version:'0.11.0',
        scheduler:'durable_object_alarm',
        telegram:!env.TELEGRAM_BOT_TOKEN?'not_configured':(!env.TELEGRAM_PAIR_CODE || env.TELEGRAM_PAIR_CODE.length<10)?'pair_code_not_configured':await store.telegramPairingState(),
        telegramTest:await store.telegramConnectionTestState(),
        documentProbe:await store.documentProbeSummary(),
        orderMetadataProbe:await store.orderMetadataProbeSummary(),
        pdfEngineProbe:await store.pdfEngineProbeSummary(),
        alarm
      },{headers:{'Cache-Control':'no-store'}});
    }
    if (!['/diagnostics','/diagnostics/shipping-dates','/diagnostics/history','/diagnostics/order-monitor'].includes(path) || request.method!=='GET') return new Response('Not found',{status:404});
    if (!env.ADMIN_KEY) return Response.json({error:'ADMIN_KEY not configured'},{status:503});
    const provided=request.headers.get('X-Admin-Key');
    if (!provided || provided!==env.ADMIN_KEY) return new Response('Unauthorized',{status:401});
    if (path==='/diagnostics/order-monitor') {
      if (!env.DIAG_HISTORY) return Response.json({error:'history_binding_not_configured'},{status:503});
      return Response.json(await historyStore(env).orderMonitorSummary(),{headers:{'Cache-Control':'no-store'}});
    }
    if (path==='/diagnostics/history') {
      if (!env.DIAG_HISTORY) return Response.json({error:'history_binding_not_configured'},{status:503});
      return Response.json({version:'0.11.0',mode:'READ_ONLY',history:await historyStore(env).recentHistory()},{headers:{'Cache-Control':'no-store'}});
    }
    return Response.json(path==='/diagnostics/shipping-dates' ? await auditShippingDates(env) : await runDiagnostics(env),{headers:{'Cache-Control':'no-store'}});
  },
  async scheduled(_event,_env,_ctx) {
    // Ignore legacy cron events if any were registered by a partial deployment.
    // All active monitoring uses Durable Object alarm().
  }};
