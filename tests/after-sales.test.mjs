import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {mutateAfterSales,readAfterSales,afterRecord,afterHistory,money,afterSummary,afterTasks} from '../lib/after-sales.mjs';
import {uploadAfterEvidence} from '../lib/after-sales-files.mjs';
import {reviewToday} from '../lib/business-review-model.mjs';
import {navigationForRole} from '../lib/permissions.mjs';
const input=()=>({businessDate:reviewToday(),caseNo:crypto.randomUUID(),orderNo:'ORDER-1',sku:'BAG-A',qty:2,reason:'商品质量问题',description:'拉链断裂，客户申请退款',refundAmount:'120.25',factory:'工厂甲',warehouse:'印尼仓',batch:'LOT-A'});
const state=(f,id)=>f.sqlite.prepare('SELECT * FROM after_sales WHERE id=?').get(id);
const change=(f,id,a,action,p={})=>mutateAfterSales(f.db,a,{action,id,version:state(f,id).version,...p});
const create=async(f,p={},a=f.users.indonesia)=>(await mutateAfterSales(f.db,a,{action:'create',...input(),...p})).id;
const bucket=()=>{const files=new Map();return {files,async put(k,v){files.set(k,v)},async delete(k){files.delete(k)}}};
const image=(i=0)=>new File([new Uint8Array([255,216,255,i])],`proof${i}.jpg`,{type:'image/jpeg'});
async function submitted(f,p={}){const id=await create(f,p);await uploadAfterEvidence(f.db,bucket(),f.users.indonesia,id,image());await change(f,id,f.users.indonesia,'submit');return id;}
const decision={responsibility:'工厂',liableName:'工厂甲',claimAmount:'100',note:'已核对照片及生产批次'};
test('售后草稿隔离、跨运营越权、提交后管理员供应链工厂共享',async()=>{
 const f=fixture(),id=await create(f),month=reviewToday().slice(0,7),factory={id:'factory',name:'工厂甲',role:'工厂'};
 assert.equal((await readAfterSales(f.db,f.users.admin,month)).records.length,0);
 await assert.rejects(afterRecord(f.db,f.users.malaysia,id),/无权/);await assert.rejects(afterRecord(f.db,f.users.admin,id),/无权/);
 for(const a of [factory,f.users.admin,f.users.supply,f.users.sales,f.users.finance])await assert.rejects(create(f,{},a),/仅运营|无权/);
 await assert.rejects(change(f,id,f.users.indonesia,'submit'),/证据|佐证/);
 await uploadAfterEvidence(f.db,bucket(),f.users.indonesia,id,image());await change(f,id,f.users.indonesia,'submit');
 for(const a of [factory,f.users.admin,f.users.supply])assert.equal((await readAfterSales(f.db,a,month)).records.length,1);
 await assert.rejects(change(f,id,f.users.malaysia,'comment',{note:'非本人试图访问'}),/无权/);
 await assert.rejects(change(f,id,f.users.supply,'confirm',decision),/管理员/);
 await change(f,id,factory,'comment',{note:'工厂收到反馈，核查本批拉链'});
 assert.ok((await afterHistory(f.db,f.users.admin,id)).some(h=>h.action==='after_sales.comment'));
});
test('重复售后单SKU被阻止，金额和数量日期严格校验，不同SKU可分别登记',async()=>{
 const f=fixture(),p=input();await create(f,p);await assert.rejects(create(f,p),/已登记/);await create(f,{...p,sku:'BAG-B'});
 for(const p of [{qty:-1},{qty:1.5},{businessDate:'2026-02-30'},{refundAmount:''},{refundAmount:'1.234'},{reason:'伪造类型'}])await assert.rejects(create(f,p));
 assert.equal(money('0.29','退款'),29);assert.throws(()=>money(Infinity,'退款'));assert.throws(()=>money(null,'退款'));
});
test('证据需真实支持格式、最多6张、去重且仅本人草稿可上传，失败不留下孤立文件',async()=>{
 const f=fixture(),id=await create(f),b=bucket();
 await assert.rejects(uploadAfterEvidence(f.db,b,f.users.indonesia,id,new File(['<svg/>'],'x.jpg',{type:'image/jpeg'})),/仅支持/);
 await uploadAfterEvidence(f.db,b,f.users.indonesia,id,image());assert.equal((await uploadAfterEvidence(f.db,b,f.users.indonesia,id,image())).replayed,true);
 for(let i=1;i<6;i++)await uploadAfterEvidence(f.db,b,f.users.indonesia,id,image(i));
 await assert.rejects(uploadAfterEvidence(f.db,b,f.users.indonesia,id,image(7)));assert.equal(b.files.size,6);
 await change(f,id,f.users.indonesia,'submit');await assert.rejects(uploadAfterEvidence(f.db,b,f.users.indonesia,id,image(8)),/草稿/);
 await assert.rejects(uploadAfterEvidence(f.db,b,f.users.supply,id,image(8)),/本人/);
});
test('管理员定责、部分实赔、重复凭证和超额拦截、结清才能关闭，操作全留痕',async()=>{
 const f=fixture(),id=await submitted(f);await change(f,id,f.users.admin,'confirm',decision);
 const pay={amount:'40',reference:'PAY-001',date:reviewToday(),note:'收到工厂赔付款，银行流水核验'};
 await change(f,id,f.users.admin,'payment',pay);await assert.rejects(change(f,id,f.users.admin,'payment',pay),/重复/);
 await assert.rejects(change(f,id,f.users.admin,'confirm',{...decision,claimAmount:'39'}),/小于/);
 await assert.rejects(change(f,id,f.users.admin,'payment',{...pay,reference:'PAY-002',amount:'61'}),/超过/);
 await assert.rejects(change(f,id,f.users.admin,'close',{note:'准备核对结案'}),/尚未结清/);
 await assert.rejects(change(f,id,f.users.admin,'void',{note:'不允许抹掉赔偿'}),/作废/);
 await change(f,id,f.users.admin,'payment',{...pay,reference:'PAY-002',amount:'60'});await change(f,id,f.users.admin,'close',{note:'赔付已全部到账，核对结案'});
 assert.equal(state(f,id).status,'closed');assert.equal((await afterHistory(f.db,f.users.admin,id)).filter(x=>x.action==='after_sales.payment').length,2);
});
test('取消及描述不符需运营改进才能结案，退回和作废保留历史',async()=>{
 const f=fixture(),id=await submitted(f,{reason:'客户不想要 / 取消'});
 await change(f,id,f.users.admin,'return',{note:'请补充客户取消原话'});assert.equal(state(f,id).status,'draft');
 await change(f,id,f.users.indonesia,'submit');await change(f,id,f.users.admin,'confirm',{...decision,responsibility:'客户',liableName:'客户自主取消',claimAmount:0});
 await assert.rejects(change(f,id,f.users.admin,'close',{note:'客户取消，无赔偿'}),/优化措施/);
 await change(f,id,f.users.indonesia,'improve',{note:'发货前二次确认需求，并补充商品尺寸说明'});await change(f,id,f.users.admin,'close',{note:'沟通已完成，无责任赔偿'});
 const draft=await create(f);await change(f,draft,f.users.indonesia,'void',{note:'错误录入，保留作废依据'});assert.equal(state(f,draft).status,'void');
});
test('旧版本不能覆盖新处理，赔付并发不双记',async()=>{
 const f=fixture(),id=await submitted(f);await change(f,id,f.users.admin,'confirm',decision);const version=state(f,id).version;
 const p={action:'payment',id,version,amount:60,reference:'PAY-CONCURRENT',date:reviewToday(),note:'到账后登记并核对流水'};
 const results=await Promise.allSettled([mutateAfterSales(f.db,f.users.admin,p),mutateAfterSales(f.db,f.users.admin,p)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(JSON.parse(state(f,id).data_json).payments.length,1);
});
test('月度归集独立币种、同订单多SKU不多算订单、草稿作废不计入',async()=>{
 const f=fixture(),id=await submitted(f),id2=await submitted(f,{sku:'BAG-B'});await change(f,id,f.users.admin,'confirm',decision);
 const other=await create(f,{},f.users.malaysia);await uploadAfterEvidence(f.db,bucket(),f.users.malaysia,other,image());await change(f,other,f.users.malaysia,'submit');await create(f);
 const v=await readAfterSales(f.db,f.users.admin,reviewToday().slice(0,7));assert.equal(v.summary.cases,3);assert.equal(v.summary.orders,2);assert.equal(v.summary.qty,6);assert.equal(v.summary.currencies.length,2);assert.equal(v.summary.liable[0].claimCents,10000);
 await change(f,id2,f.users.admin,'void',{note:'核对后确认重复业务'});assert.equal((await readAfterSales(f.db,f.users.admin,reviewToday().slice(0,7))).summary.cases,2);
 assert.deepEqual(afterSummary([]).currencies,[]);
 for(const role of ['管理员','运营','供应链','工厂'])assert.ok(navigationForRole(role).includes('after-sales'));
 for(const role of ['销售','海运','财务'])assert.ok(!navigationForRole(role).includes('after-sales'));
});

test('售后待办跨月份保留，运营只提醒自己的草稿及未填改进，管理员跟踪至结案',async()=>{
 const f=fixture();const id=await create(f,{businessDate:'2026-01-01'});
 assert.equal((await afterTasks(f.db,f.users.indonesia)).length,1);assert.equal((await afterTasks(f.db,f.users.admin)).length,0);
 await uploadAfterEvidence(f.db,bucket(),f.users.indonesia,id,image());await change(f,id,f.users.indonesia,'submit');
 assert.equal((await afterTasks(f.db,f.users.indonesia)).length,0);assert.match((await afterTasks(f.db,f.users.admin))[0].detail,/2026-01/);
 assert.deepEqual(await afterTasks(f.db,f.users.supply),[]);
});
