import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {mutateCreator,readCreators,creatorWorkspaceTasks} from '../lib/creators.mjs';
import {mapIntakeRow,normalizeIntake,collaborationStage} from '../lib/creator-intake-model.mjs';
import {creatorMetrics} from '../lib/creator-model.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBackup,restoreBackup} from '../server/backup.mjs';
import {openDatabase,fileBucket} from '../server/storage.mjs';

const proof='https://evidence.example.test/source',now=()=>new Date().toISOString(),future=()=>new Date(Date.now()+86400000).toISOString(),ago=()=>new Date(Date.now()-3600000).toISOString();
async function setup(){
 const f=fixture();f.users.bd={id:'bd-1',name:'BD测试',role:'达人BD'};f.users.other={id:'bd-2',name:'其他BD',role:'达人BD'};
 for(const u of [f.users.bd,f.users.other])f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u.id,u.id+'@example.test',u.name,u.role,now(),now());
 f.act=(a,action,p={})=>mutateCreator(f.db,a,{action,...p});
 f.scope=(await f.act(f.users.admin,'scope',{site:'印尼',platform:'TikTok',shop:'TEST',operatorId:f.users.indonesia.id,bdId:f.users.bd.id})).id;
 f.row=(extra={})=>({scopeId:f.scope,submittedOn:now().slice(0,10),platformId:'@Sample.Creator',profileUrl:'https://www.tiktok.com/@sample.creator',kind:'video',requestKind:'sample',reason:'已合作，申请新款样品以核对潜力',orders:12,gmv:'120000',currency:'IDR',styles:['真人出镜+产品展示，不口播'],...extra});
 f.submit=async extra=>{await f.act(f.users.indonesia,'intakeSubmit',{rows:[f.row(extra)]});return f.sqlite.prepare('SELECT * FROM creator_submissions ORDER BY created_at DESC LIMIT 1').get();};
 f.review=(row,extra={})=>f.act(f.users.bd,'intakeReview',{submissionId:row.id,version:row.version,decision:'accepted',nextAt:future(),nextAction:'核实意向后发起合作审批',note:'明确资源需求，待审批实际条件',name:'演示达人',contact:'test@example.test',language:'印尼语',fit:'箱包受众',evidence:proof,kind:'video',...extra});
 f.profile=id=>f.sqlite.prepare('SELECT * FROM creator_profiles WHERE id=?').get(id);
 f.change=(a,id,action,p={})=>f.act(a,action,{creatorId:id,version:p.roundId?f.sqlite.prepare('SELECT version FROM creator_rounds WHERE id=?').get(p.roundId).version:f.profile(id).version,...p});
 f.follow={nextOwner:f.users.indonesia.id,nextAt:future(),nextAction:'核实合作排期'};
 return f;
}

test('new and legacy import headers retain missing values, comma styles and explicit money currency',()=>{
 const row=mapIntakeRow({'创建日期':'2026-11-03','月份':'2026-11','国家':'印尼','达人id':' @TEST ','TK主页链接':proof,'近30天GMV（元）':'120000','视频风格/视频类型评估（多选，逗号分隔）':'真人出镜+产品展示，不口播,会自己根据产品创作','运营评估等级':'S-重点潜力'},{scopeId:'scope'});
 assert.throws(()=>normalizeIntake(row,'2026-11-04'),/原币种/);
 const normalized=normalizeIntake({...row,currency:'IDR'},'2026-11-04');assert.equal(normalized.platformId,'test');assert.equal(normalized.orders,null);assert.equal(normalized.gmvMinor,12000000);assert.equal(normalized.styles.length,2);assert.equal(normalized.grade,'S');
 assert.throws(()=>normalizeIntake({...row,currency:'IDR',month:'2026-10'},'2026-11-04'),/月份/);assert.throws(()=>normalizeIntake({...row,currency:'IDR',submittedOn:'2026-02-30'},'2026-11-04'),/日期/);
 assert.throws(()=>normalizeIntake({...row,currency:'IDR',profileUrl:'javascript:alert(1)'},'2026-11-04'),/网页/);
 assert.equal(normalizeIntake({...row,currency:'IDR',orders:0},'2026-11-04').orders,0);
});

test('operator-owned first cooperation enters the mature reply cohort without a fake BD acceptance',()=>{
 const profiles=[{id:'one',site:'印尼',platform:'TikTok',platform_id:'same',first_reply_at:'2026-10-01T00:00:00Z'},{id:'two',site:'泰国',platform:'TikTok',platform_id:'same',first_reply_at:'2026-10-29T00:00:00Z'}];
 const rounds=[{id:'r',creator_id:'one',status:'approved',approved_at:'2026-10-04T00:00:00Z',effective_due_at:'2026-11-15T00:00:00Z'}];
 const metrics=creatorMetrics(profiles,rounds,[],[],new Date('2026-11-01T00:00:00Z'));assert.equal(metrics.first14.value,1);assert.equal(metrics.first14.denominator,1);assert.equal(metrics.acceptedImmature,1);assert.equal(metrics.people,1);
 assert.equal(creatorMetrics(profiles,[{...rounds[0],status:'cancelled'}],[],[],new Date('2026-11-01T00:00:00Z')).first14.value,0);
});

test('preview is read-only; exact renamed imports and repeated rows never duplicate requests or financials',async()=>{
 const f=await setup(),input={rows:[f.row(),f.row()]};let r=await f.act(f.users.indonesia,'intakePreview',input);assert.deepEqual(r.rows.map(x=>x.status),['ready','duplicate']);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_submissions').get().n,0);
 r=await f.act(f.users.indonesia,'intakeSubmit',input);assert.equal(r.created,1);assert.equal(r.duplicates,1);
 r=await f.act(f.users.indonesia,'intakeSubmit',{rows:[f.row({platformId:'sample.creator'})]});assert.equal(r.created,0);assert.equal(r.duplicates,1);
 for(const table of ['creator_profiles','creator_finance','sales_records','inventory_movements'])assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_submission_history').get().n,1);
});

test('bulk submission is atomic and scopes cannot be forged through a country column or an account label',async()=>{
 const f=await setup();const preview=await f.act(f.users.indonesia,'intakePreview',{rows:[f.row(),f.row({site:'泰国',platformId:'bad'})]});assert.equal(preview.rows[1].status,'error');
 await assert.rejects(()=>f.act(f.users.indonesia,'intakeSubmit',{rows:[f.row(),f.row({scopeId:'hidden'})]}),/权限/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_submissions').get().n,0);
 await assert.rejects(()=>f.act(f.users.finance,'intakeSubmit',{rows:[f.row()]}),/仅运营/);
 await f.act(f.users.indonesia,'intakeSubmit',{rows:[f.row({submitterId:f.users.malaysia.id})],sourceUserId:f.users.malaysia.id});
 const row=f.sqlite.prepare('SELECT * FROM creator_submissions').get();assert.equal(row.submitter_id,f.users.indonesia.id);assert.equal((await readCreators(f.db,f.users.other)).submissions.length,0);assert.equal((await readCreators(f.db,f.users.finance)).submissions.length,1);
 await assert.rejects(()=>f.act(f.users.other,'intakeReview',{submissionId:row.id,version:1}),/权限/);
});

test('return, revision, queue and acceptance retain immutable history and do not fabricate profile fields',async()=>{
 const f=await setup(),row=await f.submit();await assert.rejects(()=>f.review(row,{contact:'',language:''}),/联系方式/);
 await f.review(row,{decision:'returned'});await assert.rejects(()=>f.review(row),/已更新/);
 let latest=f.sqlite.prepare('SELECT * FROM creator_submissions').get();
 await assert.rejects(()=>f.act(f.users.indonesia,'intakeRevise',{submissionId:row.id,version:latest.version,data:f.row({platformId:'different'}),note:'修改'}),/不能改变/);
 await f.act(f.users.indonesia,'intakeRevise',{submissionId:row.id,version:latest.version,data:f.row({contact:'creator@example.test',language:'印尼语',name:'已补齐达人',evidence:proof}),note:'补齐真实联系方式'});
 latest=f.sqlite.prepare('SELECT * FROM creator_submissions').get();await f.review(latest,{decision:'queued'});latest=f.sqlite.prepare('SELECT * FROM creator_submissions').get();await f.review(latest);
 const out=await readCreators(f.db,f.users.admin);assert.equal(out.profiles.length,1);assert.equal(out.profiles[0].state,'candidate');assert.equal(out.profiles[0].first_reply_at,null);assert.equal(out.profiles[0].accepted_at,null);assert.equal(out.profiles[0].source_user_id,f.users.indonesia.id);assert.equal(out.submissionHistory.length,5);assert.equal(out.metrics.verifiedProfitCny,null);assert.equal(out.profiles[0].tier,'trial');
 assert.throws(()=>f.sqlite.prepare('DELETE FROM creator_submission_history').run(),/immutable/);
 assert.ok((await creatorWorkspaceTasks(f.db,f.users.bd)).some(t=>t.entity==='submission:'+row.id));
});

test('different resource requests share the same profile, preserve original operator and do not overwrite contacts',async()=>{
 const f=await setup(),first=await f.submit();await f.review(first);const original=(await readCreators(f.db,f.users.admin)).profiles[0];
 const second=await f.submit({requestKind:'paid',reason:'商谈下一轮付费合作',contact:'new-wrong-contact'});await f.review(second,{name:'覆盖尝试',contact:'wrong',evidence:proof});
 const out=await readCreators(f.db,f.users.admin);assert.equal(out.profiles.length,1);assert.equal(out.submissions.length,2);assert.equal(out.submissions.every(r=>r.creator_id===original.id),true);assert.equal(out.profiles[0].data.contact,'test@example.test');assert.equal(out.profiles[0].name,'演示达人');
});

test('operator proposal follows reply, independent approval, real dispatch and content; accepted request links once',async()=>{
 const f=await setup(),row=await f.submit();await f.review(row);const id=(await readCreators(f.db,f.users.admin)).profiles[0].id;
 const proposal={submissionId:row.id,items:[{sku:'BAG-A',sampleQty:1}],videos:1,lives:0,currency:'CNY',budget:30,commission:'佣金待双方批准协议执行',requirements:'视频展示容量',rights:'未授予二次投流权限',stockCheck:'核对真实仓库库存',zone:'Asia/Jakarta',dueAt:future(),evidence:proof};
 await assert.rejects(()=>f.change(f.users.indonesia,id,'round',proposal),/明确合作回复/);
 await f.change(f.users.indonesia,id,'contact',{at:ago(),note:'收到意向前联系',evidence:proof,...f.follow});await f.change(f.users.indonesia,id,'reply',{at:now(),note:'已同意洽谈条件',evidence:proof,...f.follow});
 await f.change(f.users.indonesia,id,'round',proposal);const round=f.sqlite.prepare('SELECT * FROM creator_rounds').get();assert.equal(round.status,'pending');assert.equal(round.author_id,f.users.indonesia.id);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'round',proposal),/已关联合作/);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'approve',{roundId:round.id,note:'自行批准'}),/岗位/);
 await f.change(f.users.admin,id,'approve',{roundId:round.id,note:'条件核对后批准'});
 await f.change(f.users.indonesia,id,'dispatch',{roundId:round.id,qty:1,at:now(),warehouseRef:'TEST-OUT-001',carrier:'TEST',tracking:'TEST-TRACK',evidence:proof});
 await f.change(f.users.indonesia,id,'receipt',{roundId:round.id,at:now(),evidence:proof});
 await f.change(f.users.indonesia,id,'content',{roundId:round.id,kind:'video',sku:'BAG-A',url:'https://video.example.test/001',at:now(),linkValid:true,skuCorrect:true,accurate:true,agreed:true,note:'验收完成',evidence:proof});
 await f.change(f.users.indonesia,id,'complete',{roundId:round.id,note:'复盘后提请BD维护',evidence:proof,...f.follow});
 await f.change(f.users.indonesia,id,'handoff',{sku:'BAG-A',fit:'匹配场景',intent:'希望继续合作',proposal:'下一轮一个视频',quote:'佣金方式',openIssues:'无',at:now(),evidence:proof,...f.follow});
 await f.change(f.users.bd,id,'accept',{note:'接收深度维护',...f.follow,nextOwner:f.users.bd.id});
 const out=await readCreators(f.db,f.users.admin);assert.equal(out.submissions[0].linkedRound.status,'completed');assert.equal(collaborationStage(out.profiles[0],out.rounds),'深度维护');assert.equal(out.profiles[0].source_user_id,f.users.indonesia.id);assert.equal(out.metrics.verifiedProfitCny,null);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM inventory_movements').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_records').get().n,0);
});

test('reassignment routes pending submissions to the new BD without changing the originating operator',async()=>{
 const f=await setup(),row=await f.submit(),scope=f.sqlite.prepare('SELECT * FROM creator_scopes').get();
 await f.act(f.users.admin,'scope',{version:scope.version,site:scope.site,platform:scope.platform,shop:scope.shop,operatorId:f.users.malaysia.id,bdId:f.users.other.id});
 await assert.rejects(()=>f.review(row),/权限/);const out=await readCreators(f.db,f.users.other);assert.equal(out.submissions[0].submitter_id,f.users.indonesia.id);assert.ok(out.users.some(u=>u.id===f.users.indonesia.id));assert.ok(out.tasks.some(t=>t.submissionId===row.id));
});

test('maintenance and concurrent scope changes prevent partial submissions',async()=>{
 const f=await setup();const original=f.db.batch;f.db.batch=async statements=>{f.sqlite.prepare("UPDATE creator_scopes SET bd_id=? WHERE id=?").run(f.users.other.id,f.scope);return original(statements);};
 await assert.rejects(()=>f.submit(),/已变化|已更新/);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_submissions').get().n,0);f.db.batch=original;
 f.sqlite.prepare("INSERT INTO system_maintenance(id,mode,expires_at,updated_at) VALUES('global','backup',?,?)").run(future(),now());await assert.rejects(()=>f.submit(),/备份|维护/);
});

test('new intake and immutable revisions survive the release backup/restore format',async()=>{
 const f=await setup(),row=await f.submit();await f.review(row,{decision:'queued'});const root=mkdtempSync(join(tmpdir(),'lj-intake-'));
 try{await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},join(root,'test.tar'));await restoreBackup(join(root,'test.tar'),join(root,'restored'));const restored=openDatabase(join(root,'restored/business.sqlite'));for(const name of ['creator_submissions','creator_submission_history'])assert.deepEqual(restored.sqlite.prepare(`SELECT * FROM ${name} ORDER BY id`).all(),f.sqlite.prepare(`SELECT * FROM ${name} ORDER BY id`).all());restored.sqlite.close();}finally{rmSync(root,{recursive:true,force:true});}
});
