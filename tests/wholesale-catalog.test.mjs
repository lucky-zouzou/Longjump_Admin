import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {markedPrice,readCatalog,stockForSku} from '../lib/wholesale-catalog.mjs';
import {mutateWholesale,readWholesale,indonesiaDate} from '../lib/wholesale.mjs';
const price=(extra={})=>({sku:'BAG-A',priceVersion:0,purchaseCost:'70000',freightCost:'6000',taxCost:'2000',inboundCost:'2000',standardMarkup:'25',minimumMarkup:'20',rounding:'100',validUntil:'2099-01-01',costReference:'TEST-COST-PRIVATE-80000',reason:'已核对到仓成本',costConfirmed:true,...extra});
const setup=()=>fixture({catalogPrices:false});
const customer=async(f,who=f.users.sales)=>(await f.call(who,'customerCreate',{name:'Quote '+crypto.randomUUID(),contact:'Test',phone:'0812',city:'Jakarta',address:'Test warehouse',salesUserId:who.id})).id;
const request=async(f,extra={})=>(await f.call(f.users.sales,'priceRequestCreate',{customerId:await customer(f),sku:'BAG-A',qty:5,unitPrice:90000,reason:'客户长期批量采购',...extra})).id;
const decision=(f,id,extra={})=>f.call(f.users.admin,'priceRequestDecide',{requestId:id,version:1,decision:'approve',priceVersion:1,unitPrice:90000,validUntil:'2099-01-01',reason:'核对客户特价申请',priceExceptionConfirmed:true,...extra});
const requestRow=(f,id)=>f.sqlite.prepare('SELECT * FROM wholesale_price_requests WHERE id=?').get(id);
const createFromRequest=(f,r,extra={})=>f.call(f.users.sales,'orderCreate',{customerId:r.customer_id,businessDate:indonesiaDate(),saleType:'cash',items:[{sku:r.sku,qty:r.qty,unitPrice:r.approved_price,priceRequestId:r.id}],...extra});

test('exact cost markup and upward rounding; not gross margin',()=>{
 assert.equal(markedPrice(10000,2500,1),125);assert.equal(markedPrice(10000,2000,1),120);
 assert.equal(markedPrice(8000000,2500,100),100000);assert.equal(markedPrice(8000001,2500,100),100100);
 assert.throws(()=>markedPrice(-1,2500));assert.throws(()=>markedPrice(1,NaN));
});
test('Indonesia availability sums independent channels and subtracts reservations once; unknown and anomalous are not zero',async()=>{
 const f=setup();f.sqlite.exec("UPDATE inventory_balances SET reserved_qty=3,pending_shelf_qty=4,quarantine_qty=2 WHERE site='印尼' AND channel='TikTok' AND sku='BAG-A'");
 const c=await readCatalog(f.db,f.users.sales),a=c.products.find(p=>p.sku==='BAG-A');assert.equal(a.onHand,20);assert.equal(a.reserved,3);assert.equal(a.available,17);assert.equal(a.pending,4);assert.equal(a.quarantine,2);assert.equal(c.totals.available,37);
 f.sqlite.exec("DELETE FROM inventory_balances WHERE site='印尼' AND channel='Shopee' AND sku='BAG-A'");assert.equal((await readCatalog(f.db,f.users.sales)).products[0].available,null);
 assert.equal(stockForSku([{site:'印尼',channel:'TikTok',sku:'A',qty:-1,reserved_qty:0},{site:'印尼',channel:'Shopee',sku:'A',qty:5,reserved_qty:0}],'A').stockStatus,'anomaly');
 await assert.rejects(readCatalog(f.db,f.users.malaysia),e=>e.status===403);f.sqlite.close();
});
test('admin/finance per SKU quotes are versioned, private, immutable and idempotent',async()=>{
 const f=setup(),p={...price(),action:'pricePublish',operationId:crypto.randomUUID()};
 for(const u of [f.users.sales,f.users.supply,f.users.indonesia])await assert.rejects(mutateWholesale(f.db,u,p),e=>e.status===403);
 const result=await mutateWholesale(f.db,f.users.finance,p);assert.ok(result.ok);assert.equal((await mutateWholesale(f.db,f.users.finance,p)).replayed,true);
 const c=await readCatalog(f.db,f.users.finance);assert.equal(c.products[0].price.standardPrice,100000);assert.equal(c.products[0].price.minimumPrice,96000);assert.equal(c.priceHistory[0].purchase_minor,7000000);
 for(const u of [f.users.sales,f.users.supply,f.users.indonesia]){const out=JSON.stringify(await readWholesale(f.db,u,indonesiaDate().slice(0,7)));for(const secret of ['purchase_minor','cost_reference','TEST-COST-PRIVATE-80000','standard_markup_bp','priceHistory'])assert.ok(!out.includes(secret),secret);}
 await assert.rejects(f.call(f.users.admin,'pricePublish',price()),e=>e.status===409);
 await f.call(f.users.admin,'pricePublish',price({priceVersion:1,standardMarkup:'30',standardPrice:109000,minimumPrice:99000}));assert.equal((await readCatalog(f.db,f.users.sales)).products[0].price.standardPrice,109000);
 assert.throws(()=>f.sqlite.exec("UPDATE wholesale_prices SET standard_price=1"),/immutable/);assert.throws(()=>f.sqlite.exec('DELETE FROM wholesale_prices'),/immutable/);
 await f.call(f.users.finance,'priceWithdraw',{sku:'BAG-A',priceVersion:2,reason:'重新核对进口费用'});assert.equal((await readCatalog(f.db,f.users.sales)).products[0].price.standardPrice,null);f.sqlite.close();
});
test('missing costs, invalid dates and crossed minimums cannot become published prices',async()=>{
 const f=setup();for(const patch of [{freightCost:''},{costConfirmed:false},{validUntil:'2026-02-30'},{standardPrice:90000,minimumPrice:100000},{standardMarkup:10,minimumMarkup:20}])await assert.rejects(f.call(f.users.admin,'pricePublish',price(patch)));
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_prices').get().n,0);f.sqlite.close();
});
test('unverified and below-floor orders require explicit financial exception; verified quotes lock on approval',async()=>{
 const f=setup(),id=await f.create({saleType:'cash'});await assert.rejects(f.approve(id),/价格例外/);assert.equal(f.orderRow(id).status,'pending');
 await f.change(f.users.finance,id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,priceExceptionConfirmed:true,reason:'核实到仓成本特别处理'});
 assert.equal(f.orderRow(id).status,'approved');assert.equal(f.sqlite.prepare("SELECT status FROM wholesale_price_snapshots WHERE order_id=? AND phase='approval'").get(id).status,'exception');
 await f.call(f.users.admin,'pricePublish',price());assert.equal(f.sqlite.prepare('SELECT unit_price FROM wholesale_order_items WHERE order_id=?').get(id).unit_price,100000);
 const b=await f.create({items:[{sku:'BAG-A',qty:1,unitPrice:95000}],saleType:'cash'});await assert.rejects(f.approve(b),/价格例外/);f.sqlite.close();
});
test('a refreshed quote must be reviewed; races atomically roll back approval and stock',async()=>{
 const f=setup();await f.call(f.users.admin,'pricePublish',price());const id=await f.create({saleType:'cash'});await f.call(f.users.admin,'pricePublish',price({priceVersion:1}));
 await assert.rejects(f.approve(id),/报价版本/);const original=f.db.batch;
 f.db.batch=async statements=>{f.sqlite.exec("INSERT INTO wholesale_prices SELECT 'race',sku,3,status,purchase_minor,freight_minor,tax_minor,inbound_minor,standard_markup_bp,minimum_markup_bp,rounding,standard_price,minimum_price,valid_until,cost_reference,reason,actor_id,actor_name,created_at FROM wholesale_prices WHERE sku='BAG-A' AND version=2");return original(statements);};
 await assert.rejects(f.change(f.users.finance,id,'orderApprove',{supplyUserId:f.users.supply.id,stockBasisConfirmed:true,priceVersions:{'BAG-A':2}}),e=>e.status===409);
 assert.equal(f.orderRow(id).status,'pending');assert.equal(f.sqlite.prepare('SELECT SUM(reserved_qty) n FROM inventory_balances').get().n,0);assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM wholesale_price_snapshots WHERE phase='approval'").get().n,0);f.sqlite.close();
});
test('sales special requests bind customer SKU quantity and validity; admin only approval; no inventory reservation before order approval',async()=>{
 const f=setup();await f.call(f.users.finance,'pricePublish',price());const id=await request(f);const r=requestRow(f,id);
 assert.equal((await readWholesale(f.db,f.users.sales2,indonesiaDate().slice(0,7))).catalog.requests.length,0);
 await assert.rejects(f.call(f.users.finance,'priceRequestDecide',{requestId:id}),e=>e.status===403);
 await assert.rejects(decision(f,id,{priceExceptionConfirmed:false}),/价格例外/);await decision(f,id);
 assert.equal(f.sqlite.prepare('SELECT SUM(reserved_qty) n FROM inventory_balances').get().n,0);
 const approved=requestRow(f,id);for(const items of [[{sku:'BAG-B',qty:5,unitPrice:90000,priceRequestId:id}],[{sku:'BAG-A',qty:6,unitPrice:90000,priceRequestId:id}],[{sku:'BAG-A',qty:5,unitPrice:89000,priceRequestId:id}]])await assert.rejects(createFromRequest(f,approved,{items}),/特批价格/);
 await assert.rejects(createFromRequest(f,approved,{customerId:await customer(f)}),/特批价格/);
 const order=await createFromRequest(f,approved);assert.equal(requestRow(f,id).used_order_id,order.id);await assert.rejects(createFromRequest(f,approved),/特批价格/);
 assert.equal(f.sqlite.prepare('SELECT SUM(reserved_qty) n FROM inventory_balances').get().n,0);await f.approve(order.id);
 assert.equal(f.sqlite.prepare("SELECT status FROM wholesale_price_snapshots WHERE order_id=? AND phase='approval'").get(order.id).status,'special_approved');
 assert.equal(f.sqlite.prepare("SELECT SUM(reserved_qty) n FROM inventory_balances WHERE site='印尼'").get().n,5);assert.equal(f.sqlite.prepare("SELECT SUM(qty) n FROM inventory_balances WHERE site='印尼'").get().n,40);assert.equal(r.customer_id,approved.customer_id);f.sqlite.close();
});
test('special request expiry, own approval, single-use race and historic orders preserve boundaries',async()=>{
 const f=setup();await f.call(f.users.admin,'pricePublish',price());const cid=await customer(f,f.users.admin),own=(await f.call(f.users.admin,'priceRequestCreate',{customerId:cid,sku:'BAG-A',qty:1,unitPrice:98000,reason:'本人申请客户特价'})).id;await assert.rejects(decision(f,own),e=>e.status===403);
 const id=await request(f);await decision(f,id);f.sqlite.prepare("UPDATE wholesale_price_requests SET valid_until='2000-01-01' WHERE id=?").run(id);await assert.rejects(createFromRequest(f,requestRow(f,id)),/特批价格/);
 const second=await request(f);await decision(f,second);const r=requestRow(f,second),results=await Promise.allSettled([createFromRequest(f,r),createFromRequest(f,r)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM wholesale_orders').get().n,1);
 const old=await f.create({items:[{sku:'BAG-B',qty:1,unitPrice:1}],saleType:'cash'});f.sqlite.prepare('UPDATE wholesale_orders SET pricing_policy_version=0 WHERE id=?').run(old);await f.approve(old);assert.equal(f.orderRow(old).status,'approved');f.sqlite.close();
});

test('quoted orders and customer special requests survive full backup/restore with immutable history and maintenance protection',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os');const {createBackup,restoreBackup}=await import('../server/backup.mjs'),{fileBucket,openDatabase}=await import('../server/storage.mjs'),{backupStream}=await import('../lib/full-backup.mjs'),{releaseMigrations}=await import('../lib/backup-version.mjs');
 const root=mkdtempSync(join(tmpdir(),'wh-quote-backup-')),f=setup();try{
 await f.call(f.users.admin,'pricePublish',price());const rid=await request(f);await decision(f,rid);const order=await createFromRequest(f,requestRow(f,rid));await f.approve(order.id);
 const bucket=fileBucket(join(root,'files')),stream=await backupStream(f.db,bucket,f.users.admin,releaseMigrations);
 assert.throws(()=>f.sqlite.prepare('UPDATE wholesale_price_requests SET version=version+1 WHERE id=?').run(rid),/maintenance/);await stream.cancel();
 const path=join(root,'backup.tar');await createBackup({DB:f.db,WHOLESALE_FILES:bucket},path);await restoreBackup(path,join(root,'restored'));const restored=openDatabase(join(root,'restored','business.sqlite'));
 for(const table of ['wholesale_prices','wholesale_price_requests','wholesale_price_snapshots'])assert.deepEqual(restored.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
 assert.equal(restored.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);assert.throws(()=>restored.sqlite.exec('DELETE FROM wholesale_price_snapshots'),/immutable/);restored.sqlite.close();
 }finally{f.sqlite.close();rmSync(root,{recursive:true,force:true});}
});

test('combined release migrations preserve every previous table and grant no cost access or production quote',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{readdirSync,readFileSync}=await import('node:fs');const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');const files=readdirSync(new URL('../drizzle',import.meta.url)).filter(f=>f.endsWith('.sql')).sort();
 for(const name of files.filter(f=>f<'0029'))db.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
 db.exec("INSERT INTO sku_settings(sku,name,updated_at) VALUES('LEGACY-SKU','Legacy','2026-10-01'); INSERT INTO inventory_balances(site,channel,sku,qty,updated_at) VALUES('印尼','TikTok','LEGACY-SKU',37,'2026-10-01')");
 const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all(),before=tables.map(({name})=>({name,columns:db.prepare(`PRAGMA table_info(${name})`).all().map(r=>r.name),rows:db.prepare(`SELECT * FROM ${name}`).all()}));
 for(const name of files.filter(f=>f>='0029'))db.exec(readFileSync(new URL('../drizzle/'+name,import.meta.url),'utf8'));
 for(const table of before)assert.deepEqual(db.prepare(`SELECT ${table.columns.map(c=>'"'+c+'"').join(',')} FROM "${table.name}"`).all(),table.rows,table.name);
 for(const table of ['cost_access','wholesale_prices','wholesale_price_requests','wholesale_price_snapshots'])assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0);
 assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
});
