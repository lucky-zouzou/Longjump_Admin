import {storeInsert} from '../lib/distributor-accounts.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {manageDistributorLink,distributorIdentity,submitDistributorOrder} from '../lib/distributor-ordering.mjs';
import {handleDistributor} from '../lib/distributor-http.mjs';
import {indonesiaDate,readWholesale} from '../lib/wholesale.mjs';

async function customer(f,sales=f.users.sales){
  return (await f.call(sales,'customerCreate',{name:'Mitra '+sales.id,contact:'Ibu Sari',phone:'0812345678',city:'Bandung',address:'Jl. Contoh 1',note:'Internal only'})).id;
}
const root='https://example.test';
async function access(f,actor,id,version=0){
  if(!f.sqlite.prepare('SELECT 1 FROM distributor_stores WHERE customer_id=?').get(id))await storeInsert(f.db,id,f.users.admin,{approved:true}).run();
  const result=await manageDistributorLink(f.db,actor,{action:'issue',customerId:id,version});
  const auth='Bearer '+result.path.split('#')[1];
  const send=(body,extra={})=>handleDistributor(new Request(root+'/api/distributor',{method:body?'POST':'GET',headers:{authorization:auth,origin:root,'content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})}),f.db);
  return {send,auth};
}
const basket=(qty=3)=>({requestId:crypto.randomUUID(),items:[{sku:'BAG-A',qty,version:1}]});

test('客户从专属链接复购，销售归属、财务回款、库存锁定和发货走原订单',async()=>{
  const f=fixture(),id=await customer(f),{send}=await access(f,f.users.sales,id);
  const workspace=await (await send()).json();
  assert.equal(workspace.customer.sales,f.users.sales.name);
  assert.ok(!JSON.stringify(workspace).includes('Internal only'));
  assert.deepEqual(Object.keys(workspace.products[0]).sort(),['available','details','images','name','price','sku','version']);
  assert.equal(workspace.products[0].price,100000);
  const req=basket(),first=await (await send(req)).json(),second=await (await send(req)).json();
  assert.ok(first.orderNo);assert.equal(second.orderNo,first.orderNo);assert.equal(second.replayed,true);
  const order=f.sqlite.prepare('SELECT * FROM wholesale_orders').get();
  assert.equal(order.sales_user_id,f.users.sales.id);assert.equal(order.creator_id,'distributor:'+id);
  assert.equal(order.status,'pending');assert.equal(order.sale_type,'cash');assert.equal(order.currency,'IDR');
  assert.equal(order.total_amount,300000);assert.equal(order.payment_terms,'prepaid');
  const stock=()=>f.sqlite.prepare("SELECT SUM(qty) qty,SUM(reserved_qty) reserved FROM inventory_balances WHERE site='印尼' AND sku='BAG-A'").get();
  assert.equal(stock().reserved,0);
  const owned=await readWholesale(f.db,f.users.sales,indonesiaDate().slice(0,7));assert.equal(owned.orders[0].distributor_order,1);
  await f.change(f.users.finance,order.id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,reason:'核对客户订单与库存'});
  assert.equal(stock().reserved,3);await assert.rejects(f.ship(order.id,3));
  await f.change(f.users.finance,order.id,'financeAdd',{kind:'receipt',amount:300000,reference:'TEST-DIST-01',businessDate:indonesiaDate(),note:'已核对公司到账'});
  await f.ship(order.id,3);assert.equal(stock().qty,17);assert.equal(stock().reserved,0);
  const completed=(await (await send()).json()).orders[0];assert.equal(completed.status,'completed');
  assert.equal(completed.shipments[0].tracking,'TEST-TRACK');
  assert.deepEqual(completed.items,[{sku:'BAG-A',qty:3,price:100000}]);
  assert.notEqual((await (await send(basket(1))).json()).orderNo,first.orderNo);
});

test('客户之间隔离，绑定现任销售；链接重置、停用、归属变更均由后台核验',async()=>{
  const f=fixture(),a=await customer(f),b=await customer(f,f.users.sales2);
  for(const actor of [f.users.sales2,f.users.malaysia,f.users.finance])await assert.rejects(manageDistributorLink(f.db,actor,{customerId:a,action:'issue',version:0}),{status:403});
  const old=await access(f,f.users.sales,a),other=await access(f,f.users.sales2,b);
  assert.equal((await old.send(basket())).status,200);assert.deepEqual((await (await other.send()).json()).orders,[]);
  assert.equal((await other.send({...basket(),customerId:a})).status,400);
  const changed=await access(f,f.users.admin,a,1);
  assert.equal((await old.send()).status,401);
  assert.equal((await changed.send()).status,200);
  await assert.rejects(manageDistributorLink(f.db,f.users.admin,{customerId:a,action:'revoke',version:1}));
  assert.ok(!JSON.stringify(f.sqlite.prepare('SELECT * FROM distributor_links').all()).includes(changed.auth.slice(7)));
  f.sqlite.prepare('UPDATE wholesale_customers SET sales_user_id=?,version=version+1 WHERE id=?').run(f.users.sales2.id,a);
  const ack=await (await changed.send(basket())).json();
  assert.equal(f.sqlite.prepare('SELECT sales_user_id FROM wholesale_orders WHERE order_no=?').get(ack.orderNo).sales_user_id,f.users.sales2.id);
  await assert.rejects(access(f,f.users.sales,a,2),{status:403});
  const cached=await distributorIdentity(f.db,changed.auth);
  await manageDistributorLink(f.db,f.users.sales2,{customerId:a,action:'revoke',version:2});
  assert.equal((await changed.send()).status,401);
  await assert.rejects(submitDistributorOrder(f.db,cached,basket()));
  assert.equal((await other.send()).status,200);
  const edit={customerId:b,name:'Toko',contact:'T',phone:'08123456',city:'Jakarta',address:'Jl 1',reason:'测试客户停用'};
  await f.call(f.users.admin,'customerUpdate',{...edit,version:1,active:false});
  await f.call(f.users.admin,'customerUpdate',{...edit,version:2,active:true});
  assert.equal((await other.send()).status,401);
});

test('拒绝陈旧价格、缺货、跨域与篡改报价；并发及延迟重试只建一单',async()=>{
  const f=fixture(),id=await customer(f),{send}=await access(f,f.users.admin,id);
  const req=basket();assert.equal((await send({...req,items:[{...req.items[0],unitPrice:1}]})).status,400);
  assert.equal((await send({...req,items:[{...req.items[0],version:2}]})).status,409);
  assert.equal((await send(basket(21))).status,409);assert.equal((await send(req,{origin:'https://invalid.test'})).status,403);
  assert.equal((await send(req,{authorization:''})).status,401);
  const both=await Promise.all([send(req),send(req)]);assert.deepEqual(both.map(r=>r.status),[200,200]);
  const orders=await Promise.all(both.map(r=>r.json()));assert.equal(orders[0].orderNo,orders[1].orderNo);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,1);
  assert.equal((await send({...req,items:[{...req.items[0],qty:8}]})).status,409);
  await f.call(f.users.finance,"priceWithdraw",{sku:"BAG-A",priceVersion:1,reason:"重新核对进口费用"});
  assert.equal((await send(req)).status,200);assert.equal((await send(basket())).status,409);
  f.sqlite.prepare("DELETE FROM inventory_balances WHERE site='印尼' AND channel='TikTok' AND sku='BAG-B'").run();
  assert.deepEqual((await (await send()).json()).products,[]);
});

test('分销详情按SKU展示最新对客资料；缺项留空，成本、供应商和图片存储地址均隔离',async()=>{
  const f=fixture(),id=await customer(f),{send,auth}=await access(f,f.users.sales,id);
  const sku='BAG-A',details={dimensions:'22*6*21',material:'人造PU',color:'黑色',specification:'中号',netWeightKg:0.45,
    cartonQty:20,cartonLengthCm:45,sellingPoints:'Tali dapat disesuaikan'};
  f.sqlite.prepare('INSERT INTO product_profiles VALUES (?,?,?,?,?,?,?,?)').run(sku,1,JSON.stringify({...details,notes:'INTERNAL',sourceStatus:'INTERNAL',supplier:'INTERNAL'}),'{"sheet":"INTERNAL"}','[{"purchase":1234}]','staff','INTERNAL','2026-11-01');
  const file=f.sqlite.prepare('INSERT INTO product_profile_files VALUES (?,?,?,?,?,?,?,?,?,?)');
  file.run('a-main',sku,'internal/key1','hash1','INTERNAL.jpg','image/jpeg',5,'staff','INTERNAL','2026-11-01');
  file.run('a-detail',sku,'internal/key2','hash2','INTERNAL.png','image/png',5,'staff','INTERNAL','2026-11-02');
  file.run('b','BAG-B','private/missing','hash3','other.png','image/png',5,'staff','INTERNAL','2026-11-02');
  file.run('not-image',sku,'invalid','hash4','invalid.svg','image/svg+xml',5,'staff','INTERNAL','2026-11-03');
  const workspace=await (await send()).json();
  assert.deepEqual(workspace.products[0].details,details);
  assert.deepEqual(workspace.products[0].images,['a-main','a-detail']);
  assert.deepEqual(workspace.products[1].details,{});
  assert.doesNotMatch(JSON.stringify(workspace),/INTERNAL|internal\/|object_key|purchase|cost_references|hash1/);
  f.sqlite.prepare("UPDATE product_profiles SET data_json=json_set(data_json,'$.material','PVC') WHERE sku=?").run(sku);
  assert.equal((await (await send()).json()).products[0].details.material,'PVC');
  const bucket={get:async key=>key==='internal/key1'?{body:new Uint8Array([255,216,255,4,5])}:null};
  const image=(imageId,authorization=auth)=>handleDistributor(new Request(root+'/api/distributor?photo='+imageId,{headers:{authorization}}),f.db,bucket);
  const ok=await image('a-main');assert.equal(ok.status,200);assert.equal(ok.headers.get('Content-Type'),'image/jpeg');
  assert.match(ok.headers.get('cache-control'),/no-store/);assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())],[255,216,255,4,5]);
  assert.equal((await image('a-main','')).status,401);
  for(const fileId of ['b','not-image','invalid','private/missing'])assert.equal((await image(fileId)).status,404);
  f.stock(sku,0,0);assert.equal((await image('a-main')).status,200);
  assert.deepEqual((await (await send()).json()).products.map(p=>p.sku),['BAG-A','BAG-B']);assert.equal((await (await send()).json()).products[0].available,0);
  f.stock(sku,10,10);
  await f.call(f.users.finance,'priceWithdraw',{sku,priceVersion:1,reason:'重新核实当前印尼报价'});
  assert.equal((await image('a-main')).status,404);
  await manageDistributorLink(f.db,f.users.admin,{action:'revoke',customerId:id,version:1});
  assert.equal((await image('a-main')).status,401);
});
