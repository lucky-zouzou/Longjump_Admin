// Explicit isolated synthetic fixture; never opens production storage or credentials.
import {marketingSamplesFixture} from '../tests/marketing-samples-fixture.mjs';
import {configurePilot,runPilot,pilotDay,pilotWeek} from '../lib/agent-pilot.mjs';
import {releaseMigrations} from '../lib/backup-version.mjs';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve('work/agent-pilot-preview'),target=root+'/business.sqlite';
if(existsSync(target))throw Error('Existing TEST fixture retained; no overwrite');
mkdirSync(root,{recursive:true,mode:0o700});
const f=marketingSamplesFixture(),now=new Date(),stamp=now.toISOString(),today=pilotDay(now);
const shift=n=>new Date(Date.parse(today+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
try{
 for(const u of f.sqlite.prepare('SELECT id,role FROM users').all()){
  const name='TEST-ONLY '+u.role+' '+u.id;f.sqlite.prepare('UPDATE users SET name=?,email=? WHERE id=?').run(name,u.id+'@example.test',u.id);
  const actor=Object.values(f.users).find(a=>a.id===u.id);if(actor)actor.name=name;
 }
 f.sqlite.prepare("UPDATE creator_scopes SET shop='TEST-ONLY 雅加达试点店' WHERE id='sample-scope'").run();
 const order=(await f.create()).id;await f.approve(order);await f.assign(order);await f.ship(order);
 await f.change(f.users.bd,order,'receipt',{shipmentId:f.shipment(order).id,receivedAt:new Date().toISOString(),receiver:'TEST',proofRef:'TEST-SIGNED'});
 f.sqlite.prepare("UPDATE creator_rounds SET original_due_at=?,effective_due_at=? WHERE id='sample-round'").run(shift(-2)+'T10:00:00+07:00',shift(-2)+'T10:00:00+07:00');
 f.sqlite.prepare("UPDATE inventory_balances SET qty=30,reserved_qty=0,updated_at=? WHERE sku='BAG-A' AND site='印尼' AND channel='TikTok'").run(stamp);
 for(let n=14;n>=1;n--){const date=shift(-n),id='TEST-DAY-'+date;
  f.sqlite.prepare("INSERT INTO sales_imports(id,import_key,business_date,site,channel,file_name,row_count,total_qty,actor_id,created_at,report_kind) VALUES(?,?,?,'印尼','TikTok','TEST-ONLY.csv',1,10,?,?,'complete')").run(id,id,date,f.users.indonesia.id,stamp);
  f.sqlite.prepare("INSERT INTO sales_records(id,import_id,business_date,site,channel,sku,qty,actor_id,created_at) VALUES(?,?,?,'印尼','TikTok','BAG-A',10,?,?)").run(id,id,date,f.users.indonesia.id,stamp);
  f.sqlite.prepare("INSERT INTO sales_ad_spend(id,site,channel,business_date,currency,amount,note,actor_id,updated_at) VALUES(?,'印尼','TikTok',?,'IDR',?,'TEST-ONLY actual spend',?,?)").run(id,date,n===1?160000:100000,f.users.indonesia.id,stamp);
 }
 await configurePilot(f.db,f.users.admin,{version:1,creatorScopeId:'sample-scope',supplyOwnerId:f.users.supply.id,prioritySkus:['BAG-A'],dailyTime:'10:00',enabled:true,scopeVerified:true,exclusiveConfirmed:true,reason:'TEST-ONLY 合成单店，不代表生产数据'},now);
 await runPilot(f.db,{now:new Date(),saveWeekly:true});
 f.sqlite.exec('CREATE TABLE agent_preview_marker(id TEXT PRIMARY KEY,created_at TEXT NOT NULL)');f.sqlite.prepare('INSERT INTO agent_preview_marker VALUES(?,?)').run('TEST-ONLY-AGENT-v1',stamp);
 f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const m of releaseMigrations)f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(m.name,m.sha256,stamp);
 f.sqlite.exec("VACUUM INTO '"+target.replaceAll("'","''")+"'");
 writeFileSync(root+'/preview.json',JSON.stringify({testOnly:true,origin:'http://127.0.0.1:57349',createdAt:stamp,week:pilotWeek(now),order},null,2),{mode:0o600});
 console.log('Synthetic Agent preview prepared');
}finally{f.sqlite.close();}
