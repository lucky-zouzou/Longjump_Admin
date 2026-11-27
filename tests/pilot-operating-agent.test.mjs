import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {navigationForRole} from '../lib/permissions.mjs';
import {evaluateOperatingPilot,loadOperatingPilotData,operatingScopeConfirmed} from '../lib/pilot-operating-agent.mjs';

const now=new Date('2026-11-26T03:00:00Z');
const config={shopId:'id-main',shopName:'TEST 印尼 TikTok 店',site:'印尼',channel:'TikTok',scopeMode:'exclusive_site_channel',scopeVerified:true,operatorId:'ops',supplyOwnerId:'supply',prioritySkus:['BAG-A'],thresholds:{stockCoverDays:3,adIncreasePct:50,refundCaseCount:3}};
const scoped=row=>({shopId:config.shopId,site:'印尼',channel:'TikTok',...row});
const users=[{id:'ops',name:'运营甲',role:'运营',site:'印尼',channel:'TikTok',active:1},{id:'supply',name:'供应链甲',role:'供应链',active:1}];
const days=Array.from({length:14},(_,i)=>new Date(Date.UTC(2026,10,12+i)).toISOString().slice(0,10));
function data(){
 return {scopeVerified:true,users,imports:days.map(d=>scoped({id:'i-'+d,business_date:d,report_kind:'complete'})),sales:days.map(d=>scoped({id:'r-'+d,import_id:'i-'+d,business_date:d,sku:'BAG-A',qty:10})),stocks:[scoped({sku:'BAG-A',qty:30,reserved_qty:0,pending_shelf_qty:100,quarantine_qty:50,updated_at:'2026-11-26T02:00:00Z'})],ads:days.map(d=>scoped({id:'a-'+d,business_date:d,amount:100,currency:'IDR'})),refunds:[],arrivals:[],refundsComplete:false};
}
const find=(result,kind,entity)=>result.findings.find(r=>r.kind===kind&&(entity===undefined||JSON.parse(r.key)[3]===entity));

test('unconfirmed single-shop scope does not query or read site financial facts',async()=>{
 const db={prepare(){throw Error('must not read business tables')}};
 const d=await loadOperatingPilotData(db,{...config,scopeVerified:false},now);
 const result=evaluateOperatingPilot({...data(),...d},{...config,scopeVerified:false},now);
 assert.equal(result.findings.length,1);assert.equal(result.findings[0].kind,'scope');assert.equal(result.findings[0].state,'unknown');assert.equal(result.metrics.salesQty,null);assert.equal(result.coverage.complete,false);
 assert.equal(operatingScopeConfirmed({...config,scopeVerifiedUntil:'2026-11-26T02:00:00Z'},now),false);
});

test('one-shop rows only: another shop, site or channel never changes measurements',()=>{
 const d=data();for(const scope of [{shopId:'other-shop'},{site:'马来西亚'},{channel:'Shopee'}]){
  d.sales.push(scoped({id:crypto.randomUUID(),business_date:'2026-11-25',sku:'BAG-A',qty:100000,...scope}));
  d.ads.push(scoped({id:crypto.randomUUID(),business_date:'2026-11-25',currency:'IDR',amount:100000,...scope}));
 }
 d.sales.push({site:'印尼',channel:'TikTok',sku:'BAG-A',business_date:'2026-11-25',qty:100000});
 const result=evaluateOperatingPilot(d,config,now);
 assert.equal(result.metrics.salesQty,70);assert.equal(result.metrics.adSpend[0].amount,100);assert.equal(result.metrics.inventory[0].averageDailySales,10);
});

test('daily window uses Jakarta completed days, missing and partial reports are not zero',()=>{
 const d=data();d.imports=d.imports.filter(r=>r.business_date!=='2026-11-25');
 d.imports.push(scoped({id:'partial',business_date:'2026-11-25',report_kind:'partial'}));
 d.imports.push(scoped({id:'today',business_date:'2026-11-26',report_kind:'complete'}));
 d.sales.push(scoped({id:'today-sale',business_date:'2026-11-26',qty:5000,sku:'BAG-A',import_id:'today'}));
 const result=evaluateOperatingPilot(d,config,now);
 assert.equal(result.metrics.cutoff,'2026-11-25');assert.equal(result.metrics.salesQty,null);assert.equal(result.metrics.inventory[0].averageDailySales,null);
 assert.equal(find(result,'missing_report').state,'active');assert.equal(find(result,'stockout').state,'unknown');
 assert.match(find(result,'missing_report').evidence[1].value,/2026-11-25/);
 const midnight=evaluateOperatingPilot(data(),config,new Date('2026-11-25T16:30:00Z'));
 assert.equal(midnight.metrics.today,'2026-11-25');assert.equal(midnight.metrics.cutoff,'2026-11-24');
});

test('reversed imports and overlapping daily SKU summaries cannot establish complete coverage',()=>{
 const reversed=data();reversed.imports.find(r=>r.business_date==='2026-11-25').reversed_at='2026-11-26T02:00:00Z';
 assert.equal(find(evaluateOperatingPilot(reversed,config,now),'stockout').state,'unknown');
 const overlap=data();overlap.sales.push(scoped({id:'overlap',import_id:'another',business_date:'2026-11-25',qty:1,sku:'BAG-A'}));
 assert.equal(find(evaluateOperatingPilot(overlap,config,now),'missing_report').state,'active');
});

test('three-day stock scenario exposes source, owner and review date without creating a purchase',()=>{
 const result=evaluateOperatingPilot(data(),config,now),r=find(result,'stockout','BAG-A');
 assert.equal(result.metrics.inventory[0].available,30);assert.equal(result.metrics.inventory[0].stockOnlyCoverDays,3);assert.equal(result.metrics.inventory[0].firstShortageDate,'2026-11-29');
 assert.equal(r.state,'active');assert.equal(r.ownerId,'supply');assert.equal(r.reviewDate,'2026-11-27');assert.equal(r.priority,'high');
 assert.ok(r.evidence.every(e=>e.source));assert.match(r.impact,/核实批次和交期/);assert.equal('suggestedProduction' in result.metrics,false);
 const tomorrow=evaluateOperatingPilot(data(),config,new Date('2026-11-27T03:00:00Z'));assert.equal(find(tomorrow,'stockout','BAG-A').key,r.key);
});

test('only explicit priority SKUs are checked, no guessing from whole store catalog',()=>{
 const d=data();d.stocks.push(scoped({sku:'NON-PRIORITY',qty:0,reserved_qty:0}));
 const result=evaluateOperatingPilot(d,{...config,prioritySkus:[]},now);
 assert.equal(result.metrics.inventory.length,0);assert.equal(find(result,'priority_skus').state,'unknown');assert.equal(result.coverage.checks.stock,false);
 const configured=evaluateOperatingPilot(d,config,now);assert.equal(find(configured,'priority_skus').state,'clear');assert.equal(configured.metrics.inventory.length,1);
});

test('unconfirmed and expired transit does not cancel a stockout; valid ETA affects projection conservatively',()=>{
 const d=data();d.arrivals.push(scoped({sku:'BAG-A',qty:100,eta:null,source:'transport:missing'}));
 let result=evaluateOperatingPilot(d,config,now);assert.equal(find(result,'stockout').state,'active');assert.equal(result.metrics.inventory[0].undatedArrivalQty,100);
 d.arrivals[0].eta='2026-11-24';result=evaluateOperatingPilot(d,config,now);assert.equal(result.metrics.inventory[0].firstShortageDate,'2026-11-29');
 d.arrivals[0].eta='2026-11-28';result=evaluateOperatingPilot(d,config,now);assert.equal(find(result,'stockout').state,'clear');assert.equal(result.metrics.inventory[0].firstShortageDate,null);
 d.stocks[0].qty=0;d.arrivals[0].eta='2026-11-26';result=evaluateOperatingPilot(d,config,now);assert.equal(find(result,'stockout').state,'active');assert.equal(result.metrics.inventory[0].firstShortageDate,'2026-11-26');
});

test('negative or absent inventory and inactive owners remain unknown',()=>{
 for(const qty of [-1,null]){const d=data();d.stocks[0].qty=qty;const result=evaluateOperatingPilot(d,config,now);assert.equal(find(result,'stockout').state,'unknown');}
 const d=data();d.users[1]={...d.users[1],active:0};const r=find(evaluateOperatingPilot(d,config,now),'stockout');assert.equal(r.ownerId,null);assert.equal(r.ownerName,'待指定');
});

test('complete zero sales has no fabricated stock-cover days or refund all-clear',()=>{
 const d=data();d.sales=[];d.imports.forEach(r=>r.report_kind='zero');
 const result=evaluateOperatingPilot(d,config,now);assert.equal(result.metrics.salesQty,0);assert.equal(result.metrics.inventory[0].stockOnlyCoverDays,null);assert.equal(find(result,'stockout').state,'clear');assert.equal(find(result,'refunds').state,'unknown');assert.equal(result.coverage.complete,false);
});

test('actual ads only, per currency, full comparison window, without treating budgets as spent',()=>{
 const d=data();d.ads.find(r=>r.business_date==='2026-11-25').amount=160;
 d.adBudgets=[{approvedAmount:999999}];d.walletTopups=[{amount:999999}];
 for(const date of days)d.ads.push(scoped({id:'usd-'+date,business_date:date,currency:'USD',amount:10}));
 const result=evaluateOperatingPilot(d,config,now);
 assert.equal(result.metrics.adSpend.find(r=>r.currency==='IDR').amount,160);assert.equal(find(result,'ad_spend','IDR').state,'active');assert.equal(find(result,'ad_spend','USD').state,'clear');
 assert.equal(result.metrics.adSpend.find(r=>r.currency==='IDR').baselineDaily,100);assert.equal(result.metrics.adSpend.find(r=>r.currency==='IDR').increasePct,60);
 const absent=data();absent.ads=[];absent.adBudgets=d.adBudgets;
 assert.equal(find(evaluateOperatingPilot(absent,config,now),'ad_reporting').state,'unknown');
});

test('ad missing day, deletion, null amount and duplicate day never produce a false clear',()=>{
 const missing=data();missing.ads=missing.ads.filter(r=>r.business_date!=='2026-11-22');assert.equal(find(evaluateOperatingPilot(missing,config,now),'ad_spend').state,'unknown');
 const deleted=data();deleted.ads.find(r=>r.business_date==='2026-11-25').deleted_at='2026-11-26';assert.equal(find(evaluateOperatingPilot(deleted,config,now),'ad_reporting').state,'unknown');
 const nullAmount=data();nullAmount.ads.find(r=>r.business_date==='2026-11-25').amount=null;assert.equal(find(evaluateOperatingPilot(nullAmount,config,now),'ad_spend').state,'unknown');
 const duplicate=data();duplicate.ads.push({...duplicate.ads.at(-1),id:'dup'});assert.equal(find(evaluateOperatingPilot(duplicate,config,now),'ad_spend').state,'unknown');
});

test('refund exception counts deduplicate orders, ignore drafts/voids and do not invent refund rate',()=>{
 const d=data();
 for(const [id,orderNo,sku,status] of [['a','O1','BAG-A','submitted'],['b','O1','BAG-B','confirmed'],['c','O2','BAG-A','submitted'],['d','O3','BAG-A','closed'],['e','O4','BAG-A','draft'],['f','O5','BAG-A','void']])d.refunds.push(scoped({id,business_date:'2026-11-25',sku,status,data_json:JSON.stringify({orderNo,currency:'IDR',refundCents:10000})}));
 const result=evaluateOperatingPilot(d,config,now),r=find(result,'refunds');assert.equal(result.metrics.refundOrdersObserved,3);assert.equal(result.metrics.refundAmountsObserved[0].amount,400);assert.equal(r.state,'active');assert.equal(result.coverage.checks.refunds,false);assert.equal('refundRate' in result.metrics,false);assert.match(r.impact,/不代表已实际支付/);
});

test('refund records without order identity cannot fabricate an order count or complete coverage',()=>{
 const d=data();d.refundsComplete=true;
 for(let i=0;i<4;i++)d.refunds.push(scoped({id:'unknown-'+i,business_date:'2026-11-25',status:'confirmed',data_json:JSON.stringify({currency:'IDR',refundCents:10000})}));
 const result=evaluateOperatingPilot(d,config,now);assert.equal(result.metrics.refundOrdersObserved,0);assert.equal(result.coverage.checks.refunds,false);assert.equal(find(result,'refunds').state,'unknown');assert.match(find(result,'refunds').evidence[0].value,/4 条缺订单编号/);
});

test('loader pauses if another shop appears or ownership changed, before reading business tables',async()=>{
 let queries=[];const db={prepare(sql){queries.push(sql);return {bind(){return this},async all(){return {results:[{id:config.shopId,operator_id:'other',version:1},{id:'second',operator_id:'ops',version:1}]}}}}};
 const result=await loadOperatingPilotData(db,config,now);assert.equal(result.scopeVerified,false);assert.equal(queries.length,1);assert.match(queries[0],/creator_scopes/);
});

test('read-only database adapter scopes existing legacy rows and validates current creator scope',async()=>{
 const f=fixture();
 f.sqlite.prepare("INSERT INTO creator_scopes(id,site,platform,shop,operator_id,bd_id,updated_at) VALUES(?,'印尼','TikTok','TEST Shop',?,?,?)").run(config.shopId,f.users.indonesia.id,f.users.admin.id,now.toISOString());
 const c={...config,operatorId:f.users.indonesia.id,supplyOwnerId:f.users.supply.id,scopeVersion:1};
 const before=f.sqlite.prepare('SELECT SUM(qty) n FROM inventory_balances').get().n;
 const d=await loadOperatingPilotData(f.db,c,now);assert.equal(d.scopeVerified,true);assert.equal(d.stocks.length,1);assert.equal(d.stocks[0].shopId,config.shopId);assert.equal(d.stocks[0].site,'印尼');assert.equal(d.refundsComplete,false);
 assert.equal(f.sqlite.prepare('SELECT SUM(qty) n FROM inventory_balances').get().n,before);
 const stale=await loadOperatingPilotData(f.db,{...c,scopeVersion:2},now);assert.equal(stale.scopeVerified,false);
});

test('evidence links target real accessible workspaces and advertising trend view',()=>{
 const result=evaluateOperatingPilot(data(),config,now),pages=navigationForRole('运营');
 for(const finding of result.findings)for(const item of finding.evidence)if(item.url){const url=new URL(item.url,'https://example.test');assert.ok(pages.includes(url.searchParams.get('page')),item.url);if(item.url.includes('advertising'))assert.equal(url.searchParams.get('view'),'advertising-trend');}
});

test('source revision changes during read abort rather than persisting inconsistent evidence',async()=>{
 const f=fixture();
 f.sqlite.prepare("INSERT INTO creator_scopes(id,site,platform,shop,operator_id,bd_id,updated_at) VALUES(?,'印尼','TikTok','TEST Shop',?,?,?)").run(config.shopId,f.users.indonesia.id,f.users.admin.id,now.toISOString());
 const original=f.db.prepare;let reads=0;
 const db={...f.db,prepare(sql){const statement=original(sql);if(sql.includes('SELECT version FROM business_action_source_clock')){const first=statement.first.bind(statement);statement.first=async()=>{reads++;if(reads===2)f.sqlite.prepare("INSERT INTO business_action_source_clock VALUES('global',100) ON CONFLICT(id) DO UPDATE SET version=version+1").run();return first();};}return statement;}};
 await assert.rejects(loadOperatingPilotData(db,{...config,operatorId:f.users.indonesia.id,supplyOwnerId:f.users.supply.id,scopeVersion:1},now),e=>e.status===409);
});
