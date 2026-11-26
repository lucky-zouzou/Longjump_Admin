// Adds only synthetic Feishu facts to the existing isolated workplace preview.
// Never imports env.mjs, opens credential files, calls a provider, or accepts a database path.
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../server/storage.mjs';
import {getFeishuSettings,saveFeishuSettings,recordFeishuConnectionCheck,saveFeishuUserLink,claimFeishuSyncRun,completeFeishuWindow,finishFeishuSyncRun,readFeishuAttendance} from '../lib/feishu-store.mjs';

const repository=fileURLToPath(new URL('../',import.meta.url)),root=resolve(repository,'work/workplace-entry-preview'),target=root+'/business.sqlite',origin='http://127.0.0.1:57339';
if(process.env.LOONGJUMP_WORKPLACE_PREVIEW!=='1'||resolve(process.cwd())!==resolve(repository))throw Error('Run from this repository with LOONGJUMP_WORKPLACE_PREVIEW=1; this script supports only the existing isolated TEST preview.');
if(process.env.LOONGJUMP_DATA_DIR&&resolve(process.env.LOONGJUMP_DATA_DIR)!==root)throw Error('A different data directory is not permitted.');
if(!existsSync(target)||realpathSync(root)!==root||realpathSync(target)!==target)throw Error('Create the original workplace TEST fixture first; symlink targets are refused.');
if(!existsSync(root+'/preview.json')||realpathSync(root+'/preview.json')!==root+'/preview.json')throw Error('The TEST preview metadata must be a regular local file.');
const metadata=JSON.parse(readFileSync(root+'/preview.json','utf8'));
if(metadata.testOnly!==true||metadata.origin!==origin||metadata.roles?.admin!=='admin-1'||metadata.roles?.operator!=='id-ops')throw Error('Not the expected TEST workplace preview metadata.');

// Validate through a read-only connection before migrations or any mutation can run.
const inspection=new DatabaseSync(target,{readOnly:true});
const appId='cli_TEST_ONLY_WORKPLACE_PREVIEW',externalUserId='TEST-ONLY-ID-OPS',identity={appId,configSource:'test-only:workplace-preview-v1'};
try{
 if(!inspection.prepare("SELECT id FROM workplace_preview_marker WHERE id='TEST-ONLY-WORKPLACE-ENTRY-v1'").get())throw Error('Missing TEST-ONLY preview sentinel.');
 if(inspection.prepare("SELECT COUNT(*) n FROM users WHERE name NOT LIKE 'TEST-ONLY %' OR email NOT LIKE '%@example.test'").get().n)throw Error('All fixture accounts must be synthetic TEST-ONLY example.test accounts.');
 for(const [id,role] of [['admin-1','管理员'],['id-ops','运营']])if(!inspection.prepare('SELECT id FROM users WHERE id=? AND role=? AND active=1').get(id,role))throw Error('Required TEST preview actor is missing.');
 if(!inspection.prepare("SELECT p.user_id FROM workplace_profiles p JOIN workplace_units u ON u.id=p.unit_id WHERE p.user_id='id-ops' AND p.unit_id='ID' AND p.active=1 AND u.active=1 AND u.timezone='Asia/Jakarta'").get())throw Error('The synthetic operator must retain the fixture Indonesia organization.');
 if(inspection.prepare("SELECT name FROM sqlite_master WHERE name='feishu_settings'").get()){
  const configured=inspection.prepare("SELECT app_id FROM feishu_settings WHERE id='global'").get();
  if(configured?.app_id&&configured.app_id!==appId)throw Error('The preview has another Feishu setup; it will not be overwritten.');
  if(inspection.prepare('SELECT COUNT(*) n FROM feishu_user_links WHERE app_id<>? OR user_id<>? OR external_user_id<>? OR unit_id<>?').get(appId,'id-ops',externalUserId,'ID').n)throw Error('The preview has non-matching Feishu mappings; they will not be overwritten.');
 }
}finally{inspection.close();}

globalThis.fetch=()=>{throw Error('Network is disabled in the TEST-ONLY Feishu fixture.');};
const db=openDatabase(target),sqlite=db.sqlite;
try{
 const admin=sqlite.prepare("SELECT id,name,role,site FROM users WHERE id='admin-1'").get(),operator=sqlite.prepare("SELECT id,name,role,site FROM users WHERE id='id-ops'").get();
 let settings=await getFeishuSettings(db);
 if(!settings.appId){await saveFeishuSettings(db,admin,{version:settings.version,enabled:false,appId,idType:'employee_id',reason:'TEST-ONLY synthetic preview setup, not a real Feishu connection'});settings=await getFeishuSettings(db);}
 // This is an explicit local test attestation. It does not test or use an actual app secret.
 await recordFeishuConnectionCheck(db,{version:settings.version,...identity,ok:true});
 let link=sqlite.prepare('SELECT * FROM feishu_user_links WHERE app_id=? AND user_id=? AND external_user_id=? AND unit_id=?').get(appId,'id-ops',externalUserId,'ID');
 if(!link||!link.active){await saveFeishuUserLink(db,admin,{...(link?{id:link.id,version:link.version}:{}),userId:'id-ops',externalUserId,unitId:'ID',idType:'employee_id',active:true,reason:'TEST-ONLY synthetic employee identity, not an actual Feishu employee'});link=sqlite.prepare('SELECT * FROM feishu_user_links WHERE app_id=? AND user_id=? AND active=1').get(appId,'id-ops');}
 if(!settings.enabled){await saveFeishuSettings(db,admin,{version:settings.version,enabled:true,reason:'TEST-ONLY activate synthetic UI preview only'},identity);settings=await getFeishuSettings(db);}
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jakarta'}).format(new Date()),stamp=minute=>`${date}T${minute}:00+07:00`;
 const facts={attendance:[
  {sourceId:'TEST-ONLY-PUNCH-MORNING-'+date,externalUserId,workDate:date,status:'recorded',punchedAt:stamp('09:00')},
  {sourceId:'TEST-ONLY-PUNCH-EVENING-'+date,externalUserId,workDate:date,status:'recorded',punchedAt:stamp('18:00'),weakIdentity:true}
 ],leave:[
  {sourceId:'TEST-ONLY-LEAVE-APPROVED-'+date,externalUserId,workDate:date,status:'approved',startAt:stamp('10:00'),endAt:stamp('12:00')},
  {sourceId:'TEST-ONLY-LEAVE-REVOKED-'+date,externalUserId,workDate:date,status:'revoked',startAt:stamp('14:00'),endAt:stamp('16:00')}
 ]};
 const run=await claimFeishuSyncRun(db,{settingsVersion:settings.version,...identity,trigger:'manual',actorId:admin.id});
 for(const kind of ['attendance','leave'])await completeFeishuWindow(db,{...run,linkId:link.id,linkVersion:link.version,kind,from:date,to:date,complete:true,records:facts[kind]});
 await finishFeishuSyncRun(db,{...run,success:true});
 const view=await readFeishuAttendance(db,operator,{month:date.slice(0,7)}),todayRecords=view.records.filter(row=>row.workDate===date);
 if(!view.isManaged||todayRecords.length!==4||todayRecords.filter(r=>r.kind==='attendance').length!==2||!todayRecords.some(r=>r.status==='approved')||!todayRecords.some(r=>r.status==='revoked'))throw Error('Synthetic Feishu preview did not verify.');
 if(sqlite.prepare('PRAGMA foreign_key_check').all().length)throw Error('TEST preview foreign-key verification failed.');
 writeFileSync(root+'/feishu-preview.json',JSON.stringify({testOnly:true,createdAt:new Date().toISOString(),date,appId,employee:'id-ops',note:'Synthetic connection attestation and facts only; no credentials, network or real Feishu connection.',records:4,admin:origin+'/__preview/admin',operator:origin+'/__preview/operator',leave:origin+'/__preview/operator?view=leave'},null,2),{mode:0o600});
 console.log('TEST-ONLY Feishu preview ready: two punch events, one approved leave daily row and one revoked leave daily row.');
 console.log('Admin: '+origin+'/__preview/admin');console.log('Mapped operator: '+origin+'/__preview/operator');console.log('Leave entry: '+origin+'/__preview/operator?view=leave');
 console.log('No actual Feishu credentials or network calls were used.');
}finally{sqlite.close();}
