// Disposable synthetic data only; never loads production data or credentials.
import {systemFixture,svc} from '../tests/system-fixture.mjs';
import {localDay,shiftDay,zeroSalesSites} from '../lib/promotion-model.mjs';
import {releaseMigrations} from '../lib/backup-version.mjs';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve('work/clearance-zero-preview'),target=root+'/business.sqlite';
if(existsSync(target))throw Error('Existing isolated fixture retained; no overwrite');
mkdirSync(root,{recursive:true});
const f=systemFixture(),stamp=new Date().toISOString();
const skus=[['BAG-A','演示 · 经典通勤托特包'],['BAG-B','演示 · 轻量云朵斜挎包'],['BAG-C','演示 · 复古翻盖单肩包'],['BAG-D','演示 · 简约旅行收纳包']];
for(const [sku,name] of skus)f.sqlite.prepare('INSERT INTO sku_settings(sku,name,updated_at) VALUES(?,?,?) ON CONFLICT(sku) DO UPDATE SET name=excluded.name').run(sku,name,stamp);
for(const [i,site] of zeroSalesSites.entries()){
 const today=localDay(new Date(),site),cutoff=shiftDay(today,-1);
 for(const [j,[sku]] of skus.entries()){
  f.stock(sku,30+j*14,40+j*9,site);
  if(sku!=='BAG-C')f.sqlite.prepare("INSERT INTO product_cost_versions(id,sku,site,version,total,currency,basis,effective_date,source_json,import_id,reason,actor_id,actor_name,created_at) VALUES(?,?,?,1,?,'CNY','landed',?,'{}','TEST-ONLY','合成演示成本','admin-1','演示管理员',?)").run(site==='印尼'&&sku==='BAG-A'?'TEST-ONLY-ZERO-COST-ID':crypto.randomUUID(),sku,site,(25+i+j)*10000,shiftDay(today,-40),stamp);
  if(sku==='BAG-A')for(const channel of ['TikTok','Shopee'])f.sqlite.prepare('INSERT INTO promotion_availability VALUES(?,?,?,?,?,?,?,?,?,?)').run(site,channel,sku,shiftDay(today,-40),shiftDay(today,-40),cutoff,'TEST-ONLY','合成连续有货凭据','admin-1',stamp);
 }
 for(const channel of ['TikTok','Shopee'])for(let n=1;n<=7;n++){
  const date=shiftDay(today,-n);if(site==='泰国'&&n===2||site==='印尼'&&channel==='TikTok'&&n===1)continue;
  const id=crypto.randomUUID();f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,?,?,0,0,'admin-1',?,'zero')").run(id,id,date,site,channel,stamp);
 }
}
const p=extra=>({site:'印尼',channel:'TikTok',businessDate:localDay(new Date(),'印尼'),sourceBatchRef:crypto.randomUUID(),importKey:crypto.randomUUID(),fileName:'TEST-ONLY演示日报.xlsx',rows:[{sku:'BAG-D',qty:3,amount:300000}],reportKind:'complete',fullDayConfirmed:true,...extra});
await svc.salesImport(f.users.indonesia,p({businessDate:shiftDay(localDay(new Date(),'印尼'),-1),rows:[{sku:'BAG-B',qty:2,amount:200000}]}));
await svc.salesImport(f.users.indonesia,p({}));
f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');
for(const m of releaseMigrations)f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(m.name,m.sha256,stamp);
f.sqlite.exec("VACUUM INTO '"+target.replaceAll("'","''")+"'");f.sqlite.close();
console.log('Isolated TEST-ONLY zero-sales preview created');
