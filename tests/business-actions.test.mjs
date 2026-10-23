import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './fixtures.mjs';
import {actionWindow,compareActions,evaluateActions,actionKey} from '../lib/business-action-model.mjs';
import {actionCandidates} from '../lib/business-action-data.mjs';
import {refreshBusinessActions,readBusinessActions,mutateBusinessAction,actionHistory,businessActionTasks} from '../lib/business-actions.mjs';
import {createBackup,restoreBackup} from '../server/backup.mjs';
import {fileBucket,openDatabase} from '../server/storage.mjs';
import {backupStream} from '../lib/full-backup.mjs';
const now=new Date('2026-10-23T05:00:00Z'),w=actionWindow('印尼',now);
const dbrow=(f,kind='loss')=>f.sqlite.prepare("SELECT * FROM business_actions WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A' AND kind=?").get(kind);
const call=(f,a,kind,action,p={},at=now)=>{const r=dbrow(f,kind);return mutateBusinessAction(f.db,a,{id:r.id,version:r.version,action,note:'已核对经营资料并说明处理结果',...p},at);};
function report(f,d){f.sqlite.prepare("INSERT OR IGNORE INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok',1,2,'id-ops',?,'complete')").run('imp-'+d,'key-'+d,d,d);}
function sale(f,d,qty=2,amount=200,currency='IDR'){f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,actor_id,created_at) VALUES(?,?,?,'印尼','TikTok','BAG-A',?,?,?,'id-ops',?)").run(crypto.randomUUID(),'imp-'+d,d,qty,currency,amount,d);}
function seed(f,{qty=2,prev=2,stock=10}={}){
 for(const d of w.days){report(f,d);sale(f,d,d>=w.start?qty:prev,(d>=w.start?qty:prev)*100);}
 f.stock('BAG-A',stock,10);
 f.sqlite.prepare("INSERT INTO promotion_availability VALUES('印尼','TikTok','BAG-A','2026-01-01','2026-01-01',?,'平台历史在售记录','核实有货','id-ops',?)").run(w.cutoff,now.toISOString());
 f.sqlite.prepare('INSERT INTO sales_fx_snapshots VALUES(?,?,?,?,?,?)').run('test','test',now.toISOString(),now.toISOString(),new Date(+now+86400000).toISOString(),JSON.stringify({CNY:1,IDR:2000,MYR:.6,PHP:8,THB:5,VND:3600,USD:.14}));
}
async function finance(f,costs={landed:1700,ads:0,platform:0,fulfillment:0,returns:0},at=now){const r=dbrow(f),s=(await actionCandidates(f.db,f.users.finance,at)).find(s=>actionKey(s)===actionKey(r));await call(f,f.users.finance,'loss','finance',{basisHash:s.financeFingerprint,costs,source:'SKU结算单核对成本202610',confirmed:true},at);await refreshBusinessActions(f.db,f.users.admin,at);}
async function assign(f,kind='loss',at=now){return call(f,f.users.admin,kind,'assign',{ownerId:kind==='stockout'?f.users.supply.id:f.users.indonesia.id,collaborators:[f.users.finance.id],dueAt:new Date(+at+86400000).toISOString(),reviewAt:new Date(+at+3*86400000).toISOString()},at);}

test('经营窗口按五站当地昨日截止，缺报及未知金额不能变成零',async()=>{
 assert.equal(actionWindow('印尼',new Date('2026-10-22T16:30:00Z')).cutoff,'2026-10-21');assert.equal(actionWindow('菲律宾',new Date('2026-10-22T16:30:00Z')).cutoff,'2026-10-22');
 const f=fixture();seed(f);f.sqlite.prepare("UPDATE sales_imports SET report_kind='partial' WHERE business_date=?").run(w.cutoff);
 let x=(await actionCandidates(f.db,f.users.admin,now)).find(s=>s.kind==='loss'&&s.sku==='BAG-A'&&s.site==='印尼'&&s.channel==='TikTok');assert.equal(x.qty,null);assert.equal(x.profit,null);assert.equal(x.condition,'verify');assert.equal(x.observedQty,14);
 f.sqlite.prepare("UPDATE sales_imports SET report_kind='complete'").run();f.sqlite.prepare('UPDATE sales_records SET reported_amount=NULL WHERE business_date=?').run(w.cutoff);
 x=(await actionCandidates(f.db,f.users.admin,now)).find(s=>s.kind==='loss'&&s.sku==='BAG-A'&&s.site==='印尼'&&s.channel==='TikTok');assert.equal(x.revenue,null);assert.equal(x.profit,null);
 f.sqlite.prepare('DELETE FROM sales_records').run();f.sqlite.prepare('DELETE FROM sales_imports').run();
 x=(await actionCandidates(f.db,f.users.admin,now)).find(s=>s.kind==='stockout'&&s.sku==='BAG-A'&&s.site==='印尼'&&s.channel==='TikTok');assert.equal(x.qty,null);assert.equal(x.condition,'verify');
});
test('独立财务按实际原币逐项核算，重复全店费用不自动分摊，改源数据核算失效',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);
 assert.equal(JSON.parse(dbrow(f).snapshot_json).profit,null);
 await assert.rejects(call(f,f.users.indonesia,'loss','finance',{}),/仅财务/);
 const snapshot=JSON.parse(dbrow(f).snapshot_json);
 await assert.rejects(call(f,f.users.finance,'loss','finance',{basisHash:snapshot.financeFingerprint,costs:{landed:100,ads:'',platform:0,fulfillment:0,returns:0},source:'结算单',confirmed:true}),/广告/);
 await finance(f);let s=JSON.parse(dbrow(f).snapshot_json);assert.equal(s.profit,-300);assert.equal(s.delayAmount,42.86);assert.equal(s.recoverableCny,.15);assert.equal(s.condition,'active');
 f.sqlite.prepare("UPDATE sales_records SET reported_amount=reported_amount+1 WHERE business_date=?").run(w.cutoff);await refreshBusinessActions(f.db,f.users.admin,now);s=JSON.parse(dbrow(f).snapshot_json);assert.equal(s.profit,null);assert.equal(s.condition,'verify');
});
test('跨币种标签错误阻止利润计算，汇率过期保留原币且不冒充人民币',async()=>{
 const f=fixture();seed(f);f.sqlite.prepare("UPDATE sales_records SET currency='CNY'").run();await refreshBusinessActions(f.db,f.users.admin,now);await assert.rejects(finance(f),/原币|齐全/);
 f.sqlite.prepare("UPDATE sales_records SET currency='IDR'").run();await refreshBusinessActions(f.db,f.users.admin,now);await finance(f);
 f.sqlite.prepare("UPDATE sales_fx_snapshots SET effective_at='2026-10-01T00:00:00Z'").run();await refreshBusinessActions(f.db,f.users.admin,now);const s=JSON.parse(dbrow(f).snapshot_json);assert.equal(s.profit,-300);assert.equal(s.delayCny,null);assert.equal(s.fx,null);
});
test('优先排序依据证据与统一币种损失，不用GMV或原币大小排序',()=>{
 const base={site:'印尼',channel:'TikTok',sku:'B',kind:'loss'};
 const rs=[{...base,sku:'GMV',reliability:1,delayCny:999999,recoverableCny:999999,revenue:1e12},{...base,sku:'A',reliability:3,delayCny:10,recoverableCny:100},{...base,sku:'B',reliability:3,delayCny:20,recoverableCny:10}].sort(compareActions);
 assert.deepEqual(rs.map(r=>r.sku),['B','A','GMV']);
});
test('补货逐批匹配ETA，未知与逾期不计及时到货，生产量不重复下单',()=>{
 const b={site:'印尼',channel:'TikTok',sku:'A',name:'A',window:w,available:5,sales:w.days.slice(-7).map(d=>({business_date:d,qty:2,reported_amount:200,currency:'IDR'})),complete:w.days,observations:[],finance:{data:{landed:700,ads:0,platform:0,fulfillment:0,returns:0}},setting:{production_lead_days:2,sea_lead_days:3,review_cycle_days:2,min_order_qty:1,order_multiple:1},forecast:{productionInProgress:3,projection:{curve:[{date:'2026-10-28',arrivalQty:4}],unknownArrivalQty:0}},fx:{status:'fresh',rates:{IDR:2000}}};
 let s=evaluateActions(b).find(s=>s.kind==='stockout');assert.equal(s.condition,'active');assert.equal(s.supply.projection.firstShortageDate,'2026-10-26');assert.equal(s.supply.suggestedQty,2);
 b.forecast.projection.unknownArrivalQty=4;s=evaluateActions(b).find(s=>s.kind==='stockout');assert.equal(s.condition,'verify');assert.equal(s.supply.suggestedQty,null);
 b.forecast.projection.unknownArrivalQty=0;b.available=-5;s=evaluateActions(b).find(s=>s.kind==='stockout');assert.equal(s.condition,'verify');assert.equal(s.supply.suggestedQty,null);
});
test('积压动销先验证14天持续在售有货，下降阈值与库存覆盖独立核对',async()=>{
 const f=fixture();seed(f,{qty:1,prev:4,stock:100});await refreshBusinessActions(f.db,f.users.admin,now);let s=JSON.parse(dbrow(f,'weakening').snapshot_json);assert.equal(s.condition,'active');assert.equal(s.growth,-75);assert.equal(s.cover,100);
 f.sqlite.prepare("INSERT INTO promotion_stock_days VALUES('印尼','TikTok','BAG-A',?,0,'x','x')").run(w.start);await refreshBusinessActions(f.db,f.users.admin,now);s=JSON.parse(dbrow(f,'weakening').snapshot_json);assert.equal(s.condition,'verify');assert.equal(s.covered14,false);
});
test('同一问题跨天不重复创建，不自动结案，执行与原始业务完全隔离',async()=>{
 const f=fixture();seed(f);const before=f.sqlite.prepare('SELECT * FROM inventory_balances').all(),sales=f.sqlite.prepare('SELECT * FROM sales_records').all();await refreshBusinessActions(f.db,f.users.admin,now);const id=dbrow(f).id,count=f.sqlite.prepare('SELECT count(*) n FROM business_actions').get().n;
 await refreshBusinessActions(f.db,f.users.admin,now);await refreshBusinessActions(f.db,f.users.admin,new Date(+now+86400000));assert.equal(dbrow(f).id,id);assert.ok(f.sqlite.prepare('SELECT site,channel,sku,kind,count(*) n FROM business_actions GROUP BY site,channel,sku,kind').all().every(r=>r.n===1));assert.equal(dbrow(f).status,'open');
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM inventory_balances').all(),before);assert.deepEqual(f.sqlite.prepare('SELECT * FROM sales_records').all(),sales);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM series_purchase_orders').get().n,0);
});
test('人选需管理员明确确认且匹配唯一主责岗位，失效账号不得继续执行',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);
 await assert.rejects(call(f,f.users.indonesia,'loss','start'),/确认有效/);
 await assert.rejects(call(f,f.users.supply,'loss','assign',{ownerId:f.users.indonesia.id}),/仅管理员/);
 await assert.rejects(call(f,f.users.admin,'loss','assign',{ownerId:f.users.malaysia.id}),/匹配/);
 await assign(f);await call(f,f.users.indonesia,'loss','start');assert.equal(dbrow(f).status,'in_progress');
 f.sqlite.prepare("UPDATE users SET active=0 WHERE id='id-ops'").run();await assert.rejects(call(f,f.users.indonesia,'loss','execute',{source:'执行记录',reviewAt:new Date(+now+2*86400000).toISOString()}),/有效/);
});
test('执行后必须等待和读取新证据，负贡献未改善不允许关闭；改善后复查及再次触发同单',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);await finance(f);await assign(f);
 const at=new Date(+now+2*86400000),payload={source:'平台复查数据202610',outcome:'resolved'};
 await call(f,f.users.indonesia,'loss','execute',{source:'平台活动人工调整记录',reviewAt:at.toISOString()});assert.equal(dbrow(f).status,'review_pending');
 await assert.rejects(call(f,f.users.finance,'loss','review',payload),/尚未到/);
 for(const d of ['2026-10-23','2026-10-24']){report(f,d);sale(f,d);}
 await refreshBusinessActions(f.db,f.users.admin,at);await finance(f,undefined,at);
 await assert.rejects(call(f,f.users.finance,'loss','review',payload,at),/问题仍触发/);
 await finance(f,{landed:700,ads:0,platform:0,fulfillment:0,returns:0},at);await call(f,f.users.finance,'loss','review',payload,at);assert.equal(dbrow(f).status,'resolved');
 const id=dbrow(f).id;await finance(f,undefined,at);assert.equal(dbrow(f).status,'open');assert.equal(dbrow(f).id,id);assert.equal(dbrow(f).reopen_count,1);
 const hist=await actionHistory(f.db,f.users.admin,id);assert.ok(hist.some(h=>h.event==='review'&&h.detail.before&&h.detail.after));assert.ok(hist.some(h=>h.event==='reopen'));
});
test('弱动销必须先记录四类诊断，未知可留待核实但不可自动降价',async()=>{
 const f=fixture();seed(f,{qty:1,prev:4,stock:100});await refreshBusinessActions(f.db,f.users.admin,now);await assign(f,'weakening');
 await assert.rejects(call(f,f.users.indonesia,'weakening','execute',{source:'已修改素材',reviewAt:new Date(+now+2*86400000).toISOString()}),/先记录/);
 await call(f,f.users.indonesia,'weakening','diagnose',{diagnosis:{traffic:'曝光降低报表证据',conversion:'转化稳定报表证据',price:'价格持平竞品证据',quality:'待核实评价与退货数据'},measure:'先改主图素材并观察点击',source:'平台经营分析报表'});
 await call(f,f.users.indonesia,'weakening','execute',{source:'素材修改记录链接',reviewAt:new Date(+now+2*86400000).toISOString()});assert.equal(dbrow(f,'weakening').status,'review_pending');
});
test('权限覆盖读、写及历史，工厂无利润字段，运营跨站不可见，供应链无成本明细',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);await finance(f);
 const id=dbrow(f).id;for(const a of [{role:'工厂',id:'f'},f.users.sales,{role:'海运',id:'sea'}]){await assert.rejects(readBusinessActions(f.db,a),/仅开放/);await assert.rejects(actionHistory(f.db,a,id),/仅开放/);await assert.rejects(refreshBusinessActions(f.db,a),/仅开放/);}
 assert.ok((await readBusinessActions(f.db,f.users.indonesia)).records.every(r=>r.site==='印尼'&&r.channel==='TikTok'));
 await assert.rejects(actionHistory(f.db,f.users.malaysia,id),/无权/);
 const supply=await readBusinessActions(f.db,f.users.supply);assert.ok(!JSON.stringify(supply).includes('"costs"'));assert.ok(!JSON.stringify(supply).includes('"unitContribution"'));assert.ok(!JSON.stringify(await actionHistory(f.db,f.users.supply,id)).includes('"costs"'));
});
test('并发修改只有一次成功，过期版本不会覆盖责任或执行内容',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);await assign(f);const r=dbrow(f),p={id:r.id,version:r.version,action:'comment',note:'并发跟进验证不会覆盖'};
 const results=await Promise.allSettled([mutateBusinessAction(f.db,f.users.admin,p,now),mutateBusinessAction(f.db,f.users.admin,p,now)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await actionHistory(f.db,f.users.admin,r.id)).filter(h=>h.event==='comment').length,1);
});
test('源数据竞争时复查与核算原子回滚，维护锁和完整备份覆盖新台账',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);await finance(f);await assign(f);
 const batch=f.db.batch;f.db.batch=async ss=>{f.sqlite.prepare("UPDATE sales_records SET reported_amount=reported_amount+1 WHERE business_date=?").run(w.cutoff);return batch(ss);};
 const count=f.sqlite.prepare('SELECT count(*) n FROM business_action_finance').get().n;await assert.rejects(finance(f),/变化/);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM business_action_finance').get().n,count);f.db.batch=batch;
 const root=mkdtempSync(join(tmpdir(),'business-actions-'));try{const bucket=fileBucket(join(root,'files'));const stream=await backupStream(f.db,bucket,f.users.admin);await assert.rejects(refreshBusinessActions(f.db,f.users.admin,now),/备份|迁移/);assert.throws(()=>f.sqlite.prepare("UPDATE business_actions SET status='resolved'").run(),/maintenance/);await stream.cancel();
 const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:bucket},path);const dir=join(root,'restored');await restoreBackup(path,dir);const db=openDatabase(join(dir,'business.sqlite'));assert.equal(db.sqlite.prepare('SELECT owner_id FROM business_actions WHERE id=?').get(dbrow(f).id).owner_id,'id-ops');assert.ok(db.sqlite.prepare('SELECT count(*) n FROM business_action_events').get().n>0);assert.equal(db.sqlite.prepare('SELECT count(*) n FROM business_action_finance').get().n,count);db.sqlite.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('经营待办按责任聚合，不每天为每SKU重复刷屏',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);let tasks=await businessActionTasks(f.db,f.users.admin,now);assert.equal(tasks.length,1);assert.equal(tasks[0].tab,'business-actions');assert.deepEqual(await businessActionTasks(f.db,{role:'工厂'}),[]);
 await assign(f);tasks=await businessActionTasks(f.db,f.users.indonesia,now);assert.equal(tasks.length,1);
});
test('最初资料不足、核实后未触发可排除；真实问题不可绕过执行复查；次期缺证据重开原单',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);await finance(f,{landed:700,ads:0,platform:0,fulfillment:0,returns:0});
 assert.equal(dbrow(f).ever_active,0);const id=dbrow(f).id;
 await call(f,f.users.finance,'loss','dismiss',{source:'核算单确认盈利无需止损'});assert.equal(dbrow(f).status,'resolved');
 await refreshBusinessActions(f.db,f.users.admin,new Date(+now+86400000));assert.equal(dbrow(f).status,'open');assert.equal(dbrow(f).id,id);assert.equal(JSON.parse(dbrow(f).snapshot_json).condition,'verify');
 await refreshBusinessActions(f.db,f.users.admin,now);await finance(f);assert.equal(dbrow(f).ever_active,1);
 await finance(f,{landed:700,ads:0,platform:0,fulfillment:0,returns:0});await assert.rejects(call(f,f.users.finance,'loss','dismiss',{source:'仍须执行与复查'}),/只可核实排除/);
});

test('止损后销量归零仍须核实广告等费用，确认无持续损失后才能复查关闭',async()=>{
 const f=fixture();seed(f);await refreshBusinessActions(f.db,f.users.admin,now);await finance(f);await assign(f);
 const at=new Date(+now+8*86400000);await call(f,f.users.indonesia,'loss','execute',{source:'停止亏损活动并保留平台记录',reviewAt:at.toISOString()});
 for(const d of actionWindow('印尼',at).days.slice(-7))report(f,d);
 await refreshBusinessActions(f.db,f.users.admin,at);let s=JSON.parse(dbrow(f).snapshot_json);assert.equal(s.qty,0);assert.equal(s.revenue,0);assert.equal(s.profit,null);
 await assert.rejects(call(f,f.users.finance,'loss','review',{source:'平台结算报表核查',outcome:'resolved'},at),/证据未齐/);
 await finance(f,{landed:0,ads:10,platform:0,fulfillment:0,returns:0},at);s=JSON.parse(dbrow(f).snapshot_json);assert.equal(s.condition,'active');assert.equal(s.profit,-10);
 await finance(f,{landed:0,ads:0,platform:0,fulfillment:0,returns:0},at);await call(f,f.users.finance,'loss','review',{source:'核对无销量且无剩余费用',outcome:'resolved'},at);assert.equal(dbrow(f).status,'resolved');
});
