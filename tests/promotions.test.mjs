import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './fixtures.mjs';
import {localDay,shiftDay,evaluateZeroSales,normalizeProposal,normalizeCosts} from '../lib/promotion-model.mjs';
import {zeroSales,mutatePromotion,readPromotions,promotionRecord,promotionHistory,refreshPromotions,promotionTasks} from '../lib/promotions.mjs';
import {uploadPromotionFile} from '../lib/promotion-files.mjs';
import {createBackup,restoreBackup,verifyArchive} from '../server/backup.mjs';
import {openDatabase,fileBucket} from '../server/storage.mjs';
import {backupStream} from '../lib/full-backup.mjs';
const now=new Date('2026-10-20T05:00:00Z'),day=localDay(now),cutoff=shiftDay(day,-1);
const dates=Array.from({length:30},(_,i)=>shiftDay(cutoff,-i));
const proposal=(p={})=>({sku:'BAG-A',start:day,end:shiftDay(day,5),original:100,price:80,floor:75,qty:5,budget:150,lossCap:0,reason:'连续零销量去化库存',goal:'5天内售出5件',method:'直接降价，无其他优惠叠加',url:'https://example.test/product',...p});
const costs=(p={})=>({landed:30,fulfillment:5,returns:2,ad:5,rate:10,costDate:'2026-10-01',source:'采购到岸报价 V1，广告为投放预测',note:'逐项核对成本后同意优惠',...p});
const row=(f,id)=>f.sqlite.prepare('SELECT * FROM promotions WHERE id=?').get(id);
const change=(f,id,a,action,p={},at=now)=>mutatePromotion(f.db,a,{action,id,version:row(f,id).version,note:'已核对相关资料与条件',...p},at);
const create=async(f,p={},a=f.users.indonesia)=>(await mutatePromotion(f.db,a,{action:'create',...proposal(p)},now)).id;
const bucket=()=>{const files=new Map();return {files,async put(k,v){files.set(k,v)},async delete(k){files.delete(k)}}};
const photo=()=>new File([new Uint8Array([255,216,255,1])],'proof.jpg',{type:'image/jpeg'});
const proof=async(f,id,purpose,b=bucket())=>uploadPromotionFile(f.db,b,f.users.indonesia,id,purpose,photo());
async function approve(f,p={}){const id=await create(f,p);await proof(f,id,'proposal');await change(f,id,f.users.indonesia,'submit');await change(f,id,f.users.finance,'finance',costs());await change(f,id,f.users.admin,'approve');return id;}
async function active(f){const id=await approve(f);await proof(f,id,'execution');await change(f,id,f.users.indonesia,'execute',{termsConfirmed:true,actualPrice:80,activityRef:'PLATFORM-001'});return id;}
function reports(f,ds=dates){for(const d of ds)f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok',0,0,?,'2026-10-01','zero')").run('imp'+d,'key'+d,d,f.users.indonesia.id);}
function sale(f,date,qty,{reversed=false,amount=qty*80}={}){f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,reported_amount,actor_id,created_at,reversed_at) VALUES(?,'external',?,'印尼','TikTok','BAG-A',?,?,?,'2026-10-01',?)").run(crypto.randomUUID(),date,qty,amount,f.users.indonesia.id,reversed?'2026-10-02':null);}
function observation(f){f.sqlite.prepare("INSERT INTO promotion_availability VALUES('印尼','TikTok','BAG-A','2026-08-01','2026-08-01',?,'库存报表证据','已核实连续上架且有货',?,'2026-10-20')").run(cutoff,f.users.indonesia.id);}
const base=()=>({stock:{site:'印尼',channel:'TikTok',sku:'BAG-A',name:'Bag',qty:10,reserved_qty:2},sales:[],completeDates:dates,availability:{listed_since:'2026-08-01',available_since:'2026-08-01',verified_through:cutoff},observations:[]});
test('完整7天以WIB昨天截止，缺报不是零，毛销量不与退货抵销，今日销售不进入窗口',()=>{
 assert.equal(localDay('2026-10-19T18:00:00Z'),'2026-10-20');const x=base();assert.equal(evaluateZeroSales(x,now).zeroDays,30);assert.equal(evaluateZeroSales(x,now).available,8);
 x.completeDates=dates.filter(d=>d!==dates[3]);assert.equal(evaluateZeroSales(x,now).status,'observe');assert.equal(evaluateZeroSales(x,now).coverage,6);x.completeDates=dates;
 x.sales=[{business_date:cutoff,qty:1},{business_date:cutoff,qty:-1}];assert.equal(evaluateZeroSales(x,now).status,'closed');x.sales=[{business_date:day,qty:4}];assert.equal(evaluateZeroSales(x,now).status,'open');
 x.stock.reserved_qty=10;assert.equal(evaluateZeroSales(x,now).status,'closed');
});
test('连续可售/上架不足7天观察，已知缺货覆盖人工核验，不补造历史',()=>{
 const x=base();x.availability=null;assert.equal(evaluateZeroSales(x,now).status,'observe');x.availability=base().availability;x.availability.listed_since=dates[4];assert.equal(evaluateZeroSales(x,now).zeroDays,5);
 x.availability=base().availability;x.observations=[{day:cutoff,min_available:0}];assert.equal(evaluateZeroSales(x,now).zeroDays,0);
 x.availability.verified_through=dates[1];x.observations=[{day:cutoff,min_available:2,first_at:'2026-10-18T17:01:00Z'}];assert.equal(evaluateZeroSales(x,now).status,'open');x.observations[0].first_at='2026-10-19T12:00:00Z';assert.equal(evaluateZeroSales(x,now).status,'observe');
});
test('读取按站点渠道隔离，部分/费用日报不算完整，冲销后重新预警，工厂无权访问',async()=>{
 const f=fixture();reports(f);observation(f);let a=await zeroSales(f.db,f.users.indonesia,now);assert.equal(a.find(r=>r.sku==='BAG-A').status,'open');assert.ok(a.every(r=>r.channel==='TikTok'));
 f.sqlite.prepare("UPDATE sales_imports SET report_kind='partial' WHERE business_date=?").run(cutoff);assert.equal((await zeroSales(f.db,f.users.indonesia,now))[0].status,'observe');f.sqlite.prepare("UPDATE sales_imports SET report_kind='complete'").run();sale(f,cutoff,2);assert.equal((await zeroSales(f.db,f.users.indonesia,now))[0].status,'closed');f.sqlite.prepare('UPDATE sales_records SET reversed_at=?').run(day);assert.equal((await zeroSales(f.db,f.users.indonesia,now))[0].status,'open');
 for(const a of [{id:'f',role:'工厂'},f.users.sales])await assert.rejects(readPromotions(f.db,a,now),/开放/);
});
test('人工核验必须本人范围和证据，不能覆盖已知无货，其他措施留痕',async()=>{
 const f=fixture(),p={action:'verify',sku:'BAG-A',listedSince:'2026-10-01',availableSince:'2026-10-01',reference:'平台库存记录',note:'确认持续有货并在售',confirmed:true};
 await mutatePromotion(f.db,f.users.indonesia,p,now);assert.equal(f.sqlite.prepare('SELECT verified_through FROM promotion_availability').get().verified_through,cutoff);
 await assert.rejects(mutatePromotion(f.db,f.users.supply,p,now),/运营/);await assert.rejects(mutatePromotion(f.db,f.users.indonesia,{...p,confirmed:false},now),/核对/);
 f.sqlite.prepare("INSERT INTO promotion_stock_days VALUES('印尼','TikTok','BAG-A',?,0,'x','x')").run(cutoff);await assert.rejects(mutatePromotion(f.db,f.users.indonesia,p,now),/无可售/);
 await mutatePromotion(f.db,f.users.indonesia,{action:'measure',sku:'BAG-A',note:'优化商品主图和详情页'},now);assert.ok(f.sqlite.prepare("SELECT 1 FROM audit_logs WHERE action='promotion.measure'").get());
});
test('申请、财务、管理员、执行、停止、复盘闭环，审批不改库存销售与平台价',async()=>{
 const f=fixture(),before=f.sqlite.prepare('SELECT * FROM inventory_balances').all(),id=await active(f);assert.equal(row(f,id).status,'active');assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_records').get().n,0);
 await proof(f,id,'stop');await change(f,id,f.users.indonesia,'stop',{restored:true,restoredPrice:100});assert.equal(row(f,id).status,'review_pending');
 await assert.rejects(change(f,id,f.users.finance,'review',{refund:0,expenses:0,actualAd:''}),/满7天/);
 reports(f,[day]);sale(f,day,2);await change(f,id,f.users.finance,'review',{refund:0,expenses:50,actualAd:'',reviewSource:'平台财务结算单'},new Date('2026-10-28T05:00:00Z'));assert.equal(row(f,id).status,'completed');assert.equal(JSON.parse(row(f,id).data_json).review.contribution,null);assert.ok((await promotionHistory(f.db,f.users.admin,id)).length>=8);
});
test('审批顺序、本人范围、自审及供应链字段/文件隔离，锁定后不可改价',async()=>{
 const f=fixture(),id=await create(f);await assert.rejects(promotionRecord(f.db,f.users.admin,id),/无权/);await proof(f,id,'proposal');await change(f,id,f.users.indonesia,'submit');
 for(const a of [f.users.admin,f.users.indonesia,f.users.supply])await assert.rejects(change(f,id,a,'finance',costs()),/独立财务/);
 await assert.rejects(change(f,id,f.users.admin,'approve'),/独立管理员/);await change(f,id,f.users.finance,'finance',costs());await assert.rejects(change(f,id,{...f.users.admin,id:f.users.indonesia.id},'approve'),/自己审批/);await change(f,id,f.users.admin,'approve');
 await assert.rejects(change(f,id,f.users.indonesia,'save',proposal()),/草稿/);await assert.rejects(change(f,id,f.users.supply,'execute'),/申请人/);
 const supply=await readPromotions(f.db,f.users.supply,now);assert.ok(!JSON.stringify(supply.records).includes('original'));assert.ok(!JSON.stringify(supply.records).includes('costs'));assert.equal(supply.files.length,0);await assert.rejects(promotionHistory(f.db,f.users.supply,id),/只|仅/);
 await assert.rejects(uploadPromotionFile(f.db,bucket(),f.users.supply,id,'execution',photo()),/仅申请/);
});
test('金额、预算、日期、成本未知与亏损上限校验',async()=>{
 for(const p of [{price:120},{price:-1},{floor:90},{qty:0},{budget:10},{end:'2026-02-30'},{url:'javascript:alert(1)'},{original:'1.001'}])assert.throws(()=>normalizeProposal(proposal(p),now));
 const d=normalizeProposal(proposal(),now);assert.throws(()=>normalizeCosts(costs({ad:''}),d),/广告/);assert.throws(()=>normalizeCosts(costs({landed:100}),d),/亏损/);assert.throws(()=>normalizeCosts(costs({ad:100}),d),/预算/);assert.throws(()=>normalizeCosts(costs({landed:1e10}),{...d,qty:1000000}),/安全范围/);
 const f=fixture(),id=await create(f,{clearance:true,lossCap:400});await proof(f,id,'proposal');await change(f,id,f.users.indonesia,'submit');await change(f,id,f.users.finance,'finance',costs({landed:100}));await assert.rejects(change(f,id,f.users.admin,'approve'),/明确/);await change(f,id,f.users.admin,'approve',{lossConfirmed:true});assert.equal(row(f,id).status,'approved');
});
test('重叠申请和并发提交只成功一次，库存不足不能审批/执行',async()=>{
 const f=fixture(),a=await create(f),b=await create(f);await proof(f,a,'proposal');await proof(f,b,'proposal');
 const outcomes=await Promise.allSettled([change(f,a,f.users.indonesia,'submit'),change(f,b,f.users.indonesia,'submit')]);assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);
 const id=row(f,a).status==='finance_review'?a:b;await change(f,id,f.users.finance,'finance',costs());f.stock('BAG-A',1,10);await assert.rejects(change(f,id,f.users.admin,'approve'),/变化/);f.stock('BAG-A',10,10);await change(f,id,f.users.admin,'approve');await proof(f,id,'execution');f.stock('BAG-A',1,10);await assert.rejects(change(f,id,f.users.indonesia,'execute',{actualPrice:80,termsConfirmed:true,activityRef:'TEST'}),/变化/);
});
test('凭证真实格式去重、限额、失败清理；改稿后旧证据不能冒充新版本',async()=>{
 const f=fixture(),id=await create(f),b=bucket();await assert.rejects(uploadPromotionFile(f.db,b,f.users.indonesia,id,'proposal',new File(['fake'],'a.png')),/只支持/);await proof(f,id,'proposal',b);await proof(f,id,'proposal',b);assert.equal(b.files.size,1);
 await change(f,id,f.users.indonesia,'save',proposal());await assert.rejects(change(f,id,f.users.indonesia,'submit'),/截图/);await proof(f,id,'proposal');await change(f,id,f.users.indonesia,'submit');await assert.rejects(proof(f,id,'proposal'),/当前步骤/);
});
test('监测不会重复创建预警；达到上限/到期持续待停止，不伪造平台恢复',async()=>{
 const f=fixture();reports(f);observation(f);await refreshPromotions(f.db,now);const n=f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='promotion.alert'").get().n;await refreshPromotions(f.db,now);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='promotion.alert'").get().n,n);
 const id=await active(f);sale(f,day,5);sale(f,day,-5);await refreshPromotions(f.db,now);assert.equal(row(f,id).status,'stop_required');assert.equal(JSON.parse(row(f,id).data_json).stop,undefined);
 await refreshPromotions(f.db,new Date('2026-10-30T05:00:00Z'));assert.equal(row(f,id).status,'stop_required');
 const g=fixture(),unexecuted=await approve(g);await refreshPromotions(g.db,new Date('2026-10-30T05:00:00Z'));assert.equal(row(g,unexecuted).status,'terminated');assert.equal(JSON.parse(row(g,unexecuted).data_json).execution,undefined);
});
test('撤回/退回保留记录，旧版本不可覆盖新记录，任务按角色生成',async()=>{
 const f=fixture(),id=await create(f),v=row(f,id).version;await proof(f,id,'proposal');await assert.rejects(mutatePromotion(f.db,f.users.indonesia,{id,action:'submit',version:v},now),/更新/);await change(f,id,f.users.indonesia,'submit');assert.ok((await promotionTasks(f.db,f.users.finance)).some(t=>t.entity===id));
 await change(f,id,f.users.finance,'return');assert.equal(row(f,id).revision,2);await change(f,id,f.users.indonesia,'withdraw');assert.equal(row(f,id).status,'withdrawn');assert.deepEqual(await promotionTasks(f.db,{role:'工厂'}),[]);
});
test('优惠全部表与图片随全量备份恢复，维护锁保护写入和监测',async()=>{
 const root=mkdtempSync(join(tmpdir(),'lj-promotion-'));try{const f=fixture(),b=fileBucket(join(root,'files')),id=await create(f);await proof(f,id,'proposal',b);const stream=await backupStream(f.db,b,f.users.admin);await assert.rejects(refreshPromotions(f.db,now),/备份|迁移/);assert.throws(()=>f.sqlite.prepare("UPDATE promotions SET status='active'").run(),/maintenance/);await stream.cancel();const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:b},path);assert.equal((await verifyArchive(path)).files.length,1);const target=join(root,'restore');await restoreBackup(path,target);const db=openDatabase(join(target,'business.sqlite'));assert.equal(db.sqlite.prepare('SELECT * FROM promotions WHERE id=?').get(id).status,'draft');assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM promotion_files').get().n,1);db.sqlite.close();}finally{rmSync(root,{recursive:true,force:true})}
});
