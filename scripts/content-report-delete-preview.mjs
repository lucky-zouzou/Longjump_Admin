// Fixed, synthetic, local-only fixture. Never read or overwrite an existing database.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,readdirSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {contentFixture} from '../tests/content-center-fixture.mjs';
import {readCenterCompass,readPlatformReports} from '../lib/content-center.mjs';

const root=resolve('work/content-report-delete-preview'),target=root+'/business.sqlite';
if(existsSync(target))throw Error('Existing TEST ONLY fixture is retained, not overwritten');
mkdirSync(root,{recursive:true,mode:0o700});
globalThis.fetch=async()=>{throw Error('Outbound networking disabled in synthetic content report fixture');};
const f=contentFixture(),now=new Date().toISOString();
try{
 const end=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const month=end.slice(0,7),start=month+'-01',site='马来西亚';
 const peer={id:'my-preview-other',name:'TEST ONLY 马来同站运营（只读他人记录）',role:'运营',site,channel:'TikTok'};
 f.sqlite.prepare('INSERT INTO users(id,email,name,role,site,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(peer.id,'my-preview-other@example.test',peer.name,peer.role,peer.site,peer.channel,now,now);
 f.sqlite.prepare("UPDATE users SET name='TEST ONLY '||name WHERE id<>?").run(peer.id);
 f.sqlite.prepare('INSERT INTO finance_rates VALUES(?,?,?,?,?,?,?,?)')
  .run('test-preview-my-fx',month,'MYR',1,1.63,'TEST ONLY 合成演示汇率，非正式财务数据',f.users.admin.id,now);
 await f.act(f.users.malaysia,'importPlatformReport',{
  site,start,end,currency:'MYR',file:'TEST-ONLY-MY-TIKTOK.csv',rows:[
   {videoId:'987654321001',creatorName:'test_only_my_creator_a',views:5000,orders:10,attributedGmv:1.2,videoGmv:1.2},
   {videoId:'987654321002',creatorName:'test_only_my_creator_b',views:4948,orders:6,attributedGmv:0.8,videoGmv:0.8}
  ]
 });
 const summary=(await readCenterCompass(f.db,f.users.malaysia,'month','',Date.now())).reports.rows.find(r=>r.site===site);
 assert.deepEqual([summary.entries,summary.views,summary.orders,summary.gmvMinor],[2,9948,16,326]);
 const own=await readPlatformReports(f.db,f.users.malaysia,site,0,'month');
 const other=await readPlatformReports(f.db,peer,site,0,'month');
 assert.equal(own.rows.length,2);assert.ok(own.rows.every(r=>r.canDelete===true));
 assert.equal(other.rows.length,2);assert.ok(other.rows.every(r=>r.canDelete===false));
 await assert.rejects(readPlatformReports(f.db,f.users.indonesia,site,0,'month'),{status:403});
 f.sqlite.exec('CREATE TABLE IF NOT EXISTS local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');
 for(const name of readdirSync(resolve('drizzle')).filter(n=>n.endsWith('.sql')).sort())
  f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(name,createHash('sha256').update(readFileSync(resolve('drizzle',name))).digest('hex'),now);
 f.sqlite.exec("VACUUM INTO '"+target.replaceAll("'","''")+"'");chmodSync(target,0o600);
 writeFileSync(root+'/fixture.json',JSON.stringify({source:'SYNTHETIC_ONLY_CONTENT_REPORT_DELETE',createdAt:now,period:{start,end},
  expected:{entries:2,views:9948,orders:16,currency:'MYR',gmv:2,cnyPerMyr:1.63,gmvCny:3.26},
  actors:{my:f.users.malaysia.id,'my-other':peer.id,admin:f.users.admin.id,studio:f.camera.id,id:f.users.indonesia.id},
  videoIds:own.rows.map(r=>r.video_id)},null,2),{mode:0o600});
 console.log('TEST ONLY content report delete fixture created: 9,948 views / 16 orders / MYR 2 / CNY 3.26. Owner, peer and site permissions verified.');
}finally{f.sqlite.close();}
