import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {mutateField,readField,attendance,fieldToday} from '../lib/field-sales.mjs';
const location=()=>({latitude:-6.2,longitude:106.8,accuracy:15,capturedAt:Date.now()});
const call=(f,a,p)=>mutateField(f.db,a,{operationId:crypto.randomUUID(),location:location(),...p});
const row=(f,id)=>f.sqlite.prepare('SELECT * FROM field_records WHERE id=?').get(id);
const change=(f,a,id,action,extra={})=>call(f,a,{id,version:row(f,id).version,action,...extra});
async function customer(f,who=f.users.sales){const id=await f.create({who});return f.orderRow(id).customer_id;}
async function visit(f,c,day=fieldToday(),who=f.users.sales){return (await call(f,who,{action:'create',kind:'visit',customerId:c,businessDate:day,visitType:'cold',note:'Visited shop and discussed the new collection.'})).id;}
function photo(f,id,hash=crypto.randomUUID()){f.sqlite.prepare('INSERT INTO field_files(id,record_id,object_key,name,content_type,size,sha256,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),id,'test/'+crypto.randomUUID(),'shop.png','image/png',5,hash,f.users.sales.id,new Date().toISOString());}
test('拜访按客户日去重，补录和重复照片待复核，操作幂等且保留审计',async()=>{
 const f=fixture(),c=await customer(f),id=await visit(f,c);await assert.rejects(change(f,f.users.sales,id,'submit'),/照片/);photo(f,id,'one');
 const payload={location:location(),action:'submit',id,version:row(f,id).version,operationId:crypto.randomUUID()};await mutateField(f.db,f.users.sales,payload);assert.equal((await mutateField(f.db,f.users.sales,payload)).replayed,true);assert.equal(row(f,id).status,'valid');
 const id2=await visit(f,c);photo(f,id2);await change(f,f.users.sales,id2,'submit');const d=await readField(f.db,f.users.sales,fieldToday().slice(0,7));assert.equal(d.contributions[0].visits,1);assert.equal(d.contributions[0].clients,1);
 const repeat=await visit(f,c);photo(f,repeat,'one');await change(f,f.users.sales,repeat,'submit');assert.equal(row(f,repeat).status,'review');
 const old=await visit(f,c,'2026-01-02');photo(f,old);await change(f,f.users.sales,old,'submit');assert.equal(row(f,old).status,'review');await change(f,f.users.admin,old,'review',{decision:'approve',reason:'核对原始记录确认'});assert.equal(row(f,old).status,'valid');assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action LIKE 'field.%'").get().n,9);
});
test('销售不能读取他人外勤、伪造归属或审批，财务只读，非印尼销售不可访问',async()=>{
 const f=fixture(),c=await customer(f),id=await visit(f,c);assert.equal((await readField(f.db,f.users.sales2,fieldToday().slice(0,7))).records.length,0);
 await assert.rejects(change(f,f.users.sales2,id,'withdraw',{reason:'恶意撤回'}),/无权/);await assert.rejects(call(f,f.users.sales2,{action:'create',kind:'visit',salesUserId:f.users.sales.id,customerId:c,businessDate:fieldToday(),visitType:'cold',note:'sufficient notes'}),/请选择/);
 await assert.rejects(change(f,f.users.finance,id,'submit'),/仅可查看/);await assert.rejects(readField(f.db,{...f.users.sales,site:'马来西亚'},'2026-09'),/无权/);
 photo(f,id);await change(f,f.users.sales,id,'submit');await assert.rejects(change(f,f.users.sales,id,'review',{decision:'reject',reason:'test'}),/仅管理员/);await assert.rejects(change(f,f.users.admin,id,'review',{decision:'reject',reason:''}),/原因/);
 await change(f,f.users.admin,id,'review',{decision:'reject',reason:'资料无法确认'});assert.equal(row(f,id).status,'rejected');
});
test('请假审批、重叠保护、撤回作废和周末出勤不自动判旷工',async()=>{
 const f=fixture(),create=()=>call(f,f.users.sales,{action:'create',kind:'leave',businessDate:'2026-09-07',endDate:'2026-09-08',leaveType:'annual',note:'家庭安排'}),a=(await create()).id,b=(await create()).id;
 await change(f,f.users.sales,a,'submit');await assert.rejects(change(f,f.users.sales,b,'submit'),/变化/);await change(f,f.users.admin,a,'review',{decision:'approve',reason:'批准休假'});
 const report=await readField(f.db,f.users.finance,'2026-09'),att=report.attendance.find(r=>r.id===f.users.sales.id);assert.equal(att.days.find(d=>d.date==='2026-09-07').status,'leave');assert.equal(att.days.find(d=>d.date==='2026-09-06').status,'weekend');assert.equal(att.days.find(d=>d.date==='2026-09-09').status,'verify');
 await change(f,f.users.admin,a,'void',{reason:'取消休假'});await change(f,f.users.sales,b,'submit');await change(f,f.users.sales,b,'withdraw',{reason:'改期休假'});assert.equal(row(f,b).status,'withdrawn');
});
test('出勤要求3家不同客户，未来和当天无记录不标记未出勤',()=>{
 const users=[{id:'u',name:'U',created_at:'2026-01-01'}],records=[1,2,3,3].map(n=>({sales_user_id:'u',kind:'visit',status:'valid',business_date:'2026-09-07',customer_id:'c'+n,data:{identity:'c'+n}})),r=attendance('2026-09',users,records,'2026-09-08')[0];assert.equal(r.days[6].count,3);assert.equal(r.days[6].status,'met');assert.equal(r.days[7].status,'in_progress');assert.equal(r.days[8].status,'future');
});
test('合同必须有文件，独立客户首次有效合同才计新增，重复编号防护及作废审计',async()=>{
 const f=fixture(),c=await customer(f),create=()=>call(f,f.users.sales,{action:'create',kind:'contract',customerId:c,businessDate:fieldToday(),contractNo:'CONTRACT-ONE'}),a=(await create()).id;
 await assert.rejects(change(f,f.users.sales,a,'submit'),/上传/);photo(f,a);await change(f,f.users.sales,a,'submit');await change(f,f.users.admin,a,'review',{decision:'approve',reason:'核验双方签署'});
 const b=(await create()).id;photo(f,b);await assert.rejects(change(f,f.users.sales,b,'submit'),/变化/);
 let d=await readField(f.db,f.users.sales,fieldToday().slice(0,7));assert.equal(d.contributions[0].signed,1);await change(f,f.users.admin,a,'void',{reason:'合同取消'});d=await readField(f.db,f.users.sales,fieldToday().slice(0,7));assert.equal(d.contributions[0].signed,0);
});
test('贡献按实际发货及核销日期，不按订单创建月份；库存与新品只有允许字段',async()=>{
 const f=fixture(),id=await f.create({businessDate:'2026-01-01'});await f.approve(id);await f.ship(id,3,fieldToday());
 const d=await readField(f.db,f.users.sales,fieldToday().slice(0,7));assert.equal(d.contributions[0].quantity,3);assert.equal(d.contributions[0].amount,300000);assert.equal(d.contributions[0].skus[0].qty,3);assert.equal(d.inventory.find(s=>s.sku==='BAG-A').indonesia,15);assert.deepEqual(Object.keys(d.inventory[0]).sort(),['sku','name','qty','reserved','pending','quarantine','available','indonesia','updated_at'].sort());
 const other=await readField(f.db,f.users.sales2,fieldToday().slice(0,7));assert.equal(other.contributions[0].quantity,0);assert.equal(other.customers.length,0);
});
test('维护锁阻止新增记录，版本冲突不会覆盖记录',async()=>{
 const f=fixture(),c=await customer(f),id=await visit(f,c),v=row(f,id).version;await change(f,f.users.sales,id,'withdraw',{reason:'重新填写'});await assert.rejects(call(f,f.users.admin,{id,version:v,action:'withdraw',reason:'旧页面'}),/变化/);
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,actor_id,updated_at,expires_at) VALUES('global','backup','test','2026-01-01','2099-01-01')").run();await assert.rejects(visit(f,c),/备份/);
});

test('现场定位不可缺少或重放，低精度和同址多客户转复核，供应链只读且隐藏请假原因',async()=>{
 const f=fixture(),c=await customer(f),id=await visit(f,c);photo(f,id);
 for(const loc of [null,{...location(),latitude:91},{...location(),capturedAt:Date.now()-130000}])await assert.rejects(change(f,f.users.sales,id,'submit',{location:loc}),/定位/);
 await change(f,f.users.sales,id,'submit');assert.equal(row(f,id).status,'valid');
 const nearCustomer=await customer(f),near=await visit(f,nearCustomer);photo(f,near);await change(f,f.users.sales,near,'submit');assert.equal(row(f,near).status,'review');assert(JSON.parse(row(f,near).data_json).checks.includes('shared_location'));
 const low=await visit(f,c);photo(f,low);await change(f,f.users.sales,low,'submit',{location:{...location(),accuracy:500}});assert.equal(row(f,low).status,'review');
 const moved=await visit(f,c);photo(f,moved);await change(f,f.users.sales,moved,'submit',{location:{...location(),latitude:-7}});assert(JSON.parse(row(f,moved).data_json).checks.includes('location_changed'));
 const leave=await call(f,f.users.sales,{action:'create',kind:'leave',businessDate:fieldToday(),endDate:fieldToday(),leaveType:'sick',note:'private medical description'});
 await change(f,f.users.sales,leave.id,'submit');const view=await readField(f.db,f.users.supply,fieldToday().slice(0,7));assert(!JSON.stringify(view).includes('private medical description'));assert(view.syncedAt);assert(view.records.some(r=>r.id===id));
 await assert.rejects(change(f,f.users.supply,id,'review',{decision:'approve',reason:'test'}),/仅可查看/);
 const contract=await call(f,f.users.sales,{action:'create',kind:'contract',customerId:c,businessDate:fieldToday(),contractNo:'PRIVATE-CONTRACT'});assert(!(await readField(f.db,f.users.supply,fieldToday().slice(0,7))).records.some(r=>r.id===contract.id));
});
