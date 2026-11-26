import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFixture,brief,date,ago} from './content-center-fixture.mjs';
import {workspaceTasks} from '../lib/workspace-tasks.mjs';
import {readPlatformReports,previewReport,reportHistory} from '../lib/content-center.mjs';
import {readEvidenceWorkbench,mutateEvidenceTask,readEvidenceVoucher,evidenceHandoffs} from '../lib/evidence-workbench.mjs';
import {answerWithKnowledge} from '../lib/employee-assistant.mjs';

test('内容交接按人、站点及当前版本切换，旧待办退出',async t=>{
 const f=contentFixture();t.after(()=>f.sqlite.close());
 const {indonesia:op,malaysia}=f.users,desk=async user=>(await workspaceTasks(f.db,user)).filter(t=>t.tab==='content-center');
 const id=(await f.act(op,'create',{...brief,due:date()})).id;
 assert.equal((await desk(f.camera))[0].entity,id);
 await f.act(f.camera,'schedule',{scriptId:id,version:1,shoot:date(),delivery:date()});
 assert.equal((await desk(f.camera))[0].title,'交付成片');
 const deliver=async version=>(await f.act(f.camera,'deliver',{scriptId:id,version,label:'样片',storyboard:'通勤包容量演示',master:'https://example.test/cut'})).id;
 const first=await deliver(2);assert.equal((await desk(f.camera)).length,0);assert.equal((await desk(op))[0].entity,first);assert.equal((await desk(malaysia)).length,0);
 await f.act(op,'return',{versionId:first,version:1,feedback:'请补拍容量特写'});assert.equal((await desk(op)).length,0);assert.equal((await desk(f.camera))[0].title,'按反馈改拍');
 const second=await deliver(4);await f.act(op,'accept',{versionId:second,version:1});
 assert.equal((await desk(op)).length,0);assert.equal((await desk(f.camera)).length,0);
});

test('平台报表差异预览、保留省略值、显式清空、旧预览冲突与按站点修订历史',async t=>{
 const f=contentFixture();t.after(()=>f.sqlite.close());const op=f.users.malaysia,site='马来西亚',videoId='987654321001';
 const base={site,currency:'MYR',start:ago(5).slice(0,10),end:date(),file:'运营.csv'},save=(row,more={})=>f.act(op,'importPlatformReport',{...base,...more,rows:[{videoId,...row}]});
 await save({views:500,attributedGmv:120});
 let delta=(await previewReport(f.db,op,{...base,rows:[{videoId,views:550}]})).rows[0];assert.equal(delta.fields.find(f=>f.key==='attributedGmv').kind,'keep');
 await save({views:550,expectedRevision:1});assert.deepEqual((await readPlatformReports(f.db,op,site)).rows[0].metrics,{views:550,attributedGmv:120});
 await save({views:550,expectedRevision:2});assert.equal((await readPlatformReports(f.db,op,site)).rows[0].revision,2);
 await assert.rejects(save({views:0,expectedRevision:1},{clearMissing:true}),{status:409});
 await save({views:0,expectedRevision:2},{clearMissing:true});
 const history=await reportHistory(f.db,op,site,base.start,base.end,videoId,0);
 assert.deepEqual(history.rows.map(r=>r.revision),[3,2,1]);assert.deepEqual(history.rows[0].metrics,{views:0});
 await assert.rejects(reportHistory(f.db,f.users.indonesia,site,base.start,base.end,videoId,0),{status:403});
});

test('原币凭据只读、按录入范围退回、源数据修正后转财务复核',async t=>{
 const f=contentFixture();t.after(()=>f.sqlite.close());const {finance,indonesia,malaysia}=f.users,day=ago(2).slice(0,10);
 f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES('sample','sample',?,'印尼','TikTok',1,1,?,?,'complete')").run(day,indonesia.id,day);
 f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,currency,reported_amount,actor_id,created_at) VALUES('line','sample',?,'印尼','TikTok','BAG-A',1,'IDR',NULL,?,?)").run(day,indonesia.id,day);
 const get=async()=>(await readEvidenceWorkbench(f.db,finance)).tasks.find(r=>r.kind==='money');
 let task=await get();assert.equal(new URL(task.href,'https://example.test').searchParams.get('view'),'evidence');
 assert.equal((await readEvidenceVoucher(f.db,finance,task.key)).rows[0].import_id,'sample');await assert.rejects(readEvidenceVoucher(f.db,malaysia,task.key),{status:404});
 const payload={key:task.key,version:task.version,basisHash:task.basisHash,action:'evidenceReturn',note:'请补日报成交金额'};
 await assert.rejects(mutateEvidenceTask(f.db,finance,{...payload,operatorId:malaysia.id}));
 await mutateEvidenceTask(f.db,finance,{...payload,operatorId:indonesia.id});
 assert.equal((await evidenceHandoffs(f.db,indonesia))[0].entity,task.key);assert.deepEqual(await evidenceHandoffs(f.db,malaysia),[]);
 const summary=await readEvidenceWorkbench(f.db,finance,new Date(),{summary:true});assert(summary.items.some(x=>x.key===task.key&&x.skuCount===1));
 f.sqlite.prepare("UPDATE sales_records SET reported_amount=75000 WHERE id='line'").run();
 assert.deepEqual(await evidenceHandoffs(f.db,indonesia),[]);assert.equal((await evidenceHandoffs(f.db,finance))[0].title,'复核运营已更正的日报');
 task=await get();assert.equal(task.status,'review_ready');assert.equal((await readEvidenceVoucher(f.db,finance,task.key)).rows[0].reported_amount,75000);
 await mutateEvidenceTask(f.db,finance,{action:'evidenceReview',key:task.key,version:task.version,basisHash:task.basisHash,note:'已复查销售凭据'});assert.deepEqual(await evidenceHandoffs(f.db,finance),[]);
});

test('小品库存明确口径、原币台账入口及权限，库存实时读取',async t=>{
 const f=contentFixture();t.after(()=>f.sqlite.close());const ask=(a,q)=>answerWithKnowledge(f.db,a,{question:q,mode:'internal'},{apiKey:''});
 const {admin,indonesia,malaysia,finance}=f.users;
 const choice=await ask(admin,'印尼库存还有多少件？');assert.equal(choice.ledger.page,'inventory');assert.equal(choice.questions.length,2);
 f.sqlite.prepare("UPDATE inventory_balances SET qty=59,reserved_qty=9 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").run();
 let reply=await ask(indonesia,'印尼 TikTok SKU BAG-A 可售库存有多少件？');assert.match(reply.answer,/50 件/);
 f.sqlite.prepare("UPDATE inventory_balances SET qty=60 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'").run();
 assert.match((await ask(indonesia,'印尼 TikTok SKU BAG-A 可售库存有多少件？')).answer,/51 件/);
 assert.match((await ask(malaysia,'印尼可售库存有多少件？')).answer,/你的账号可以查马来西亚/);
 const cash=await ask(finance,'这个月平台回款多少？');assert.equal(cash.ledger.page,'finance-workbench');assert.equal(cash.ledger.view,'expenses');assert.match(cash.answer,/登记银行到账/);assert.match(cash.answer,/依据/);
 assert.equal((await ask(admin,'这月利润多少？')).ledger.view,'evidence');
 assert.equal((await ask(indonesia,'昨天销量是多少？')).ledger.page,'sales');
});
