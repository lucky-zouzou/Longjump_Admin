import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {compareActions} from '../lib/business-action-model.mjs';
import {readBusinessActions,readBusinessAction,publicAction,businessActionTasks} from '../lib/business-actions.mjs';

function setup(t){
 const f=fixture();t.after(()=>f.sqlite.close());
 f.add=(id,patch={})=>{
  const {site='印尼',channel='TikTok',status='open',condition='active',mustActInDays=1,reliability=3,recoverableCny=100,...rest}=patch;
  const s={site,channel,sku:id,kind:'loss',name:'测试商品',condition,mustActInDays,reliability,recoverableCny,title:'核对经营贡献',today:'核对折扣及广告',mustActDate:'2026-11-14',currency:'IDR',profit:-100,window:{start:'2026-11-06',cutoff:'2026-11-12'},costs:{landed:200},financeDays:Array.from({length:7},(_,i)=>({date:'2026-11-'+(i+6),status:'confirmed',source:'TEST-FINANCE-PROOF'})),financeSource:'TEST-FINANCE-PROOF',supply:{projection:{curve:Array.from({length:82},(_,i)=>({day:i,arrivalQty:0,unmetDemand:2,available:0}))}},...rest};
  f.sqlite.prepare("INSERT INTO business_actions(id,site,channel,sku,kind,status,snapshot_json,due_at,review_at,opened_at,updated_at) VALUES(?,?,?,?,'loss',?,?,?,'2026-11-16','2026-11-13','2026-11-13')").run(id,site,channel,id,status,JSON.stringify(s),'2026-11-14');
  return s;
 };return f;
}
test('queue keeps ranking and visible card/health fields while heavy evidence is fetched by ID',async t=>{
 const f=setup(t);f.add('tomorrow',{recoverableCny:1});f.add('large-later',{mustActInDays:30,recoverableCny:1e6});f.add('verify',{condition:'verify'});f.add('clear',{condition:'clear'});f.add('resolved',{status:'resolved'});
 const full=f.sqlite.prepare('SELECT * FROM business_actions').all().map(r=>publicAction(r,f.users.admin)).sort(compareActions);
 const result=await readBusinessActions(f.db,f.users.admin);
 assert.deepEqual(result.records.map(r=>r.id),full.map(r=>r.id));assert.equal(result.records[0].id,'tomorrow');
 assert(result.summaryOnly);assert(Buffer.byteLength(JSON.stringify(result.records))<Buffer.byteLength(JSON.stringify(full))*.2);
 for(const r of result.records){const original=full.find(x=>x.id===r.id);for(const key of ['name','condition','title','today','mustActDate','profit','currency'])assert.deepEqual(r.snapshot[key],original.snapshot[key]);assert.deepEqual(r.snapshot.window.cutoff,original.snapshot.window.cutoff);assert.equal(r.snapshot.supply,undefined);assert.equal(r.snapshot.financeDays,undefined);assert.equal(r.snapshot.costs,undefined);}
 assert.deepEqual(await readBusinessAction(f.db,f.users.admin,'tomorrow'),full[0]);
 const legacy=await readBusinessActions(f.db,f.users.admin,new Date(),{summaryOnly:false});assert.equal(legacy.summaryOnly,false);assert.deepEqual(legacy.records,full);
 const legacySupply=await readBusinessActions(f.db,f.users.supply,new Date(),{summaryOnly:false});assert(!JSON.stringify(legacySupply).includes('TEST-FINANCE-PROOF'));
 f.sqlite.prepare("UPDATE business_actions SET version=version+1,diagnosis_json=? WHERE id='tomorrow'").run(JSON.stringify({measure:'新诊断'}));
 assert.equal((await readBusinessAction(f.db,f.users.admin,'tomorrow')).diagnosis.measure,'新诊断');assert.equal((await readBusinessActions(f.db,f.users.admin)).records[0].version,2);
});
test('list and detail preserve operator scope, role denial and supply-chain finance redaction',async t=>{
 const f=setup(t);f.add('own');f.add('other-platform',{channel:'Shopee'});f.add('other-country',{site:'马来西亚'});
 assert.deepEqual((await readBusinessActions(f.db,f.users.indonesia)).records.map(r=>r.id),['own']);
 for(const id of ['other-platform','other-country','absent'])await assert.rejects(readBusinessAction(f.db,f.users.indonesia,id),e=>e.status===404);
 for(const role of ['工厂','销售','海运']){await assert.rejects(readBusinessActions(f.db,{role}),e=>e.status===403);await assert.rejects(readBusinessAction(f.db,{role},'own'),e=>e.status===403);}
 const result=await readBusinessActions(f.db,f.users.supply),detail=await readBusinessAction(f.db,f.users.supply,'own');
 assert.equal(result.records[0].snapshot.profitState,'负贡献');assert.equal(detail.snapshot.profitState,'负贡献');
 for(const payload of [result,detail])for(const secret of ['"profit":','"costs":','"recoverableCny":','TEST-FINANCE-PROOF','"financeDays":'])assert(!JSON.stringify(payload).includes(secret));
 assert.equal(detail.snapshot.supply.projection.curve.length,82);
 assert((await readBusinessActions(f.db,f.users.indonesia)).users.every(u=>u.role!=='运营'||u.site==='印尼'&&u.channel==='TikTok'));
});
test('lightweight navigation badge keeps ownership, verification scopes and overdue rules',async t=>{
 const f=setup(t);f.add('active');f.add('pending',{condition:'verify'});f.add('owned',{condition:'verify'});f.add('resolved',{status:'resolved'});
 f.sqlite.prepare("UPDATE business_actions SET owner_id='id-ops' WHERE id='owned'").run();
 const now=new Date('2026-11-15T05:00:00Z');
 const admin=await businessActionTasks(f.db,f.users.admin,now);assert.match(admin[0].detail,/1条经营行动/);assert.match(admin[0].detail,/1个站点渠道/);assert.match(admin[0].detail,/1条已到期/);
 const ops=await businessActionTasks(f.db,f.users.indonesia,now);assert.match(ops[0].detail,/1条经营行动/);assert.match(ops[0].detail,/1条证据待核实/);assert.match(ops[0].detail,/1条已到期/);
});
