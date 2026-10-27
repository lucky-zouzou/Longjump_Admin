// Optional local-only visual acceptance fixture. Never connects to an existing database.
import {mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {costFixture,importRows,ticketRows,review,seedSale,orderPayload} from '../tests/cost-fixture.mjs';
import {mutateCost} from '../lib/cost-profit.mjs';
import {costTicketSchema} from '../lib/cost-import-schema.mjs';
import {releaseMigrations} from '../lib/backup-version.mjs';
const root=resolve('work/cost-preview'),target=join(root,'business.sqlite');
if(existsSync(target))throw Error('Preview database already exists; use the existing isolated preview. No overwrite performed.');
mkdirSync(root,{recursive:true});const f=costFixture();
f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('local-admin','admin@loongjump.local','本地管理员','管理员','2026-10-26','2026-10-26');
let r=await importRows(f);await review(f,r.ids[0]);seedSale(f);await mutateCost(f.db,f.users.finance,orderPayload());r=await importRows(f,ticketRows({revision:1,seaAmount:450,reason:'TEST-ONLY-海运补充费用'}));await review(f,r.ids[0]);
await mutateCost(f.db,f.users.admin,{action:'simulation',businessKey:'TEST-ONLY-定价快照',revision:0,site:'印尼',channel:'TikTok',businessDate:'2026-10-20',reason:'TEST-ONLY-模拟',ticketKey:'SHIP-TEST',lineKey:'A',price:40,discount:2,commission:0.1,advertising:3,warehouse:2});
f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const m of releaseMigrations)f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(m.name,m.sha256,new Date().toISOString());
f.sqlite.exec("VACUUM INTO '"+target.replaceAll("'","''")+"'");f.sqlite.close();console.log('Isolated TEST-ONLY preview prepared at '+root);

for(const [name,input] of [['valid',ticketRows({businessKey:'UI-IMPORT'})],['invalid',ticketRows({businessKey:'UI-ERROR'}).map((r,i)=>i?{...r,sku:'UNKNOWN'}:r)]]){const data=[costTicketSchema.columns.map(c=>c.label),...input.map(r=>costTicketSchema.columns.map(c=>r[c.key]??''))];writeFileSync(join(root,name+'.csv'),'\ufeff'+data.map(row=>row.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n'));}
