import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {systemFixture,svc,race} from './system-fixture.mjs';
import {mutateCreator,readCreators,creatorWorkspaceTasks} from '../lib/creators.mjs';
import {creatorMetrics,creatorFees,financeValue} from '../lib/creator-model.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBackup,restoreBackup} from '../server/backup.mjs';
import {openDatabase,fileBucket} from '../server/storage.mjs';
const now=()=>new Date().toISOString(),future=()=>new Date(Date.now()+7*86400000).toISOString(),ago=d=>new Date(Date.now()-d*86400000).toISOString();
const proof='https://evidence.example.test/source';
async function setup(base=fixture()){
 const f=base,t=now();f.users.bd={id:'bd-1',name:'测试BD',role:'达人BD'};f.users.bd2={id:'bd-2',name:'另一BD',role:'达人BD'};
 for(const u of [f.users.bd,f.users.bd2])f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u.id,u.id+'@example.test',u.name,u.role,t,t);
 f.act=(who,action,p={})=>mutateCreator(f.db,who,{action,...p});
 f.scope=(await f.act(f.users.admin,'scope',{site:'印尼',platform:'TikTok',shop:'TEST-SHOP',operatorId:f.users.indonesia.id,backupId:f.users.malaysia.id,bdId:f.users.bd.id})).id;
 f.follow=(owner=f.users.indonesia.id)=>({nextOwner:owner,nextAt:future(),nextAction:'核对并跟进样品交付'});
 f.create=async(overrides={})=>(await f.act(f.users.indonesia,'create',{scopeId:f.scope,platformId:'@Test-Creator',name:'测试达人',kind:'both',profileUrl:'https://www.tiktok.com/@test-creator',contact:'测试联系方式',language:'印尼语',fit:'箱包内容受众匹配',evidence:proof,...f.follow(),...overrides})).id;
 f.p=id=>f.sqlite.prepare('SELECT * FROM creator_profiles WHERE id=?').get(id);
 f.r=id=>f.sqlite.prepare('SELECT * FROM creator_rounds WHERE id=?').get(id);
 f.change=(who,creatorId,action,params={})=>f.act(who,action,{creatorId,version:params.roundId?f.r(params.roundId).version:f.p(creatorId).version,...params});
 f.accept=async(id)=>{await f.change(f.users.indonesia,id,'contact',{at:ago(3),note:'首次联系',evidence:proof,...f.follow()});await f.change(f.users.indonesia,id,'reply',{at:ago(2),note:'明确愿意合作',evidence:proof,...f.follow()});await f.change(f.users.indonesia,id,'handoff',{sku:'BAG-A',fit:'受众符合',intent:'愿意拍视频',proposal:'视频一条',quote:'佣金按协议',openIssues:'无',evidence:proof,at:ago(1),...f.follow()});await f.change(f.users.bd,id,'accept',{note:'接受商务跟进',...f.follow(f.users.bd.id)});};
 f.round=async(id,overrides={})=>{await f.change(f.users.bd,id,'round',{items:[{sku:'BAG-A',sampleQty:1},{sku:'BAG-B',sampleQty:1}],videos:1,lives:0,currency:'CNY',budget:'50',commission:'销售额10%',requirements:'视频准确展示商品',rights:'无二次投流授权',stockCheck:'库存已向运营核实',zone:'Asia/Jakarta',dueAt:future(),evidence:proof,...overrides});return f.sqlite.prepare('SELECT id FROM creator_rounds WHERE creator_id=? ORDER BY created_at DESC').get(id).id;};
 f.approve=(id,r)=>f.change(f.users.admin,id,'approve',{roundId:r,note:'核对后批准本轮条件'});
 f.finance=(id,r,overrides={})=>f.change(f.users.finance,id,'finance',{roundId:r,date:now().slice(0,10),sourceRef:'SETTLEMENT-'+r,currency:'CNY',rate:1,rateBasis:'人民币无需折算',netRevenue:'100',orders:3,ordersFrom:ago(20),ordersAsOf:now(),costs:Object.fromEntries(Object.keys(creatorFees).map(k=>[k,{mode:'separate',amount:'1',evidence:'核对账单第1行'}])),confirmed:true,evidence:proof,note:'首次核验累计数据',...overrides});
 return f;
}

test('creator scopes are independent of sales scopes and prohibit unrelated actors',async()=>{
 const f=await setup(),id=await f.create();
 assert.equal((await readCreators(f.db,f.users.malaysia)).profiles.length,1); // Explicit backup in Indonesia.
 assert.equal((await readCreators(f.db,f.users.bd2)).profiles.length,0);
 await assert.rejects(()=>readCreators(f.db,f.users.supply),/没有达人/);
 await assert.rejects(()=>f.change(f.users.bd2,id,'follow',{note:'越权',...f.follow()}),/其他店铺/);
 await assert.rejects(()=>f.change(f.users.finance,id,'follow',{note:'越权',...f.follow()}),/岗位不能/);
 const original=f.p(id).source_user_id;
 const s=f.sqlite.prepare('SELECT * FROM creator_scopes WHERE id=?').get(f.scope);
 await f.act(f.users.admin,'scope',{site:s.site,platform:s.platform,shop:s.shop,version:s.version,operatorId:f.users.malaysia.id,bdId:f.users.bd.id});
 assert.equal(f.p(id).next_owner_id,f.users.malaysia.id);assert.equal(f.p(id).source_user_id,original);
 assert.equal((await readCreators(f.db,f.users.indonesia)).profiles.length,0);
});

test('canonical creator IDs prevent duplicates while separate stores remain separate',async()=>{
 const f=await setup();await f.create();await assert.rejects(()=>f.create({platformId:'  TEST-CREATOR '}),/已登记/);
 await assert.rejects(()=>f.create({platformId:'@'}),/平台唯一ID/);await assert.rejects(()=>f.create({platformId:'wrong id'}),/不能包含空格/);
 const scope=(await f.act(f.users.admin,'scope',{site:'泰国',platform:'TikTok',shop:'TEST-TH',operatorId:f.users.indonesia.id,bdId:f.users.bd.id})).id;
 await f.create({scopeId:scope});const data=await readCreators(f.db,f.users.admin);assert.equal(data.profiles.length,2);assert.equal(data.metrics.people,1);
});

test('backup operators retain their original lead attribution when creating a profile',async()=>{
 const f=await setup();const {id}=await f.act(f.users.malaysia,'create',{scopeId:f.scope,platformId:'backup-source',name:'备份运营建联',kind:'live',profileUrl:'https://www.tiktok.com/@backup-source',contact:'测试联系方式',language:'印尼语',fit:'直播受众匹配',evidence:proof,...f.follow(f.users.malaysia.id)});
 assert.equal(f.p(id).source_user_id,f.users.malaysia.id);
});

test('handoff requires a reply, intent, real SKU and concrete next owner',async()=>{
 const f=await setup(),id=await f.create();await assert.rejects(()=>f.change(f.users.indonesia,id,'handoff',{}),/明确回复/);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'reply',{at:ago(1),note:'a',...f.follow(),evidence:proof}),/先记录触达/);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'follow',{note:'x',...f.follow(f.users.finance.id)}),/已分配/);
 await f.accept(id);assert.equal(f.p(id).state,'negotiating');assert.ok(f.p(id).accepted_at);
 const tasks=await creatorWorkspaceTasks(f.db,f.users.bd);assert.ok(tasks.some(t=>t.entity===id));
});

test('business approval, multi-SKU samples, content acceptance form a complete non-posting loop',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);const r=await f.round(id);const stock=f.sqlite.prepare('SELECT SUM(qty) AS n FROM inventory_balances').get().n;
 await assert.rejects(()=>f.change(f.users.bd,id,'approve',{roundId:r,note:'自审'}),/岗位不能/);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'dispatch',{roundId:r}),/审批/);
 await f.approve(id,r);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'dispatch',{roundId:r,qty:1}),/全部发出/);
 await f.change(f.users.indonesia,id,'dispatch',{roundId:r,qty:2,at:now(),warehouseRef:'WH-TEST-001',carrier:'测试物流',tracking:'TRACK',evidence:proof});
 await f.change(f.users.indonesia,id,'receipt',{roundId:r,at:now(),evidence:proof});
 await assert.rejects(()=>f.change(f.users.indonesia,id,'complete',{roundId:r}),/尚未全部验收/);
 const input={roundId:r,kind:'video',sku:'BAG-A',url:'https://video.example.test/content-1',at:now(),linkValid:true,skuCorrect:true,accurate:true,agreed:false,note:'缺少约定展示，低播放不是不合格原因',evidence:proof};
 await f.change(f.users.indonesia,id,'content',input);const c=f.sqlite.prepare('SELECT * FROM creator_contents WHERE round_id=?').get(r);assert.equal(c.status,'pending');
 await assert.rejects(()=>f.change(f.users.indonesia,id,'content',input),/不能重复/);
 await f.change(f.users.indonesia,id,'contentReview',{...input,contentId:c.id,agreed:true,note:'复验合格'});
 await f.change(f.users.indonesia,id,'complete',{roundId:r,note:'等待7天及30天效果复查',evidence:proof,...f.follow(f.users.bd.id)});
 assert.equal(f.r(r).status,'completed');assert.equal(f.p(id).state,'maintaining');assert.equal(f.sqlite.prepare('SELECT SUM(qty) AS n FROM inventory_balances').get().n,stock);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_records').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_finance_entries').get().n,0);
});

test('extension never rewrites original deadline and needs independent approval',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);const r=await f.round(id);await f.approve(id,r);const original=f.r(r).original_due_at,later=new Date(Date.now()+30*86400000).toISOString();
 await f.change(f.users.bd,id,'extension',{roundId:r,dueAt:later,note:'物流延误，双方确认',evidence:proof});assert.equal(f.r(r).effective_due_at,original);
 await assert.rejects(()=>f.change(f.users.bd,id,'extensionApprove',{roundId:r,accept:true,note:'自己批'}),/岗位不能/);
 await f.change(f.users.admin,id,'extensionApprove',{roundId:r,accept:true,note:'同意并保留原期限'});assert.equal(f.r(r).original_due_at,original);assert.equal(f.r(r).effective_due_at,later);
});

test('observation windows cannot be prematurely scored; missing metrics remain null',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);const r=await f.round(id);await f.approve(id,r);
 await f.change(f.users.indonesia,id,'content',{roundId:r,sku:'BAG-A',kind:'video',url:'https://video.example.test/observe',at:now(),linkValid:true,skuCorrect:true,accurate:true,agreed:true,note:'验收',evidence:proof});
 const c=f.sqlite.prepare('SELECT id FROM creator_contents').get().id;
 await assert.rejects(()=>f.change(f.users.indonesia,id,'observe',{roundId:r,contentId:c,window:7,at:now()}),/未成熟/);
 f.sqlite.prepare('UPDATE creator_contents SET published_at=? WHERE id=?').run(ago(8),c);
 await f.change(f.users.indonesia,id,'observe',{roundId:r,contentId:c,window:7,at:now(),views:100,orders:'',currency:'IDR',note:'其他指标尚未取得',evidence:proof});
 const o=(await readCreators(f.db,f.users.bd)).observations[0];assert.equal(o.data.orders,null);assert.equal(o.data.revenueMinor,null);
});

test('financial costs require explicit evidence, revisions replace rather than sum',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);const r=await f.round(id);await f.approve(id,r);
 await assert.rejects(()=>f.finance(id,r,{costs:{}}),/未核实/);
 await f.finance(id,r);let data=await readCreators(f.db,f.users.admin);assert.equal(data.metrics.verifiedProfitCny,92);
 await f.finance(id,r,{netRevenue:'80',note:'退款修订累计净收入'});data=await readCreators(f.db,f.users.admin);assert.equal(data.finances.length,2);assert.equal(data.metrics.verifiedProfitCny,72);
 assert.equal(financeValue(data.rounds[0],data.finances).revision,2);
 const bad=Object.fromEntries(Object.keys(creatorFees).map(k=>[k,{mode:'included',amount:'1',evidence:'已在净收入'}]));await assert.rejects(()=>f.finance(id,r,{costs:bad}),/额外扣除须为0/);
 assert.throws(()=>f.sqlite.prepare("UPDATE creator_finance SET data_json='{}'").run(),/immutable/);
});

test('duplicate settlement evidence cannot be counted in two rounds and changed delivery needs reverification',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);const a=await f.round(id);await f.approve(id,a);await f.finance(id,a);
 const b=await f.round(id);await f.approve(id,b);await assert.rejects(()=>f.finance(id,b,{sourceRef:'SETTLEMENT-'+a}),/不能重复/);
 await f.change(f.users.bd,id,'extension',{roundId:a,dueAt:new Date(Date.now()+20*86400000).toISOString(),note:'延期',evidence:proof});
 const d=await readCreators(f.db,f.users.finance);assert.equal(financeValue(d.rounds.find(r=>r.id===a),d.finances),null);assert.equal(d.metrics.verifiedProfitCny,null);
});

test('core tier cannot be asserted without completed rounds and verified positive economics',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);
 await assert.rejects(()=>f.change(f.users.bd,id,'tier',{tier:'core',willing:true,note:'想升级',evidence:proof,...f.follow(f.users.bd.id)}),/两轮完整/);
 await assert.rejects(()=>f.change(f.users.bd,id,'tier',{tier:'growing',note:'想升级',evidence:proof,...f.follow(f.users.bd.id)}),/至少需要一轮/);
});

test('concurrent reassignment rolls back stale owner writes and preserves source attribution',async()=>{
 const f=await setup(),id=await f.create(),s=f.sqlite.prepare('SELECT * FROM creator_scopes WHERE id=?').get(f.scope);
 const [old,transfer]=await race(f,()=>f.change(f.users.indonesia,id,'follow',{note:'旧负责人操作',...f.follow()}),()=>f.act(f.users.admin,'scope',{site:s.site,platform:s.platform,shop:s.shop,version:s.version,operatorId:f.users.malaysia.id,bdId:f.users.bd.id}));
 assert.equal(old.ok,false);assert.equal(old.error.status,409);assert.equal(transfer.ok,true);assert.equal(f.p(id).source_user_id,f.users.indonesia.id);
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM creator_events WHERE action='follow'").get().n,0);
});

test('maintenance and closed finance periods prevent writes',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);const r=await f.round(id);await f.approve(id,r);
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,expires_at,updated_at) VALUES('global','backup',?,?)").run(future(),now());await assert.rejects(()=>f.finance(id,r),/备份|维护/);
 f.sqlite.prepare("UPDATE system_maintenance SET mode='normal',expires_at='' WHERE id='global'").run();
 // Period events are covered by the same production finance close rule.
 f.sqlite.prepare("INSERT INTO finance_period_events (id,month,revision,status,evidence,snapshot_json,actor_id,created_at) VALUES (?,?,1,'closed','TEST','{}',?,?)").run('creator-close',now().slice(0,7),f.users.admin.id,now());
 await assert.rejects(()=>f.finance(id,r),/关账/);
});

test('mature cohort rates separate new contacts and preserve original lateness',()=>{
 const today=new Date('2026-10-31T12:00:00Z'),ps=[{id:'a',platform:'TikTok',platform_id:'1',first_contact_at:'2026-10-01T00:00:00Z',first_reply_at:'2026-10-03T00:00:00Z',accepted_at:'2026-10-04T00:00:00Z'},{id:'b',platform:'TikTok',platform_id:'2',first_contact_at:'2026-10-30T00:00:00Z'}];
 const rs=[{id:'r',creator_id:'a',version:1,status:'completed',approved_at:'2026-10-06T00:00:00Z',original_due_at:'2026-10-10T00:00:00Z',effective_due_at:'2026-10-20T00:00:00Z',completed_at:'2026-10-15T00:00:00Z'}];
 const m=creatorMetrics(ps,rs,[],[],today);assert.equal(m.reply7.value,1);assert.equal(m.reply7.denominator,1);assert.equal(m.contactImmature,1);assert.equal(m.first14.value,1);assert.equal(m.repeat60.value,null);assert.equal(m.repeatImmature,1);assert.equal(m.originalOnTime.value,0);assert.equal(m.onTime.value,1);assert.equal(m.verifiedProfitCny,null);
});

test('BD system default and home return only the authorized workspace, never global financial projections',async()=>{
 const f=await setup(systemFixture());svc.setActor(f.users.bd);
 for(const suffix of ['', '?module=home','?module=creators']){const res=await svc.GET(new Request('http://localhost/api/system'+suffix));assert.equal(res.status,200);const d=await res.json();assert.equal(d.module,'creators');assert.deepEqual(d.metrics,{});assert.equal((d.sales||[]).length,0);assert.equal((d.inventory||[]).length,0);}
 for(const module of ['sales','cost-profit','overview','users','fulfillment'])assert.equal((await svc.GET(new Request('http://localhost/api/system?module='+module))).status,403);
});

test('collaboration profiles, immutable history and finance revisions survive full backup and restore',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);const r=await f.round(id);await f.approve(id,r);await f.finance(id,r);await f.finance(id,r,{netRevenue:'70',note:'退款重新核算'});
 const root=mkdtempSync(join(tmpdir(),'lj-creator-backup-'));
 try{const archive=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},archive);await restoreBackup(archive,join(root,'restored'));
  const restored=openDatabase(join(root,'restored','business.sqlite'));
  for(const name of ['creator_scopes','creator_profiles','creator_rounds','creator_events','creator_finance','creator_finance_sources'])assert.deepEqual(restored.sqlite.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(),f.sqlite.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(),name);
  assert.throws(()=>restored.sqlite.prepare('DELETE FROM creator_finance').run(),/immutable/);restored.sqlite.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('round retries are idempotently rejected and tracking parameters do not duplicate content',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);const old=f.p(id).version,r=await f.round(id);
 await assert.rejects(()=>f.change(f.users.bd,id,'round',{version:old}),/记录已更新/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_rounds').get().n,1);await f.approve(id,r);
 const input={roundId:r,sku:'BAG-A',kind:'video',url:'https://video.example.test/retry?utm_source=test',at:now(),linkValid:true,skuCorrect:true,accurate:true,agreed:true,note:'验收',evidence:proof};await f.change(f.users.indonesia,id,'content',input);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'content',{...input,url:'https://video.example.test/retry?utm_source=another'}),/不能重复/);
 await assert.rejects(()=>f.change(f.users.bd,id,'follow',{roundId:r,note:'使用轮次版本覆盖档案',...f.follow()}),/轮次不匹配/);
});

test('parallel cooperation stays active when another round ends and paused profiles cannot be approved',async()=>{
 const f=await setup(),id=await f.create();await f.accept(id);
 const first=await f.round(id,{items:[{sku:'BAG-A',sampleQty:0}]});await f.approve(id,first);
 const second=await f.round(id);await f.approve(id,second);
 await f.change(f.users.indonesia,id,'content',{roundId:first,sku:'BAG-A',kind:'video',url:'https://video.example.test/parallel',at:now(),linkValid:true,skuCorrect:true,accurate:true,agreed:true,note:'验收合格',evidence:proof});
 await f.change(f.users.indonesia,id,'complete',{roundId:first,note:'第一轮完成，第二轮仍在履约',evidence:proof,...f.follow()});
 assert.equal(f.p(id).state,'fulfilling');
 await f.change(f.users.admin,id,'cancel',{roundId:second,note:'双方同意终止并核对费用',evidence:proof});assert.equal(f.p(id).state,'maintaining');
 const pending=await f.round(id);
 await f.change(f.users.bd,id,'tier',{tier:'paused',note:'暂停新增合作',evidence:proof,...f.follow()});
 await assert.rejects(()=>f.approve(id,pending),/已暂停/);
 await f.change(f.users.bd,id,'resume',{note:'确认可恢复跟进',...f.follow(f.users.bd.id)});assert.equal(f.p(id).tier,'trial');
 await f.approve(id,pending);assert.equal(f.p(id).state,'fulfilling');
});
