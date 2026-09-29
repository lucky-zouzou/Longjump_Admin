import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {race} from './system-fixture.mjs';
import {mutateReview,readReviews,reviewSnapshot,reviewTasks} from '../lib/business-reviews.mjs';
import {reviewPeriod,reviewToday,addDays,normalizeReviewData,derivedReviewMetrics} from '../lib/business-review-model.mjs';
const content={summary:'本期销售目标尚未达成',win:'素材测试发现可复制案例',problem:'部分商品转化低于目标',rootCause:'详情页卖点说明不清晰',support:'需要设计提供素材支持',nextResult:'下周完成3款商品详情优化',metrics:{gmv:{actual:100,target:200,nextTarget:250,source:'平台经营报表2026-09'}}};
async function create(f,actor=f.users.indonesia,kind='weekly'){return (await mutateReview(f.db,actor,{action:'create',kind,date:reviewToday()})).id;}
const row=(f,id)=>f.sqlite.prepare('SELECT * FROM business_reviews WHERE id=?').get(id);
async function change(f,id,actor,action,extra={}){return mutateReview(f.db,actor,{id,version:row(f,id).version,action,...extra});}
async function action(f,id,owner=f.users.indonesia){await change(f,id,f.users.indonesia,'addAction',{title:'优化商品详情',target:'完成3款并回看转化率',ownerId:owner.id,dueDate:addDays(reviewToday(),7)});}
test('大小休按已确认的10月3日周六基准交替，统计截止日前七天，跨年日期有效',()=>{
 const a=reviewPeriod('weekly','2026-09-29','2026-09-29');assert.equal(a.deadline,'2026-10-03');assert.equal(a.start,'2026-09-26');assert.equal(a.end,'2026-10-02');assert.equal(a.dueAt,'2026-10-03T07:00:00.000Z');
 const b=reviewPeriod('weekly','2026-10-05','2026-10-05');assert.equal(b.deadline,'2026-10-09');assert.equal(b.start,'2026-10-02');assert.equal(b.end,'2026-10-08');
 assert.equal(reviewPeriod('weekly','2027-01-01','2027-01-01').end,'2026-12-31');assert.throws(()=>reviewPeriod('weekly','2026-02-30'),/有效/);
 const m=reviewPeriod('monthly','2026-09-28','2026-09-28');assert.equal(m.asOf,'2026-09-27');assert.equal(m.partial,true);assert.equal(m.end,'2026-09-30');
});
test('平台指标保留未知与零；实际值须有来源，零分母不制造ROAS',()=>{
 const v=normalizeReviewData({...content,metrics:{gmv:{actual:0,source:'平台零成交'}}},'TikTok',true);assert.equal(v.metrics.gmv.actual,0);assert.equal(v.metrics.orders.actual,null);
 assert.throws(()=>normalizeReviewData({...content,metrics:{gmv:{actual:2}}},'TikTok',true),/来源/);assert.throws(()=>normalizeReviewData({metrics:{gmv:{actual:-1}}},'TikTok'),/非负/);
 assert.equal(derivedReviewMetrics({adGmv:100},0).adRoas,null);assert.equal(derivedReviewMetrics({adGmv:100},20).adRoas,5);
});
test('仅运营创建本人报告，草稿不向管理协作岗披露，其他运营不能访问',async()=>{
 const f=fixture(),id=await create(f);for(const actor of [f.users.sales,f.users.admin,f.users.supply,f.users.finance])await assert.rejects(create(f,actor),/无权|仅/);
 assert.equal((await readReviews(f.db,f.users.malaysia,{date:reviewToday()})).reports.length,0);
 assert.equal((await readReviews(f.db,f.users.supply,{date:reviewToday()})).reports.length,0);
 await assert.rejects(change(f,id,f.users.malaysia,'save',{data:content}),/无权/);
 assert.equal((await create(f)),id);
});
test('草稿→提交→退回→重提→复核，提交时重读系统快照，保留历史与月底修订',async()=>{
 const f=fixture(),id=await create(f);await assert.rejects(change(f,id,f.users.indonesia,'submit',{data:content}),/行动/);await action(f,id);
 await change(f,id,f.users.indonesia,'save',{data:content});await change(f,id,f.users.indonesia,'submit',{data:content});assert.equal(row(f,id).status,'submitted');assert.ok(JSON.parse(row(f,id).snapshot_json).generatedAt);
 await assert.rejects(change(f,id,f.users.finance,'save',{data:content}),/只能/);assert.equal((await readReviews(f.db,f.users.finance,{date:reviewToday()})).reports.length,1);
 await assert.rejects(change(f,id,f.users.indonesia,'review',{note:'本人确认完成'}),/不能/);
 await change(f,id,f.users.admin,'return',{note:'请补充问题的证据'});await change(f,id,f.users.indonesia,'submit',{data:content});await change(f,id,f.users.admin,'review',{note:'确认结果并跟进下期行动'});
 assert.equal(row(f,id).status,'reviewed');await change(f,id,f.users.admin,'return',{note:'月底补充完整周期数据'});
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE entity_id=? AND action='review.submit'").get(id).n,2);
});
test('跨岗行动负责人仅更新本人行动，管理员验收；行动跨周保留',async()=>{
 const f=fixture(),id=await create(f);await action(f,id,f.users.supply);await change(f,id,f.users.indonesia,'submit',{data:content});const a=f.sqlite.prepare('SELECT * FROM review_actions').get();
 await assert.rejects(change(f,id,f.users.supply2,'actionUpdate',{actionId:a.id,actionVersion:1,status:'done',note:'已完成三个产品'}),/无权/);
 await change(f,id,f.users.supply,'actionUpdate',{actionId:a.id,actionVersion:1,status:'done',note:'已完成3款详情，证据见产品页'});
 await assert.rejects(change(f,id,f.users.supply,'actionUpdate',{actionId:a.id,actionVersion:2,status:'closed',note:'本人关闭已完成'}),/不能/);
 await change(f,id,f.users.admin,'actionUpdate',{actionId:a.id,actionVersion:2,status:'closed',note:'已核对三个商品，验收通过'});
 assert.equal((await readReviews(f.db,f.users.supply,{date:addDays(reviewToday(),-14)})).actions[0].status,'closed');
});
test('旧版本写入被拒绝，并发保存只有一次成功',async()=>{
 const f=fixture(),id=await create(f),version=row(f,id).version;
 const save=()=>mutateReview(f.db,f.users.indonesia,{id,version,action:'save',data:content});const result=await race(f,save,save);assert.equal(result.filter(r=>r.ok).length,1);await assert.rejects(save(),/版本/);
});
test('日报缺失不当作完整零销售，管理员及运营待办接通',async()=>{
 const f=fixture(),period=reviewPeriod('weekly',reviewToday());const snap=await reviewSnapshot(f.db,{id:f.users.indonesia.id,site:'印尼',channel:'TikTok'},period);assert.equal(snap.coverage,0);assert.equal(snap.currencies.length,0);
 const tasks=await reviewTasks(f.db,f.users.indonesia);assert.ok(tasks.some(t=>t.tab==='reviews'));assert.deepEqual(await reviewTasks(f.db,f.users.sales),[]);
});
