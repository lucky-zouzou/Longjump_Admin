import {storeInsert} from '../lib/distributor-accounts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {manageDistributorLink,distributorIdentity,submitDistributorOrder} from '../lib/distributor-ordering.mjs';
import {handleDistributor} from '../lib/distributor-http.mjs';
import {afterRecord,afterTasks,mutateAfterSales,readAfterSales} from '../lib/after-sales.mjs';
import {distributorFinanceChoices} from '../lib/distributor-service-staff.mjs';
import {qualityMonthlyReport} from '../lib/quality-report.mjs';
import {indonesiaDate} from '../lib/wholesale.mjs';

const day=indonesiaDate(),month=day.slice(0,7),origin='https://mitra.example.test';
async function partner(f,seller=f.users.sales){
 const customerId=(await f.call(seller,'customerCreate',{name:'Toko '+seller.id,contact:'Rani',phone:'0812345678',city:'Bandung',address:'Jl. Contoh 1'})).id;
 await storeInsert(f.db,customerId,f.users.admin,{approved:true}).run();
 const {path}=await manageDistributorLink(f.db,seller,{action:'issue',version:0,customerId});
 return {customerId,auth:'Bearer '+path.split('#')[1]};
}
async function setup(qty=3){
 const f=fixture(),client=await partner(f),identity=await distributorIdentity(f.db,client.auth);
 const placed=await submitDistributorOrder(f.db,identity,{requestId:crypto.randomUUID(),items:[{sku:'BAG-A',qty,version:1}]});
 const order=f.sqlite.prepare('SELECT id FROM wholesale_orders WHERE order_no=?').get(placed.orderNo).id;
 const item=f.sqlite.prepare('SELECT id FROM wholesale_order_items WHERE order_id=?').get(order).id;
 const objects=new Map(),bucket={put:async(k,v)=>objects.set(k,v),delete:async k=>objects.delete(k)};
 const api=async(form,auth=client.auth)=>handleDistributor(new Request(origin+'/api/distributor?service=1',{headers:{authorization:auth,origin},...(form?{method:'POST',body:form}:{})}),f.db,bucket);
 assert.equal((await (await api()).json()).lines.length,0);
 await f.change(f.users.finance,order,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,reason:'测试订单库存已核实'});
 await f.change(f.users.finance,order,'financeAdd',{kind:'receipt',amount:qty*100000,reference:'IN-2',businessDate:day,note:'测试收到全部款项'});
 await f.ship(order,qty);
 const form=(kind='return',n=1,key=crypto.randomUUID())=>{
   const fd=new FormData();
   for(const [k,v] of Object.entries({item,kind,qty:n,description:'Jahitan pada tas lepas.',reason:'quality',requestId:key}))fd.set(k,v);
   fd.append('evidence',new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'}),'tas.jpg');
   return fd;
 };
 const submit=async(fd)=>{const res=await api(fd);const body=await res.json();assert.equal(res.status,200,body.error);return f.sqlite.prepare('SELECT id FROM after_sales WHERE case_no=?').get(body.caseNo).id;};
 const act=async(actor,id,action,extra={})=>mutateAfterSales(f.db,actor,{action,id,version:(await afterRecord(f.db,actor,id)).version,note:'Barang telah diperiksa.',...extra});
 const receive=n=>f.change(f.users.supply,order,'orderReturn',{itemId:item,qty:n,businessDate:day,reason:'测试问题商品实际退回',proofRef:'RTN-2',receivedConfirmed:true,resellable:false});
 const inventory=()=>f.sqlite.prepare("SELECT SUM(qty) available,SUM(quarantine_qty) quarantine FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get();
 return {f,order,item,client,api,objects,form,submit,act,receive,inventory};
}

test('客户线下分销证据写入原售后总表；限制已发件数、身份、文件格式，并发重试保留一条',async()=>{
 const {f,client,api,objects,form}=await setup();
 const other=await partner(f,f.users.sales2);
 assert.equal((await api(form(),other.auth)).status,404);
 assert.equal((await api(form(),'')).status,401);
 assert.equal((await api(form('exchange',4))).status,409);
 const bad=form();bad.set('evidence',new Blob(['<svg/>'],{type:'image/jpeg'}),'bad.jpg');assert.equal((await api(bad)).status,400);
 const key=crypto.randomUUID(),video=()=>{const fd=form('exchange',2,key);fd.append('evidence',new Blob([new Uint8Array([0,0,0,20]),'ftypisom00000000'],{type:'video/mp4'}),'tas.mp4');return fd;};
 const attempts=await Promise.all([api(video()),api(video())]);
 for(const res of attempts)assert.equal(res.status,200);
 assert.equal((await attempts[0].json()).caseNo,(await attempts[1].json()).caseNo);
 assert.equal(objects.size,2);
 assert.equal((await api(form('return',1,key))).status,409);
 const view=await readAfterSales(f.db,f.users.admin,month,'all');
 assert.equal(view.records.length,1);assert.equal(view.records[0].channel,'线下分销');
 assert.equal(view.records[0].owner_id,f.users.sales.id);assert.equal(view.summary.qty,2);
 assert.deepEqual(view.files.map(x=>x.content_type).sort(),['image/jpeg','video/mp4']);
 const customerView=await (await api()).json();assert.equal(customerView.lines[0].available,1);assert.doesNotMatch(JSON.stringify(customerView),/token_hash|object_key|approvedAmount|fingerprint/);
 assert.deepEqual((await (await api(null,other.auth)).json()),{lines:[],cases:[]});
 await manageDistributorLink(f.db,f.users.admin,{customerId:client.customerId,action:'revoke',version:1});
 assert.equal((await api(video())).status,401);
});

test('同 SKU 换新，管理员与财务分工，仓库隔离和补发只记一次，客户能查运单',async()=>{
 const {f,api,form,submit,act,receive,inventory}=await setup(2);
 const before=inventory(),id=await submit(form('exchange',2));
 await assert.rejects(act(f.users.finance,id,'distApprove'),{status:403});
 await assert.rejects(act(f.users.finance,id,'distFinish'),/先由管理员/);
 await act(f.users.admin,id,'distApprove');
 assert.ok((await afterTasks(f.db,f.users.finance)).some(t=>t.title.includes('退换货')));
 const ship={receipt:'RET-21',carrier:'JNE',tracking:'TRACK-EX-01',shipChannel:'TikTok',returnChannel:'Shopee',physicalConfirmed:true};
 await assert.rejects(act(f.users.admin,id,'distFinish',ship),{status:403});
 await assert.rejects(act(f.users.finance,id,'distFinish',{...ship,tracking:''}));
 await assert.rejects(receive(1));assert.deepEqual(inventory(),before);
 f.stock('BAG-A',0,9);await assert.rejects(act(f.users.finance,id,'distFinish',ship));f.stock('BAG-A',9,9);
 await act(f.users.finance,id,'distFinish',ship);
 await assert.rejects(act(f.users.finance,id,'distFinish',ship));
 await assert.rejects(receive(1));
 assert.equal(inventory().available,before.available-2);assert.equal(inventory().quarantine,before.quarantine+2);
 const view=await (await api()).json();assert.equal(view.lines.length,0);assert.equal(view.cases[0].tracking,'TRACK-EX-01');assert.equal(view.cases[0].refund,null);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM wholesale_finance_entries WHERE kind='refund'").get().n,0);
});

test('真实退货、实退流水与售后核销分开；分次核销、金额上限、撤销和月报可追溯',async()=>{
 const {f,order,api,form,submit,act,receive,inventory}=await setup(3);
 const a=await submit(form()),b=await submit(form()),c=await submit(form());
 await act(f.users.admin,c,'distReject');assert.equal((await (await api()).json()).lines[0].available,1);
 for(const id of [a,b]){
   await assert.rejects(act(f.users.admin,id,'distApprove',{amount:100001}));
   await act(f.users.admin,id,'distApprove',{amount:100000});
 }
 const options=async id=>distributorFinanceChoices(f.db,f.users.finance,await afterRecord(f.db,f.users.finance,id));
 assert.deepEqual(await options(a),{returns:[],refunds:[]});
 await receive(2);
 await f.change(f.users.finance,order,'financeAdd',{kind:'refund',amount:200000,reference:'BANK-REF-02',businessDate:day,note:'已实际退还两件货款'});
 const before=inventory(),opts=await options(a),refs={returnIds:[opts.returns[0].id],refundIds:[opts.refunds[0].id]};
 await assert.rejects(act(f.users.finance,a,'distFinish',{...refs,refundIds:['not-this-order']}));
 await act(f.users.finance,a,'distFinish',refs);
 assert.equal((await options(b)).refunds[0].available,100000);await act(f.users.finance,b,'distFinish',refs);
 assert.deepEqual(inventory(),before);
 const report=await readAfterSales(f.db,f.users.finance,month,'all'),details=qualityMonthlyReport(report.records,report.files).sheets.find(x=>x.name==='全部追溯明细').rows;
 assert.equal(report.summary.currencies[0].refundCents,20000000);assert.equal(report.summary.currencies[0].claimCents,0);
 assert.ok(details.some(row=>row.includes('线下分销')&&row.includes('客户售后已办结')));
 const undo=()=>f.change(f.users.finance,order,'financeReverse',{entryId:refs.refundIds[0],reference:'REVERSE-02',businessDate:day,note:'复核需要撤销退款记账'});
 await assert.rejects(undo(),/撤销核销/);await act(f.users.finance,a,'distUndoRefund');
 await assert.rejects(undo(),/撤销核销/);await act(f.users.finance,b,'distUndoRefund');await undo();
 assert.equal((await options(a)).refunds.length,0);
 const client=await (await api()).json();assert.ok(client.cases.every(r=>r.refund===null));
});
