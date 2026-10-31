import {ticketRows} from './cost-fixture.mjs';
import * as XLSX from "xlsx";
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync,existsSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {once} from 'node:events';import net from 'node:net';
import {openDatabase} from '../server/storage.mjs';import {setAccount,verifyPassword} from '../server/accounts.mjs';
import {NAVIGATION_BY_ROLE} from '../lib/permissions.mjs';
import {parseWorkspaceResponse} from '../lib/workspace-response.mjs';
// Production Node build is a required gate; do not silently skip this integration test.
test('独立服务器：公司登录、禁止伪造身份、岗位隔离、出库销售和Excel导出',async()=>{
 assert.ok(existsSync('dist-node/server/index.js'),'Run pnpm build:server before tests');const root=mkdtempSync(join(tmpdir(),'lj-http-')),sqlite=openDatabase(join(root,'business.sqlite')).sqlite,password='test-only-'+crypto.randomUUID();
 for(const [id,role] of [['admin','管理员'],['sales','销售'],['supply','供应链'],['finance','财务']])setAccount(sqlite,{id,email:`${id}@example.test`,name:id,role,site:role==='销售'?'印尼':null,password});sqlite.prepare('INSERT INTO sku_settings(sku,name,updated_at) VALUES (?,?,?)').run('HTTP-BAG','bag',new Date().toISOString());for(const ch of ['TikTok','Shopee'])sqlite.prepare('INSERT INTO inventory_balances(site,channel,sku,qty,updated_at) VALUES (?,?,?,?,?)').run('印尼',ch,'HTTP-BAG',10,new Date().toISOString());assert.ok(!sqlite.prepare('SELECT password_hash FROM local_accounts').get().password_hash.includes(password));sqlite.close();
 const cleanFixture=openDatabase(join(root,'business.sqlite')).sqlite;
 for(const month of ['2026-09','2026-10']){
  cleanFixture.prepare("INSERT INTO new_product_projects(id,cycle_month,sku,stage_started_at,current_due_at,created_by,created_at,updated_at) VALUES(?,?,'HTTP-BAG','2026-09-01','2026-09-04','admin','2026-09-01','2026-09-01')").run(month,month);
  cleanFixture.prepare("INSERT INTO new_product_stage_records(id,project_id,stage_key,data_json,actor_id,actor_name,submitted_at,updated_at) VALUES(?,?,'candidate','{}','admin','管理员','2026-09-01','2026-09-01')").run(month,month);
 }cleanFixture.close();
 const free=net.createServer();free.listen(0,'127.0.0.1');await once(free,'listening');const port=free.address().port;await new Promise(r=>free.close(r));const origin=`http://127.0.0.1:${port}`;let logs='';const child=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,NODE_ENV:'production',LOONGJUMP_DATA_DIR:root,LOONGJUMP_ORIGIN:origin,LOONGJUMP_ALLOW_HTTP:'1',PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 try{await new Promise((res,rej)=>{const timer=setTimeout(()=>rej(Error('Server startup timeout: '+logs)),15000);child.stdout.on('data',b=>{if(String(b).includes('ready at')){clearTimeout(timer);res()}});child.once('exit',code=>{clearTimeout(timer);rej(Error(`Server exited ${code}: ${logs}`))})});
 const forged=await fetch(origin+'/api/system',{headers:{'oai-authenticated-user-id':'admin','oai-authenticated-user-email':'admin@example.test','x-local-test-user':'admin'}});assert.equal(forged.status,401);
 const login=async (who,remember=false)=>{const page=await fetch(origin+'/signin-with-chatgpt'),html=await page.text(),csrf=html.match(/name="csrf" value="([a-f0-9]+)"/)[1],pre=page.headers.getSetCookie()[0].split(';')[0];const r=await fetch(origin+'/signin-with-chatgpt',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded',cookie:pre},body:new URLSearchParams({csrf,email:`${who}@example.test`,password,remember:remember?'1':'0'})});assert.equal(r.status,303,await r.text());const session=r.headers.getSetCookie().find(c=>c.startsWith('lj_session='));assert.match(session,new RegExp('Max-Age='+(remember?2592000:28800)));assert.match(session,/HttpOnly/);return session.split(';')[0]};
 const health=await fetch(origin+'/healthz');assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true,release:'local'});
 const cookies={};for(const who of ['admin','sales','supply','finance'])cookies[who]=await login(who,who==='sales');
 const request=async(who,path,payload)=>{const r=await fetch(origin+path,{method:payload?'POST':'GET',headers:{cookie:cookies[who],origin,...(payload?{'content-type':'application/json'}:{})},...(payload?{body:JSON.stringify({...payload,operationId:crypto.randomUUID()})}:{})});const text=await r.text();let body;try{body=JSON.parse(text)}catch{body=text}return {status:r.status,body}};

 { // Navigate every role through real company sessions, not the route-test identity shim.
 const roles=Object.entries(NAVIGATION_BY_ROLE),accounts=openDatabase(join(root,'business.sqlite')).sqlite;
 for(const [index,[role]] of roles.entries())setAccount(accounts,{id:`nav${index}`,email:`nav${index}@example.test`,name:`TEST-${role}`,role,site:role==='运营'||role==='销售'?'印尼':null,channel:role==='运营'?'TikTok':null,password});accounts.close();
 for(const [index,[role,modules]] of roles.entries()){
  const cookie=await login(`nav${index}`);
  for(const module of modules){
   const response=await fetch(origin+'/api/system?module='+module,{headers:{cookie}});
   assert.equal(response.status,200,`${role}/${module}: ${await response.clone().text()}`);
   const snapshot=await parseWorkspaceResponse(response,{snapshot:true});assert.equal(snapshot.actor.role,role);
  }
  if(role!=='管理员')assert.equal((await fetch(origin+'/api/system?module=users',{headers:{cookie}})).status,403);
  if(role==='达人BD'){
   const ledger=await fetch(origin+'/api/creators',{headers:{cookie}});assert.equal(ledger.status,200);assert.deepEqual((await ledger.json()).profiles,[]);
   for(const path of ['/api/business-actions','/api/finance-ledger','/api/sales-dashboard','/api/after-sales','/api/cost-profit','/api/system?history=imports'])assert.equal((await fetch(origin+path,{headers:{cookie}})).status,403,path);
   assert.equal((await fetch(origin+'/api/system',{method:'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:'{"action":"salesImport"}'})).status,403);
   assert.equal((await fetch(origin+'/api/creators',{method:'POST',headers:{cookie,origin:'https://wrong.example','Content-Type':'application/json'},body:'{}'})).status,403);
   assert.equal((await fetch(origin+'/api/creators',{method:'POST',headers:{cookie,origin,'Content-Type':'application/json'},body:'{'})).status,400);
  }
 }
 }

 { // Financial routes use the same real session and reject unauthorized roles and origins.
 const path='/api/finance-ledger';assert.equal((await fetch(origin+path)).status,401);
 for(const who of ['sales','supply'])assert.equal((await request(who,path)).status,403);
 for(const who of ['admin','finance']){const result=await request(who,path);assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(Array.isArray(result.body.balances));}
 assert.equal((await fetch(origin+path,{method:'POST',headers:{cookie:cookies.admin,origin:'https://wrong.example','Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await request('finance',path,{action:'access',userId:'supply',canRead:true,reason:'TEST'})).status,403);
 }
 { // Cost API uses actual session authentication; migration grants nobody by default.
 const path='/api/cost-profit';
 assert.equal((await fetch(origin+path)).status,401);
 for(const who of ['sales','supply','finance'])assert.equal((await request(who,path)).status,403);
 assert.equal((await fetch(origin+path,{headers:{'x-local-test-user':'admin','oai-authenticated-user-id':'admin'}})).status,401);
 assert.equal((await fetch(origin+path,{method:'POST',headers:{origin:'https://attacker.test',cookie:cookies.admin,'content-type':'application/json'},body:'{}'})).status,403);
 const input=ticketRows({businessKey:'HTTP-COST'}).map(r=>({...r,sku:'HTTP-BAG'}));
 const beforeDb=openDatabase(join(root,'business.sqlite')).sqlite,beforeStock=beforeDb.prepare('SELECT SUM(qty) n FROM inventory_balances').get().n;beforeDb.close();
 for(const who of ['sales','supply','finance'])assert.equal((await request(who,path,{action:'previewImport',rows:input})).status,403);
 const p=await request('admin',path,{action:'previewImport',rows:input});assert.equal(p.status,200,JSON.stringify(p.body));assert.equal(p.body.errors.length,0);
 assert.equal((await request('admin',path)).body.tickets.length,0); // Cancelling a preview performs zero writes.
 const args={action:'commitImport',rows:input,fileName:'HTTP.csv',fingerprint:p.body.fingerprint,version:p.body.version};
 const first=await request('admin',path,args);assert.equal(first.status,200,JSON.stringify(first.body));
 assert.notEqual((await request('admin',path,args)).status,200);
 const invalid=[...ticketRows({businessKey:'HTTP-GOOD'}).map(r=>({...r,sku:'HTTP-BAG'})),...ticketRows({businessKey:'HTTP-INVALID'}).map(r=>({...r,sku:'UNKNOWN'}))];
 const bad=await request('admin',path,{action:'previewImport',rows:invalid});assert.ok(bad.body.errors.length);
 assert.equal((await request('admin',path,{action:'commitImport',rows:invalid,fileName:'bad.csv',fingerprint:bad.body.fingerprint,version:bad.body.version})).status,400);
 // A failure on the second insert rolls back even the first ticket and its audit entry.
 const db=openDatabase(join(root,'business.sqlite')).sqlite;db.exec("CREATE TRIGGER http_cost_failure BEFORE INSERT ON cost_records WHEN NEW.business_key='HTTP-FAIL' BEGIN SELECT RAISE(ABORT,'test rollback'); END;");db.close();
 const rollback=[...ticketRows({businessKey:'HTTP-FIRST'}),...ticketRows({businessKey:'HTTP-FAIL'})].map(r=>({...r,sku:'HTTP-BAG'}));
 const rp=await request('admin',path,{action:'previewImport',rows:rollback});assert.equal(rp.body.errors.length,0);
 assert.equal((await request('admin',path,{action:'commitImport',rows:rollback,fileName:'rollback.csv',fingerprint:rp.body.fingerprint,version:rp.body.version})).status,500);
 const afterDb=openDatabase(join(root,'business.sqlite')).sqlite;assert.equal(afterDb.prepare('SELECT SUM(qty) n FROM inventory_balances').get().n,beforeStock);assert.equal(afterDb.prepare('SELECT COUNT(*) n FROM cost_records').get().n,1);assert.equal(afterDb.prepare('SELECT COUNT(*) n FROM cost_imports').get().n,1);afterDb.exec('DROP TRIGGER http_cost_failure');afterDb.close();
 assert.equal((await request('admin',path)).body.tickets.length,1);
 assert.equal((await request('finance',path,{action:'review',id:first.body.ids[0],taxTreatment:'inventory',note:'越权复核'})).status,403);
 }
 const system=await request('admin','/api/system');assert.equal(system.status,200,JSON.stringify(system.body));const page=await fetch(origin+'/',{headers:{cookie:cookies.admin}});assert.equal(page.status,200);assert.ok((await page.text()).includes('LOONG'));
 assert.equal((await fetch(origin+'/api/inventory-baseline')).status,401);
 assert.equal((await fetch(origin+'/api/test-cleanup')).status,401);
 assert.equal((await fetch(origin+'/admin/test-cleanup',{headers:{cookie:cookies.admin}})).status,200);
 assert.equal((await request('sales','/api/test-cleanup',{action:'preview'})).status,403);
 assert.equal((await request('admin','/api/test-cleanup',{action:'preview'})).status,200);
 const cleanupScope='september_products';
 const cleanupPage=await request('admin','/admin/test-cleanup');assert.match(cleanupPage.body,/仅2026年9月新品孵化/);
 assert.equal((await request('admin','/api/test-cleanup',{action:'preview',scope:'2026-10'})).status,400);
 const targeted=await request('admin','/api/test-cleanup',{action:'preview',scope:cleanupScope});assert.equal(targeted.status,200);assert.deepEqual(targeted.body.counts,{new_product_stage_records:1,new_product_projects:1});
 assert.equal((await request('admin','/api/test-cleanup',{action:'apply',scope:'prelaunch_all',expected:targeted.body})).status,409);
 assert.equal((await request('sales','/api/test-cleanup',{action:'apply',scope:cleanupScope,expected:targeted.body})).status,403);
 const cleaned=await request('admin','/api/test-cleanup',{action:'apply',scope:cleanupScope,expected:{scope:cleanupScope,fingerprint:targeted.body.fingerprint}});assert.equal(cleaned.status,200,JSON.stringify(cleaned.body));
 assert.equal((await request('admin','/api/test-cleanup',{action:'preview',scope:cleanupScope})).body.counts.new_product_projects,0);
 assert.equal((await request('admin','/api/test-cleanup',{action:'status',scope:cleanupScope})).body.id,cleaned.body.id);
 assert.equal((await request('admin','/api/test-cleanup',{action:'status',scope:'prelaunch_all'})).body.id,null);
 assert.equal((await request('admin','/api/test-cleanup',{action:'undo',scope:cleanupScope,id:cleaned.body.id})).status,200);
 assert.equal((await request('admin','/api/test-cleanup',{action:'preview',scope:cleanupScope})).body.counts.new_product_projects,1);
 assert.equal((await request('admin','/api/test-cleanup',{action:'status',scope:cleanupScope})).body.id,null);

 assert.equal((await fetch(origin+'/api/test-cleanup',{method:'POST',headers:{cookie:cookies.admin,origin:'https://attacker.test','content-type':'application/json'},body:JSON.stringify({action:'apply'})})).status,403);
 assert.equal((await fetch(origin+'/admin/inventory-baseline',{headers:{cookie:cookies.admin}})).status,200);
 assert.equal((await request('sales','/api/inventory-baseline',{action:'status'})).status,403);
 assert.deepEqual((await request('admin','/api/inventory-baseline',{action:'status'})).body,{active:false});
 assert.equal((await fetch(origin+'/api/inventory-baseline',{method:'POST',headers:{cookie:cookies.admin,origin:'https://attacker.test','content-type':'application/json'},body:JSON.stringify({action:'apply'})})).status,403);
 // Account creation must work through the real company login and production router.
 assert.equal((await fetch(origin+'/api/users')).status,401);
 assert.deepEqual((await request('admin','/api/users')).body,{canCreate:true,loginMode:'company'});
 assert.equal((await request('sales','/api/users')).status,403);
 const employee={name:'网页新增运营',email:' Newops@Example.Test ',password,role:'运营',site:'马来西亚',channel:'Shopee',responsibilityUnit:'运营团队',active:true};
 for(const who of ['sales','supply','finance'])assert.equal((await request(who,'/api/users',employee)).status,403);
 const crossSite=await fetch(origin+'/api/users',{method:'POST',headers:{origin:'https://attacker.test',cookie:cookies.admin,'content-type':'application/json'},body:JSON.stringify(employee)});assert.equal(crossSite.status,403);
 const malformed=await fetch(origin+'/api/users',{method:'POST',headers:{origin,cookie:cookies.admin,'content-type':'application/json'},body:'null'});assert.equal(malformed.status,400);
 const oversized=await fetch(origin+'/api/users',{method:'POST',headers:{origin,cookie:cookies.admin,'content-type':'application/json'},body:JSON.stringify({...employee,name:'x'.repeat(9000)})});assert.equal(oversized.status,413);
 assert.equal((await request('admin','/api/users',{...employee,password:'short'})).status,400);
 assert.equal((await request('admin','/api/users',{...employee,site:''})).status,400);
 const [created,repeated]=await Promise.all([request('admin','/api/users',employee),request('admin','/api/users',employee)]);
 assert.deepEqual([created.status,repeated.status].sort(),[201,409]);
 const accountResult=created.status===201?created:repeated;
 assert.ok(accountResult.body.userId);assert.ok(!JSON.stringify(accountResult.body).includes(password));
 cookies.newops=await login('newops');
 const employeeView=await request('newops','/api/system');assert.equal(employeeView.status,200);
 assert.equal(employeeView.body.actor.id,accountResult.body.userId);assert.equal(employeeView.body.actor.role,'运营');
 assert.equal(employeeView.body.actor.site,'马来西亚');assert.equal(employeeView.body.actor.channel,'Shopee');
 assert.ok(employeeView.body.inventory.every(row=>row.site==='马来西亚'&&row.channel==='Shopee'));
 assert.equal((await request('newops','/api/users',{...employee,email:'forbidden@example.test'})).status,403);
 { // Monthly targets use real authenticated routes, scoped reads and admin-only writes.
 const month=new Date(Date.now()+8*3600000).toISOString().slice(0,7),path='/api/sales-targets?month='+month;
 assert.equal((await fetch(origin+path)).status,401);
 for(const who of ['sales','supply'])assert.equal((await request(who,path)).status,403);
 const p={month,site:'马来西亚',channel:'Shopee',ownerId:accountResult.body.userId,revenueCny:50000,quantity:2000,budgetCny:5000,note:'HTTP integration',reason:'按月确认经营目标',version:0};
 for(const who of ['finance','newops'])assert.equal((await request(who,path,p)).status,403);
 assert.equal((await fetch(origin+path,{method:'POST',headers:{origin:'https://attacker.test',cookie:cookies.admin,'content-type':'application/json'},body:JSON.stringify(p)})).status,403);
 assert.equal((await fetch(origin+path,{method:'POST',headers:{origin,cookie:cookies.admin,'content-type':'application/json'},body:'null'})).status,400);
 const saved=await request('admin',path,p);assert.equal(saved.status,200,JSON.stringify(saved.body));
 assert.equal((await request('admin',path,p)).status,409);
 const own=await request('newops',path);assert.equal(own.status,200,JSON.stringify(own.body));assert.equal(own.body.rows.length,1);assert.equal(own.body.rows[0].target.owner_id,accountResult.body.userId);assert.equal(own.body.canManage,false);
 assert.equal((await request('finance',path)).body.rows.length,10);
 assert.equal((await request('newops','/api/sales-targets?history='+saved.body.id)).body.length,1);
 }
 { // After-sales routes require authentication, protect draft evidence and enforce ownership.
 const afterMonth=new Date(Date.now()+8*3600000).toISOString().slice(0,7);
 assert.equal((await fetch(origin+'/api/after-sales?month='+afterMonth)).status,401);
 assert.equal((await request('finance','/api/after-sales?month='+afterMonth)).status,200);
 const afterCreated=await request('newops','/api/after-sales',{action:'create',businessDate:afterMonth+'-01',caseNo:'HTTP-AFTER-1',orderNo:'HTTP-ORDER-1',sku:'HTTP-SKU',qty:1,reason:'商品质量问题',description:'客户反馈拉链损坏',refundAmount:'5.25'});
 assert.equal(afterCreated.status,200,JSON.stringify(afterCreated.body));const afterId=afterCreated.body.id;
 assert.equal((await request('admin','/api/after-sales?history='+afterId)).status,404);
 const form=new FormData();form.append('recordId',afterId);form.append('file',new File([new Uint8Array([255,216,255,1])],'proof.jpg',{type:'image/jpeg'}));
 const uploaded=await fetch(origin+'/api/after-sales/files',{method:'POST',headers:{origin,cookie:cookies.newops},body:form});assert.equal(uploaded.status,200);const proof=await uploaded.json();
 assert.equal((await request('admin','/api/after-sales/files?id='+proof.id)).status,404);
 assert.equal((await request('newops','/api/after-sales/files?id='+proof.id)).status,200);
 assert.equal((await request('finance','/api/after-sales/files?id='+proof.id)).status,404);
 assert.equal((await request('finance','/api/after-sales?month='+afterMonth)).body.records.some(r=>r.id===afterId),false);
 const afterRows=await request('newops','/api/after-sales?month='+afterMonth);const afterRow=afterRows.body.records.find(r=>r.id===afterId);
 const crossAfter=await fetch(origin+'/api/after-sales',{method:'POST',headers:{origin:'https://attacker.test',cookie:cookies.newops,'content-type':'application/json'},body:JSON.stringify({action:'submit',id:afterId,version:afterRow.version})});assert.equal(crossAfter.status,403);
 assert.equal((await request('newops','/api/after-sales',{action:'submit',id:afterId,version:afterRow.version})).status,200);
 assert.equal((await request('admin','/api/after-sales/files?id='+proof.id)).status,200);
 assert.equal((await request('finance','/api/after-sales/files?id='+proof.id)).status,200);
 }

 let updatedUsers=await request('admin','/api/system');
 assert.equal(updatedUsers.body.users.find(user=>user.id===accountResult.body.userId).responsibility_unit,'运营团队');
 const creationAudit=updatedUsers.body.audit.find(row=>row.entity_id===accountResult.body.userId);
 assert.equal(creationAudit.action,'新增用户');assert.ok(!JSON.stringify(updatedUsers.body).includes(password));assert.ok(!JSON.stringify(updatedUsers.body).includes('password_hash'));
 assert.equal((await request('admin','/api/system',{action:'assignUser',userId:accountResult.body.userId,role:'运营',site:'马来西亚',channel:'Shopee',active:false})).status,200);
 assert.equal((await request('newops','/api/system')).status,401);
 updatedUsers=await request('admin','/api/system');assert.equal(updatedUsers.body.users.find(user=>user.id===accountResult.body.userId).active,0);
 assert.equal((await request('admin','/api/system',{action:'assignUser',userId:accountResult.body.userId,role:'运营',site:'马来西亚',channel:'Shopee',active:true})).status,200);
 cookies.newops=await login('newops');assert.equal((await request('newops','/api/system')).status,200);
 // Bulk imports are authenticated and atomic through the production HTTP router.
 const importMeta={fileName:'http-stock.csv',fileHash:'c'.repeat(64)};
 const stockRows=[{site:'马来西亚',channel:'Shopee',sku:'HTTP-IMPORT',name:'导入库存',countedQty:12,reason:'期初库存核对'}];
 assert.equal((await request('finance','/api/system',{action:'bulkImport',kind:'inventory',rows:stockRows,...importMeta})).status,403);
 const bulk=await request('admin','/api/system',{action:'bulkImport',kind:'inventory',rows:stockRows,...importMeta});assert.equal(bulk.status,200,JSON.stringify(bulk.body));assert.equal(bulk.body.imported,1);
 assert.equal((await request('admin','/api/system',{action:'bulkImport',kind:'inventory',rows:stockRows,...importMeta})).status,409);
 const opsCount=await request('newops','/api/system',{action:'bulkImport',kind:'inventory',rows:[{...stockRows[0],countedQty:9}],...importMeta});assert.equal(opsCount.status,200,JSON.stringify(opsCount.body));
 assert.equal((await request('newops','/api/system')).body.inventory.find(r=>r.sku==='HTTP-IMPORT').qty,12);
 assert.equal((await request('newops','/api/system',{action:'bulkImport',kind:'inventory',rows:[{...stockRows[0],site:'印尼',countedQty:2}],...importMeta})).status,403);
 const importedReceipt={receiptNo:'HTTP-RCV-1',businessDate:new Date(Date.now()+8*3600_000).toISOString().slice(0,10),note:'历史在途货物实际签收',sku:'HTTP-BAG',site:'印尼',channel:'TikTok',qty:3,proofRef:'仓库签收001'};
 await request('admin','/api/system',{action:'saveWarehouse',code:'HTTP-ID-TK',name:'HTTP主仓',site:'印尼',channel:'TikTok',active:true,capacityQty:0});
 const inboundPreview=await request('admin','/api/system',{action:'previewInbound',rows:[importedReceipt]});assert.equal(inboundPreview.status,200,JSON.stringify(inboundPreview.body));
 assert.equal((await request('admin','/api/system',{action:'bulkImport',kind:'inbound',rows:inboundPreview.body.rows,previewToken:inboundPreview.body.token,confirmed:true,...importMeta})).status,200);
 const invalidBatch=await request('admin','/api/system',{action:'bulkImport',kind:'inbound',rows:[{...importedReceipt,receiptNo:'HTTP-RCV-2'},importedReceipt],...importMeta});assert.equal(invalidBatch.status,409);
 const afterImport=await request('admin','/api/system');assert.ok(!afterImport.body.inboundDocuments.some(r=>r.receipt_no==='HTTP-RCV-2'));
 const salesImport={action:'salesImport',site:'马来西亚',channel:'Shopee',businessDate:new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10),sourceBatchRef:'HTTP-SALES-001',importKey:'http-file-sales-001',rows:[{sku:'HTTP-IMPORT',qty:2}],fileName:'sales.csv'};
 assert.equal((await request('newops','/api/system',salesImport)).status,200);
 assert.equal((await request('newops','/api/system',salesImport)).status,409);
 const disguised=await request('newops','/api/system',{...salesImport,fileName:'renamed.xlsx',sourceBatchRef:'ANOTHER-BATCH',importKey:'changed-file-and-batch',rows:[{sku:'NEW-ROW-FIRST',qty:2},{sku:'HTTP-IMPORT',qty:3}]});
 assert.equal(disguised.status,409);assert.match(disguised.body.error,/重叠/);
 const noRepeat=await request('newops','/api/system');assert.equal(noRepeat.body.inventory.find(r=>r.sku==='HTTP-IMPORT').qty,10);assert.ok(!noRepeat.body.inventory.some(r=>r.sku==='NEW-ROW-FIRST'));
 assert.equal(noRepeat.body.imports.find(r=>r.import_key===salesImport.importKey).report_kind,'partial');
 const forecastPending=noRepeat.body.suggestions.find(r=>r.sku==='HTTP-IMPORT');assert.equal(forecastPending.forecastReady,false);assert.equal(forecastPending.suggestedProduction,null);

 assert.equal((await request('newops','/api/system')).body.inventory.find(r=>r.sku==='HTTP-IMPORT').qty,10);
 assert.equal((await request('newops','/api/system',{action:'confirmSalesDay',site:'马来西亚',channel:'Shopee',businessDate:new Date(Date.now()+8*3600000).toISOString().slice(0,10),confirmed:true,note:'当天仍在营业不可确认'})).status,400);
 const confirmDay={action:'confirmSalesDay',site:'马来西亚',channel:'Shopee',businessDate:salesImport.businessDate,confirmed:true,note:'HTTP核对平台整日销量'};
 assert.equal((await request('finance','/api/system',confirmDay)).status,403);
 assert.equal((await request('newops','/api/system',{...confirmDay,site:'印尼'})).status,403);
 assert.equal((await request('newops','/api/system',confirmDay)).status,200);
 assert.equal((await request('newops','/api/system')).body.salesScopeStatus[0].updatedExpected,true);

 // Sales dashboard retains authentication and site scope through the actual router.
 assert.equal((await fetch(origin+'/api/sales-dashboard')).status,401);
 for(const who of ['sales','finance'])assert.equal((await request(who,'/api/sales-dashboard')).status,403);
 assert.equal((await request('newops','/api/sales-dashboard?site='+encodeURIComponent('印尼'))).status,403);
 const performance=await request('newops','/api/system',{...salesImport,sourceBatchRef:'HTTP-PRICE-002',importKey:'http-file-price-002',rows:[{sku:'HTTP-PRICE-ONLY',qty:2,amount:50.25,adCost:10,currency:'MYR'},{sku:'HTTP-AD-ONLY',qty:0,adCost:5,currency:'MYR'}]});assert.equal(performance.status,200,JSON.stringify(performance.body));
 const dashboard=await request('newops','/api/sales-dashboard');assert.equal(dashboard.status,200,JSON.stringify(dashboard.body));assert.equal(dashboard.body.totalQty,4);assert.equal(dashboard.body.currencies[0].revenue,50.25);assert.equal(dashboard.body.currencies[0].roas,null);assert.equal(dashboard.body.roiRanking.find(r=>r.sku==='HTTP-AD-ONLY').roas,0);
 assert.ok(dashboard.body.scopes.every(r=>r.site==='马来西亚'&&r.channel==='Shopee'));
 assert.equal((await request('newops','/api/sales-dashboard?from=2026-02-30')).status,400);
 const reversal=await request('admin','/api/system',{action:'reverseSalesImport',importId:performance.body.importId,reason:'接口测试纠正重复报表'});assert.equal(reversal.status,200,JSON.stringify(reversal.body));
 assert.equal((await request('newops','/api/sales-dashboard')).body.totalQty,2);
 const crossImport=await fetch(origin+'/api/system',{method:'POST',headers:{cookie:cookies.admin,origin:'https://attacker.test','content-type':'application/json'},body:JSON.stringify({action:'bulkImport',kind:'inventory',rows:stockRows,...importMeta})});assert.equal(crossImport.status,403);
 {
 const catalogPrice={action:'pricePublish',sku:'HTTP-BAG',priceVersion:0,purchaseCost:'70000',freightCost:'6000',taxCost:'2000',inboundCost:'2000',standardMarkup:'25',minimumMarkup:'20',rounding:'100',validUntil:'2099-01-01',costReference:'HTTP-PRIVATE-COST',reason:'HTTP核对到仓成本',costConfirmed:true};
 assert.equal((await request('sales','/api/wholesale',catalogPrice)).status,403);
 assert.equal((await request('supply','/api/wholesale',catalogPrice)).status,403);
 const published=await request('finance','/api/wholesale',catalogPrice);assert.equal(published.status,200,JSON.stringify(published.body));
 for(const who of ['sales','supply']){const catalog=(await request(who,'/api/wholesale')).body.catalog;assert.equal(catalog.products.find(p=>p.sku==='HTTP-BAG').available,23);assert.equal(catalog.priceHistory,undefined);assert.ok(!JSON.stringify(catalog).includes('HTTP-PRIVATE-COST'));}
 assert.equal((await request('finance','/api/cost-profit')).status,403);
 const productPath='/api/product-costs',productInput={action:'preview',currency:'CNY',currencyConfirmed:true,basis:'unconfirmed',effectiveDate:'2026-10-01',fileName:'HTTP-TEST-ONLY.xlsx',fileHash:'d'.repeat(64),reason:'接口成本权限核验',rows:[{sku:'HTTP-BAG',site:'印尼',purchase:20,freight:2,total:22,source:{sheet:'Sheet2',row:3}}]};
 for(const who of ['sales','supply'])assert.equal((await request(who,productPath)).status,403);
 assert.equal((await request('newops',productPath,productInput)).status,403);
 const costPreview=await request('finance',productPath,productInput);assert.equal(costPreview.status,200,JSON.stringify(costPreview.body));
 assert.equal((await request('finance',productPath,{...productInput,action:'commit',version:costPreview.body.version,fingerprint:costPreview.body.fingerprint})).status,200);
 assert.equal((await request('finance',productPath)).body.costs[0].unit,220000);
 const scopedCosts=await request('newops',productPath);assert.equal(scopedCosts.status,200);assert.equal(scopedCosts.body.costs.length,0);assert(!JSON.stringify(scopedCosts.body).includes('HTTP-TEST-ONLY.xlsx'));
 const badOrigin=await fetch(origin+productPath,{method:'POST',headers:{cookie:cookies.finance,origin:'https://attacker.test','content-type':'application/json'},body:JSON.stringify(productInput)});assert.equal(badOrigin.status,403);
 }
 const c=await request('sales','/api/wholesale',{action:'customerCreate',name:'HTTP客户',contact:'Sari',phone:'08123456',city:'Jakarta',address:'Warehouse 1'});assert.equal(c.status,200,JSON.stringify(c.body));const day=new Date(Date.now()+7*3600000).toISOString().slice(0,10);
 // Field workspace uses the real production router, authentication and file storage.
 assert.equal((await fetch(origin+'/api/field-sales')).status,401);
 assert.equal((await request('supply','/api/field-sales')).status,200);
 const field=await request('sales','/api/field-sales',{action:'create',kind:'visit',customerId:c.body.id,businessDate:day,visitType:'cold',note:'Discussed wholesale products in the shop.'});assert.equal(field.status,200,JSON.stringify(field.body));
 const fieldId=field.body.id,png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB5sAAAAASUVORK5CYII=','base64');
 const upload=async who=>{const body=new FormData();body.set('recordId',fieldId);body.set('file',new File([png],'shop.png',{type:'image/png'}));return fetch(origin+'/api/field-sales/files',{method:'POST',headers:{cookie:cookies[who],origin},body})};
 assert.equal((await upload('finance')).status,403);const uploaded=await upload('sales');assert.equal(uploaded.status,200);const fileId=(await uploaded.json()).id;
 const image=await fetch(origin+'/api/field-sales/files?id='+fileId,{headers:{cookie:cookies.sales}});assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/svg+xml');assert.match(await image.text(),/Uploaded \/ Waktu unggah: .* WIB/);
 assert.equal((await fetch(origin+'/api/field-sales/files?id='+fileId)).status,401);assert.equal((await fetch(origin+'/api/field-sales/files?id='+fileId,{headers:{cookie:cookies.supply}})).status,200);
 let fieldView=await request('sales','/api/field-sales');assert.equal(fieldView.body.records[0].version,2);assert.equal((await request('sales','/api/field-sales',{action:'submit',id:fieldId,version:2,location:{latitude:-6.2,longitude:106.8,accuracy:15,capturedAt:Date.now()}})).status,200);
 assert.equal((await upload('sales')).status,409);fieldView=await request('finance','/api/field-sales');assert.equal(fieldView.body.records[0].status,'valid');assert.equal(fieldView.body.contributions.find(r=>r.id==='sales').visits,1);
 const o=await request('sales','/api/wholesale',{action:'orderCreate',saleType:'consignment',customerId:c.body.id,businessDate:day,paymentTerms:'credit',dueDate:'2027-01-01',items:[{sku:'HTTP-BAG',qty:5,unitPrice:100000}]});assert.equal(o.status,200);let view=await request('sales','/api/wholesale'),order=view.body.orders[0];
 // Export unshipped order items through the real authenticated endpoint.
 const exportUrl='/api/wholesale/export?mode=filtered&month='+day.slice(0,7)+'&view=orders&status=pending&search=HTTP-BAG';
 assert.equal((await fetch(origin+exportUrl)).status,401);
 const exportBook=async who=>{const response=await fetch(origin+exportUrl,{headers:{cookie:cookies[who]}});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/spreadsheetml/);assert.match(response.headers.get('content-disposition'),/xlsx/);return XLSX.read(await response.arrayBuffer(),{type:'array'})};
 const pendingBook=await exportBook('sales'),pendingRows=XLSX.utils.sheet_to_json(pendingBook.Sheets['订单SKU明细']);
 assert.equal(pendingRows.length,1);assert.equal(pendingRows[0]['SKU'],'HTTP-BAG');assert.equal(pendingRows[0]['申请件数'],5);assert.equal(pendingRows[0]['订单商品金额IDR'],500000);assert.equal(pendingRows[0]['已出库件数'],0);
 const unassigned=await exportBook('supply');assert.equal(XLSX.utils.sheet_to_json(unassigned.Sheets['订单SKU明细']).length,0);
 assert.equal((await request('sales','/api/wholesale/export?mode=filtered&status=not-a-status')).status,400);
 assert.equal((await request('sales','/api/wholesale',{action:'orderApprove',orderId:o.body.id,version:order.version,supplyUserId:'supply',stockBasisConfirmed:true,reason:'申请人不得自行审批'})).status,403);
 assert.equal((await request('finance','/api/wholesale',{action:'orderApprove',orderId:o.body.id,version:order.version,supplyUserId:'supply',stockBasisConfirmed:true,reason:'核对库存允许出库'})).status,200);
 view=await request('finance','/api/wholesale');order=view.body.orders[0];
 const prepareUrl='/api/wholesale/export?mode=prepare&orderId='+order.id+'&version='+order.version+'&lang=id';
 assert.equal((await fetch(origin+prepareUrl)).status,401);
 assert.equal((await request('sales',prepareUrl)).status,403);
 assert.equal((await request('finance',prepareUrl.replace('version='+order.version,'version=0'))).status,409);
 const prepResponse=await fetch(origin+prepareUrl,{headers:{cookie:cookies.finance}});assert.equal(prepResponse.status,200);const prepBook=XLSX.read(await prepResponse.arrayBuffer(),{type:'array'}),prepData=XLSX.utils.sheet_to_json(prepBook.Sheets[prepBook.SheetNames[0]],{header:1});assert.equal(prepData[2][4],'HTTP-BAG');assert.equal(prepData[2][8],5);assert.equal(prepData[2][17],'Konsinyasi');
 view=await request('supply','/api/wholesale');order=view.body.orders[0];assert.equal((await request('supply','/api/wholesale',{action:'orderShip',orderId:order.id,version:order.version,items:[{itemId:order.items[0].id,qty:5}],businessDate:day,warehouse:'印尼仓',carrier:'JNE',trackingNo:'HTTP001',handoverConfirmed:true})).status,200);
 // Customer receipt confirmation goes through the authenticated router and keeps finance independent.
 view=await request('sales','/api/wholesale');order=view.body.orders[0];assert.equal(order.customerReceipt.pending,1);
 const receiptPayload={action:'customerReceiptConfirm',orderId:order.id,version:order.version,shipmentId:order.shipments[0].id,businessDate:day,receiver:'HTTP recipient',proofRef:'Customer chat confirms all goods received',receivedConfirmed:true};
 assert.equal((await fetch(origin+'/api/wholesale',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({...receiptPayload,operationId:crypto.randomUUID()})})).status,401);
 assert.equal((await fetch(origin+'/api/wholesale',{method:'POST',headers:{origin:'https://attacker.test',cookie:cookies.sales,'content-type':'application/json'},body:JSON.stringify({...receiptPayload,operationId:crypto.randomUUID()})})).status,403);
 assert.equal((await request('sales','/api/wholesale',receiptPayload)).status,200);
 for(const who of ['sales','supply','finance','admin']){const receiptOrder=(await request(who,'/api/wholesale')).body.orders[0];assert.equal(receiptOrder.customerReceipt.confirmed,1);assert.equal(receiptOrder.customerReceipts[0].receiver,'HTTP recipient');assert.equal(receiptOrder.paid,0);}
 view=await request('finance','/api/wholesale');assert.equal(view.body.dashboard.netAmount,0);order=view.body.orders[0];assert.equal((await request('finance','/api/wholesale',{action:'consignmentSettle',orderId:order.id,version:order.version,itemId:order.items[0].id,kind:'sale',qty:5,businessDate:day,reference:'CUSTOMER-SALE-001',note:'核对客户实际已售数量'})).status,200);view=await request('finance','/api/wholesale');assert.equal(view.body.dashboard.netAmount,500000);assert.equal(view.body.orders[0].paymentStatus,'未回款');const excel=await fetch(origin+'/api/wholesale/export?mode=all&month='+day.slice(0,7)+'&lang=id',{headers:{cookie:cookies.finance}});assert.equal(excel.status,200);assert.ok((await excel.arrayBuffer()).byteLength>5000);
 const outboundResponse=await fetch(origin+'/api/wholesale/export?mode=outbound&month='+day.slice(0,7),{headers:{cookie:cookies.finance}});assert.equal(outboundResponse.status,200);const outboundBook=XLSX.read(await outboundResponse.arrayBuffer(),{type:'array'}),outboundRows=XLSX.utils.sheet_to_json(outboundBook.Sheets[outboundBook.SheetNames[0]],{header:1});assert.equal(outboundRows[2][8],5);assert.equal(outboundRows[2][1],day);assert.equal(outboundRows[2][17],'寄售');
 // Finance evidence uses real multipart storage and a role-scoped download endpoint.
 const paymentUpload=async(who,entryId='',requestOrigin=origin)=>{const form=new FormData();form.set('orderId',order.id);form.set('purpose','finance');if(entryId)form.set('entryId',entryId);form.set('file',new File(['%PDF-1.7\nPayment evidence'],'receipt-private.pdf',{type:'application/pdf'}));return fetch(origin+'/api/wholesale/files?lang=id',{method:'POST',headers:{origin:requestOrigin,...(who?{cookie:cookies[who]}:{})},body:form});};
 assert.equal((await paymentUpload(null)).status,401);assert.equal((await paymentUpload('finance','','https://attacker.test')).status,403);
 for(const who of ['sales','supply'])assert.equal((await paymentUpload(who)).status,403);
 const financeUpload=await paymentUpload('finance');assert.equal(financeUpload.status,200,await financeUpload.clone().text());const paymentFile=await financeUpload.json();
 for(const who of ['finance','admin']){const download=await fetch(origin+'/api/wholesale/files?id='+paymentFile.id,{headers:{cookie:cookies[who]}});assert.equal(download.status,200);assert.equal(download.headers.get('content-type'),'application/pdf');assert.equal(download.headers.get('cache-control'),'private, no-store');assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.match(await download.text(),/%PDF-1.7/);}
 for(const who of ['sales','supply']){assert.equal((await request(who,'/api/wholesale/files?id='+paymentFile.id)).status,403);const own=await request(who,'/api/wholesale');assert.ok(!JSON.stringify(own.body).includes('receipt-private.pdf'));assert.ok(!JSON.stringify(own.body).includes(paymentFile.id));}
 view=await request('finance','/api/wholesale');order=view.body.orders[0];assert.equal(order.paid,0);assert.equal(order.financeFiles[0].id,paymentFile.id);
 const paid=await request('finance','/api/wholesale',{action:'financeAdd',orderId:order.id,version:order.version,kind:'receipt',amount:100000,businessDate:day,reference:'HTTP-PAYMENT-001',note:'Verified actual bank credit',proofIds:[paymentFile.id]});assert.equal(paid.status,200,JSON.stringify(paid.body));
 view=await request('finance','/api/wholesale');order=view.body.orders[0];assert.equal(order.paid,100000);const financeEntry=order.entries.find(e=>e.reference==='HTTP-PAYMENT-001');assert.equal(order.financeFiles[0].finance_entry_id,financeEntry.id);
 assert.equal((await paymentUpload('finance',financeEntry.id)).status,200);view=await request('finance','/api/wholesale');assert.equal(view.body.orders[0].paid,100000);assert.equal(view.body.orders[0].financeFiles.length,2);
 const foreignOrigin=await fetch(origin+'/api/wholesale',{method:'POST',headers:{origin:'https://attacker.test',cookie:cookies.admin,'content-type':'application/json'},body:'{}'});assert.equal(foreignOrigin.status,403);
 }finally{const done=once(child,'exit');child.kill('SIGTERM');await done;rmSync(root,{recursive:true,force:true})}
});
