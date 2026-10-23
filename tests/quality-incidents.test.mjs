import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {mutateAfterSales,readAfterSales,afterRecord,afterHistory,afterTasks,discoveryStages} from '../lib/after-sales.mjs';
import {uploadAfterEvidence} from '../lib/after-sales-files.mjs';
import {navigationForRole} from '../lib/permissions.mjs';
import {MODULE_FIELDS,NAV_GROUPS,readWorkspaceRoute} from '../lib/workspace-model.mjs';
const local=new Date(Date.now()+7*3600000).toISOString().slice(0,16),date=local.slice(0,10),month=date.slice(0,7);
const input=(more={})=>({kind:'quality',site:'国内',channel:'跨渠道',businessDate:date,caseNo:crypto.randomUUID(),sku:'BAG-A',qty:4,reason:'标签错误',description:'集运仓验收发现外箱标签与实际SKU不一致',discoveredAt:local,discoveryZone:'+08:00',discoveryStage:'domestic',location:'国内集运仓收货区',batch:'FACTORY-LOT-1',factory:'工厂甲',currency:'CNY',lossAmount:'',...more});
const state=(f,id)=>f.sqlite.prepare('SELECT * FROM after_sales WHERE id=?').get(id);
const change=(f,id,actor,action,more={})=>mutateAfterSales(f.db,actor,{id,action,version:state(f,id).version,...more});
const create=async(f,more={},actor=f.users.supply)=>(await mutateAfterSales(f.db,actor,{action:'create',...input(more)})).id;
const photo=new File([new Uint8Array([255,216,255,1])],'label.jpg',{type:'image/jpeg'});
const bucket={put:async()=>{},delete:async()=>{}};
async function submit(f,id){await uploadAfterEvidence(f.db,bucket,f.users.supply,id,photo);await change(f,id,f.users.supply,'submit');}

test('供应链可选择站点渠道录入售后，运营仍限本人范围；草稿及证据权限保持隔离',async()=>{
 const f=fixture();try{
 const p={action:'create',kind:'after_sale',site:'菲律宾',channel:'Shopee',businessDate:date,caseNo:'AF-1',orderNo:'ORDER-1',sku:'BAG-A',qty:1,refundAmount:'20',reason:'商品质量问题',description:'供应链核对买家照片发现车线开裂'};
 const {id}=await mutateAfterSales(f.db,f.users.supply,p);assert.equal(JSON.parse(state(f,id).data_json).currency,'PHP');
 assert.equal((await readAfterSales(f.db,f.users.supply,month)).canCreate,true);
 await assert.rejects(afterRecord(f.db,f.users.supply2,id),e=>e.status===404);await assert.rejects(uploadAfterEvidence(f.db,bucket,f.users.supply2,id,photo),e=>e.status===404);
 await assert.rejects(mutateAfterSales(f.db,f.users.indonesia,p),e=>e.status===403);
 await submit(f,id);assert.equal((await readAfterSales(f.db,f.users.admin,month)).records.length,1);
 assert.equal((await readAfterSales(f.db,f.users.indonesia,month)).records.length,0);
 await assert.rejects(change(f,id,f.users.supply,'confirm',{responsibility:'工厂',liableName:'工厂甲',claimAmount:'20',note:'供应链不得自行确认赔偿'}),e=>e.status===403);
 }finally{f.sqlite.close();}
});
test('品质异常独立台账按发现环节分类，未知损失不冒充0，不混入售后退款',async()=>{
 const f=fixture();try{
 for(const s of discoveryStages){const id=await create(f,{discoveryStage:s.id});await submit(f,id);}
 const report=await readAfterSales(f.db,f.users.admin,month,'quality');assert.equal(report.summary.cases,5);assert.equal(report.summary.qty,20);assert(report.summary.stages.every(s=>s.cases===1));assert.equal(report.summary.currencies[0].lossMissing,5);
 assert.equal((await readAfterSales(f.db,f.users.admin,month)).summary.cases,0);
 const factory=await readAfterSales(f.db,{role:'工厂',id:'factory'},month,'quality');assert.equal(factory.records.length,5);assert.equal(factory.canCreate,false);
 for(const actor of [f.users.indonesia,f.users.finance,f.users.sales])await assert.rejects(readAfterSales(f.db,actor,month,'quality'),e=>e.status===403);
 assert.equal(report.records[0].data.discoveredUtc,new Date(Date.parse(local+'+08:00')).toISOString());
 }finally{f.sqlite.close();}
});
test('发现时间、时区、环节、地点和追溯线索均校验；提交前需要照片',async()=>{
 const f=fixture();try{
 for(const extra of [{discoveredAt:'2099-01-01T00:00'},{discoveredAt:'2026-02-30T10:00'},{discoveredAt:date+'T25:00'},{discoveryZone:'UTC'},{discoveryStage:'unknown'},{location:''},{batch:''},{lossAmount:'1.005'},{site:'火星'},{channel:'unknown'},{businessDate:'2020-01-01'}])await assert.rejects(create(f,extra),e=>e.status===400);
 for(const actor of [f.users.admin,f.users.indonesia,{role:'工厂',id:'factory'}])await assert.rejects(create(f,{},actor),e=>e.status===403);
 const id=await create(f);await assert.rejects(change(f,id,f.users.supply,'submit'),/佐证/);const p=input({caseNo:state(f,id).case_no});await assert.rejects(create(f,p),e=>e.status===409);
 await change(f,id,f.users.supply,'save',{...p,description:'标签已拍照留证，等待工厂整改'});assert.equal(JSON.parse(state(f,id).data_json).description,'标签已拍照留证，等待工厂整改');
 }finally{f.sqlite.close();}
});
test('异常全流程留痕、整改和赔偿结清后关闭，不修改库存；待办指向异常模块',async()=>{
 const f=fixture();try{
 const before=JSON.stringify(f.sqlite.prepare('SELECT * FROM inventory_balances').all()),id=await create(f,{lossAmount:'15'});
 assert.equal((await afterTasks(f.db,f.users.supply))[0].tab,'quality-incidents');await submit(f,id);
 assert.equal((await afterTasks(f.db,f.users.admin))[0].tab,'quality-incidents');
 await change(f,id,{role:'工厂',id:'factory',name:'工厂甲'},'comment',{note:'已安排重新打印标签并补送'});
 await change(f,id,f.users.admin,'confirm',{responsibility:'工厂',liableName:'工厂甲',claimAmount:0,note:'工厂已补送正确标签，无现金赔偿'});
 await assert.rejects(change(f,id,f.users.admin,'close',{note:'管理员核实完成'}),/整改措施/);
 await change(f,id,f.users.supply,'improve',{note:'供应链张三已安排仓库换标并复核全部外箱，验收完成'});
 await change(f,id,f.users.admin,'close',{note:'核对证据及整改完成，确认结案'});
 assert.equal(state(f,id).status,'closed');assert.equal((await afterHistory(f.db,f.users.admin,id)).filter(h=>h.action==='after_sales.close').length,1);
 assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM inventory_balances').all()),before);assert.equal((await afterTasks(f.db,f.users.supply)).length,0);
 }finally{f.sqlite.close();}
});
test('异常导航仅开放协作岗位且路由可恢复',()=>{
 for(const role of ['管理员','供应链','工厂'])assert(navigationForRole(role).includes('quality-incidents'));
 for(const role of ['运营','财务','销售','海运'])assert(!navigationForRole(role).includes('quality-incidents'));
 assert(Object.hasOwn(MODULE_FIELDS,'quality-incidents'));assert(NAV_GROUPS.some(g=>g.keys.includes('quality-incidents')));assert.equal(readWorkspaceRoute('?page=quality-incidents&month=2026-10').page,'quality-incidents');
});
