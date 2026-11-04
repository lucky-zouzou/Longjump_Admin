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
import * as X from 'xlsx';
import {readIntakeWorkbook} from '../lib/creator-intake-workbook.mjs';
import {intakeHeaders} from '../lib/creator-intake-model.mjs';

const proof='https://evidence.example.test/source',now=()=>new Date().toISOString(),future=()=>new Date(Date.now()+86400000).toISOString(),ago=()=>new Date(Date.now()-3600000).toISOString();
async function setup(){
 const f=fixture();f.users.bd={id:'bd-1',name:'BD测试',role:'达人BD'};f.users.other={id:'bd-2',name:'其他BD',role:'达人BD'};
 for(const u of [f.users.bd,f.users.other])f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u.id,u.id+'@example.test',u.name,u.role,now(),now());
 f.act=(a,action,p={})=>mutateCreator(f.db,a,{action,...p});
 f.scope=(await f.act(f.users.admin,'scope',{site:'印尼',platform:'TikTok',shop:'TEST',operatorId:f.users.indonesia.id,bdId:f.users.bd.id})).id;
 f.row=(extra={})=>({scopeId:f.scope,qualified:true,contact:'test@example.test',name:'演示达人',submittedOn:now().slice(0,10),platformId:'@Sample.Creator',profileUrl:'https://www.tiktok.com/@sample.creator',kind:'video',requestKind:'sample',reason:'已合作，申请新款样品以核对潜力',orders:12,gmv:'120000',currency:'IDR',styles:['真人出镜+产品展示，不口播'],...extra});
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
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_profiles').get().n,1);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_dossiers').get().n,1);
 for(const table of ['creator_finance','sales_records','inventory_movements'])assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_submission_history').get().n,1);
});

test('16-column handover goes from Excel through preview, submission, dossier and revision without posting samples twice',async()=>{
 const f=await setup(),date=now().slice(0,10),book=X.utils.book_new();
 const sheet=X.utils.aoa_to_sheet([intakeHeaders,[new Date(date+'T00:00:00Z'),date.slice(0,7),'印尼','@test.handover',proof,'test@example.test','TEST-BAG × 2','视频','纯佣',1000,8,200000,900,'出单且勤快','A-优质','会自己根据产品创作']]);sheet.A2.z='m/d/yy';
 X.utils.book_append_sheet(book,sheet,'运营达人协同提交模板');
 const raw=readIntakeWorkbook(X,X.write(book,{type:'buffer',bookType:'xlsx'})).rows;
 const input={rows:raw.map(r=>mapIntakeRow(r,{scopeId:f.scope,qualified:true,currency:'IDR'}))};
 const preview=await f.act(f.users.indonesia,'intakePreview',input);assert.equal(preview.rows[0].status,'ready');assert.equal(preview.rows[0].data.submittedOn,date);assert.equal(preview.rows[0].data.sampledProducts,'TEST-BAG × 2');
 assert.equal((await f.act(f.users.indonesia,'intakeSubmit',input)).created,1);
 const retry=await f.act(f.users.indonesia,'intakeSubmit',input);assert.equal(retry.created,0);assert.equal(retry.duplicates,1);
 const data=await readCreators(f.db,f.users.indonesia),row=data.submissions[0];
 assert.equal(row.data.sampledProducts,'TEST-BAG × 2');assert.equal(row.creator_id,data.profiles[0].id);assert.ok(data.profiles[0].dossier_id);
 await f.act(f.users.indonesia,'intakeRevise',{submissionId:row.id,version:row.version,data:{...input.rows[0],sampledProducts:'TEST-BAG × 3'},note:'补正历史寄样记录'});
 const updated=await readCreators(f.db,f.users.indonesia);assert.equal(updated.submissions[0].data.sampledProducts,'TEST-BAG × 3');
 assert.equal(updated.submissionHistory.find(r=>r.revision===1).snapshot.data.sampledProducts,'TEST-BAG × 2');
 for(const table of ['creator_finance','sales_records','inventory_movements'])assert.equal(f.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,0,table);
});

test('missing shop has an actionable error and refreshing assignment enables only that operator scope',async()=>{
 const f=await setup();assert.equal((await readCreators(f.db,f.users.malaysia)).scopes.length,0);
 const missing=await f.act(f.users.malaysia,'intakePreview',{rows:[f.row({scopeId:''})]});assert.match(missing.rows[0].message,/配置店铺与负责人/);
 await assert.rejects(()=>f.act(f.users.malaysia,'intakeSubmit',{rows:[f.row()]}),/权限/);
 await f.act(f.users.admin,'scope',{id:f.scope,version:1,site:'印尼',platform:'TikTok',shop:'TEST',operatorId:f.users.indonesia.id,backupId:f.users.malaysia.id,bdId:f.users.bd.id});
 assert.equal((await readCreators(f.db,f.users.malaysia)).scopes.length,1);
 assert.equal((await f.act(f.users.malaysia,'intakeSubmit',{rows:[f.row()]})).created,1);
 const row=f.sqlite.prepare('SELECT * FROM creator_submissions').get();assert.equal(row.submitter_id,f.users.malaysia.id);
});

test('template placeholder cannot create a fake creator and a mixed invalid batch stays unsubmitted',async()=>{
 const f=await setup(),example=f.row({platformId:'@creator.id',contact:'WhatsApp: +62...',profileUrl:'https://www.tiktok.com/@creator.id'});
 const preview=await f.act(f.users.indonesia,'intakePreview',{rows:[f.row(),example]});
 assert.equal(preview.rows[0].status,'ready');assert.equal(preview.rows[1].status,'error');assert.match(preview.rows[1].message,/模板示例/);
 await assert.rejects(()=>f.act(f.users.indonesia,'intakeSubmit',{rows:[f.row(),example]}),/模板示例/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_submissions').get().n,0);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_profiles').get().n,0);
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
 const f=await setup(),row=await f.submit();assert.equal(f.profile(row.creator_id).state,'handoff');
 await f.review(row,{decision:'returned'});await assert.rejects(()=>f.review(row),/已更新/);
 let latest=f.sqlite.prepare('SELECT * FROM creator_submissions').get();
 await assert.rejects(()=>f.act(f.users.indonesia,'intakeRevise',{submissionId:row.id,version:latest.version,data:f.row({platformId:'different'}),note:'修改'}),/不能改变/);
 await f.act(f.users.indonesia,'intakeRevise',{submissionId:row.id,version:latest.version,data:f.row({contact:'creator@example.test',language:'印尼语',name:'已补齐达人',evidence:proof}),note:'补齐真实联系方式'});
 latest=f.sqlite.prepare('SELECT * FROM creator_submissions').get();await f.review(latest,{decision:'queued'});latest=f.sqlite.prepare('SELECT * FROM creator_submissions').get();await f.review(latest);
 const out=await readCreators(f.db,f.users.admin);assert.equal(out.profiles.length,1);assert.equal(out.profiles[0].state,'negotiating');assert.equal(out.profiles[0].first_reply_at,null);assert.ok(out.profiles[0].accepted_at);assert.equal(out.profiles[0].source_user_id,f.users.indonesia.id);assert.equal(out.submissionHistory.length,5);assert.equal(out.metrics.verifiedProfitCny,null);assert.equal(out.profiles[0].tier,'trial');
 assert.throws(()=>f.sqlite.prepare('DELETE FROM creator_submission_history').run(),/immutable/);
 assert.ok((await creatorWorkspaceTasks(f.db,f.users.bd)).some(t=>t.entity===row.creator_id));
});

test('different resource requests share the same profile, preserve original operator and do not overwrite contacts',async()=>{
 const f=await setup(),first=await f.submit();await f.review(first);const original=(await readCreators(f.db,f.users.admin)).profiles[0];
 const second=await f.submit({requestKind:'paid',reason:'商谈下一轮付费合作',contact:'new-wrong-contact'});await f.review(second,{name:'覆盖尝试',contact:'wrong',evidence:proof});
 const out=await readCreators(f.db,f.users.admin);assert.equal(out.profiles.length,1);assert.equal(out.submissions.length,2);assert.equal(out.submissions.every(r=>r.creator_id===original.id),true);assert.equal(out.profiles[0].data.contact,'test@example.test');assert.equal(out.profiles[0].name,'演示达人');
});

test('accepted handoff proceeds directly to BD proposal, approval and fulfillment without fake contact or reply',async()=>{
 const f=await setup(),row=await f.submit();await f.review(row);const id=(await readCreators(f.db,f.users.admin)).profiles[0].id;
 const proposal={recipient:'测试收件人 / 0812 / TEST-ONLY地址',method:'commission',submissionId:row.id,items:[{sku:'BAG-A',sampleQty:1}],videos:1,lives:0,currency:'CNY',budget:30,commission:'佣金待双方批准协议执行',requirements:'视频展示容量',rights:'未授予二次投流权限',stockCheck:'核对真实仓库库存',zone:'Asia/Jakarta',dueAt:future(),evidence:proof};
 await f.change(f.users.bd,id,'round',proposal);const round=f.sqlite.prepare('SELECT * FROM creator_rounds').get();assert.equal(round.status,'pending');assert.equal(round.author_id,f.users.bd.id);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'round',proposal),/已关联合作/);
 await assert.rejects(()=>f.change(f.users.indonesia,id,'approve',{roundId:round.id,note:'自行批准'}),/岗位/);
 await f.change(f.users.admin,id,'approve',{roundId:round.id,note:'条件核对后批准'});
 await f.change(f.users.bd,id,'dispatch',{roundId:round.id,qty:1,at:now(),warehouseRef:'TEST-OUT-001',carrier:'TEST',tracking:'TEST-TRACK',evidence:proof});
 await f.change(f.users.bd,id,'receipt',{roundId:round.id,at:now(),evidence:proof});
 await f.change(f.users.bd,id,'content',{roundId:round.id,kind:'video',sku:'BAG-A',url:'https://video.example.test/001',at:now(),linkValid:true,skuCorrect:true,accurate:true,agreed:true,note:'验收完成',evidence:proof});
 await f.change(f.users.bd,id,'complete',{roundId:round.id,note:'复盘后提请BD维护',evidence:proof,...f.follow});
 const out=await readCreators(f.db,f.users.admin);assert.equal(out.submissions[0].linkedRound.status,'completed');assert.equal(collaborationStage(out.profiles[0],out.rounds),'已完成');assert.equal(out.profiles[0].source_user_id,f.users.indonesia.id);assert.equal(out.metrics.verifiedProfitCny,null);
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
 try{await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},join(root,'test.tar'));await restoreBackup(join(root,'test.tar'),join(root,'restored'));const restored=openDatabase(join(root,'restored/business.sqlite'));for(const name of ['creator_submissions','creator_submission_history','creator_dossiers','creator_dossier_links'])assert.deepEqual(restored.sqlite.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(),f.sqlite.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());restored.sqlite.close();}finally{rmSync(root,{recursive:true,force:true});}
});

test('one platform dossier across countries preserves separate submissions, ownership and shop rounds',async()=>{
 const f=await setup();await f.submit();const second=(await f.act(f.users.admin,'scope',{site:'马来西亚',platform:'TikTok',shop:'OTHER',operatorId:f.users.malaysia.id,bdId:f.users.other.id})).id;
 await f.act(f.users.malaysia,'intakeSubmit',{rows:[f.row({scopeId:second,grade:'A'})]});
 const out=await readCreators(f.db,f.users.admin);assert.equal(out.profiles.length,2);assert.equal(new Set(out.profiles.map(p=>p.dossier_id)).size,1);assert.equal(out.submissions.length,2);assert.equal((await readCreators(f.db,f.users.bd)).profiles.length,1);assert.equal((await readCreators(f.db,f.users.malaysia)).submissions.length,1);
 const review=f.sqlite.prepare('SELECT * FROM creator_submissions WHERE scope_id=?').get(second);await assert.rejects(()=>f.review(review),/权限/);
 await assert.rejects(()=>f.act(f.users.bd,'leadAssignment',{userId:f.users.bd.id,active:true,note:'越权尝试'}),/仅管理员/);
 await f.act(f.users.admin,'leadAssignment',{userId:f.users.bd.id,active:true,note:'指定五国组长'});
 assert.equal((await readCreators(f.db,f.users.bd)).profiles.length,2);assert.equal((await readCreators(f.db,f.users.bd)).actor.creatorLead,true);
 await f.act(f.users.admin,'leadAssignment',{userId:f.users.bd.id,active:false,note:'撤销组长'});assert.equal((await readCreators(f.db,f.users.bd)).profiles.length,1);
});

test('BD assignment is per creator and operator revisions preserve BD fields and immutable initial evidence',async()=>{
 const f=await setup(),row=await f.submit({grade:'A'});await f.review(row);const profile=f.profile(row.creator_id);
 await f.change(f.users.bd,profile.id,'bdMaintain',{grade:'S',intent:'持续合作',note:'复盘后重点维护',ownerId:f.users.bd.id,nextAt:future(),nextAction:'安排复合作'});
 const latest=f.sqlite.prepare('SELECT * FROM creator_submissions WHERE id=?').get(row.id);
 await f.act(f.users.indonesia,'intakeRevise',{submissionId:row.id,version:latest.version,data:f.row({grade:'B',contact:'revised@example.test'}),note:'补核原始数据'});
 const changed=f.profile(profile.id);assert.equal(changed.bd_grade,'S');assert.equal(JSON.parse(changed.data_json).bdNote,'复盘后重点维护');assert.equal(JSON.parse(changed.data_json).contact,'revised@example.test');assert.equal(JSON.parse(f.sqlite.prepare('SELECT snapshot_json FROM creator_submission_history WHERE submission_id=? AND revision=1').get(row.id).snapshot_json).data.grade,'A');
 await f.submit({platformId:'other-person',profileUrl:'https://example.test/other'});
 await f.act(f.users.admin,'leadAssignment',{userId:f.users.bd.id,active:true,note:'组长任命'});
 await f.change(f.users.bd,profile.id,'bdMaintain',{grade:'A',intent:'交接同事',note:'本月重新分工',ownerId:f.users.other.id,nextAt:future(),nextAction:'新BD继续跟进'});
 const other=await readCreators(f.db,f.users.other);assert.deepEqual(other.profiles.map(p=>p.id),[profile.id]);assert.equal(other.submissions.length,1);assert.equal(other.users.some(u=>u.id===f.users.other.id),true);
 await f.act(f.users.admin,'leadAssignment',{userId:f.users.bd.id,active:false,note:'撤销组长'});
 assert.equal((await readCreators(f.db,f.users.bd)).profiles.some(p=>p.id===profile.id),false);
 await assert.rejects(()=>f.change(f.users.bd,profile.id,'follow',{note:'越权操作',...f.follow}),/不能查看|权限/);
});

test('structured 12-field handoff preserves native GMV, qualification and failed batch atomicity',async()=>{
 const f=await setup(),row=mapIntakeRow({'创建日期':now().slice(0,10),'国家':'印尼','达人ID':'twelve-fields','TK主页链接':proof,'达人联系方式':'test@example.test','达人类型':'视频＋直播','合作方式':'纯佣','达人数据':'粉丝数:1000;订单量:8;GMV:200000;币种:IDR;平均播放量:900','达人分类':'出单且勤快','运营评估等级':'A','视频内容与创作能力标签':'会自己根据产品创作'},{scopeId:f.scope,qualified:true});
 const out=normalizeIntake(row,now().slice(0,10));assert.equal(out.orders,8);assert.equal(out.gmvMinor,20000000);assert.equal(out.currency,'IDR');assert.equal(out.kind,'both');
 await f.act(f.users.indonesia,'intakeSubmit',{rows:[row]});
 await assert.rejects(()=>f.act(f.users.indonesia,'intakeSubmit',{rows:[f.row({qualified:false})]}),/初次合作/);
 await assert.rejects(()=>f.act(f.users.indonesia,'intakeSubmit',{rows:[f.row({contact:''})]}),/联系方式/);
 await assert.rejects(()=>f.act(f.users.indonesia,'intakeSubmit',{rows:[f.row({orders:0})]}),/已有出单/);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_profiles').get().n,1);
});

test('standalone maintenance experience supports lead review, self-review block and immutable revisions',async()=>{
 const f=await setup();await f.act(f.users.admin,'leadAssignment',{userId:f.users.bd.id,active:true,note:'指定组长'});
 const input={scopeId:f.scope,title:'维护方法示例',category:'maintenance',scene:'已合作达人复合作',method:'约定排期并逐周核对',effect:'自报结果，需后续验证',limits:'小样本',evidence:proof,shareConfirmed:true};
 const id=(await f.act(f.users.indonesia,'practiceCreate',input)).id;
 await assert.rejects(()=>f.act(f.users.other,'practiceReview',{practiceId:id,version:1,decision:'approve',note:'越权'}),/组长/);
 await f.act(f.users.bd,'practiceReview',{practiceId:id,version:1,decision:'return',note:'补充具体跟进内容'});
 await f.act(f.users.indonesia,'practiceRevise',{...input,practiceId:id,version:2,method:'按周核对排期、拍摄困难并记录是否准时交付'});
 await f.act(f.users.bd,'practiceReview',{practiceId:id,version:3,decision:'approve',note:'保留小样本边界，允许五国复用'});
 assert.equal((await readCreators(f.db,f.users.other)).practices[0].status,'approved');assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM creator_practice_history').get().n,4);
 assert.throws(()=>f.sqlite.prepare('UPDATE creator_practice_history SET action=?').run('overwrite'),/immutable/);
 const own=(await f.act(f.users.bd,'practiceCreate',input)).id;await assert.rejects(()=>f.act(f.users.bd,'practiceReview',{practiceId:own,version:1,decision:'approve',note:'自审'}),/本人经验/);
});

test('completed round result is revisioned, missing amounts stay null and never book financial profit',async()=>{
 const f=await setup(),row=await f.submit();await f.review(row);const id=row.creator_id;
 const proposal={items:[{sku:'BAG-A',sampleQty:0}],videos:0,lives:1,currency:'IDR',budget:0,commission:'纯佣协议',requirements:'直播展示',rights:'不授权二次投流',stockCheck:'已核对',zone:'Asia/Jakarta',dueAt:future(),evidence:proof};
 await f.change(f.users.bd,id,'round',proposal);const round=f.sqlite.prepare('SELECT * FROM creator_rounds').get();
 await f.change(f.users.admin,id,'approve',{roundId:round.id,note:'独立审核'});
 await assert.rejects(()=>f.change(f.users.bd,id,'complete',{roundId:round.id,note:'未直播',evidence:proof,...f.follow}),/直播|交付/);
 await f.change(f.users.bd,id,'content',{roundId:round.id,sku:'BAG-A',kind:'live',url:'https://example.test/live',at:now(),duration:30,linkValid:true,skuCorrect:true,accurate:true,agreed:true,note:'直播验收',evidence:proof});
 await f.change(f.users.bd,id,'complete',{roundId:round.id,note:'直播完成安排复盘',evidence:proof,...f.follow});
 const result={roundId:round.id,from:now().slice(0,10),to:now().slice(0,10),currency:'IDR',orders:6,gmv:150000,cost:'',evaluation:'直播产出待财务核验',nextPlan:'继续评估',evidence:proof};
 await f.change(f.users.bd,id,'roundResult',{...result,resultRevision:0});await assert.rejects(()=>f.change(f.users.bd,id,'roundResult',{...result,resultRevision:0}),/效果已修订/);
 await f.change(f.users.bd,id,'roundResult',{...result,resultRevision:1,orders:5});
 const out=await readCreators(f.db,f.users.admin);assert.equal(out.results.length,2);assert.equal(out.results[0].data.costMinor,null);assert.equal(out.results[0].data.orders,5);assert.equal(out.finances.length,0);assert.equal(out.metrics.verifiedProfitCny,null);assert.equal(out.profiles[0].first_reply_at,null);
 assert.throws(()=>f.sqlite.prepare('DELETE FROM creator_round_results').run(),/immutable/);
});

test('migration backfills previously unlinked submissions without changing history or inventing acceptance',async()=>{
 const {DatabaseSync}=await import('node:sqlite'),{readdirSync,readFileSync}=await import('node:fs');const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 try{
  for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')&&f<'0039').sort())db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
  for(const [id,role] of [['op','运营'],['bd','达人BD']])db.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,id+'@example.test',id,role,now(),now());
  db.prepare('INSERT INTO creator_scopes(id,site,platform,shop,operator_id,bd_id,updated_at) VALUES(?,?,?,?,?,?,?)').run('old','印尼','TikTok','LEGACY','op','bd',now());
  for(const id of ['submission-1','submission-2'])db.prepare('INSERT INTO creator_submissions(id,scope_id,platform_id,submitted_on,request_kind,submitter_id,submitted_by,data_json,fingerprint,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'old','legacy-person',now().slice(0,10),'profile','op','op',JSON.stringify({profileUrl:proof,contact:'test@example.test',kind:'live'}),id,now(),now());
  db.exec(readFileSync(new URL('../drizzle/0039_creator_handover.sql',import.meta.url),'utf8'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM creator_profiles').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM creator_dossiers').get().n,1);
  const profile=db.prepare('SELECT * FROM creator_profiles').get();assert.equal(profile.kind,'live');assert.equal(profile.accepted_at,null);assert.equal(profile.first_contact_at,null);assert.equal(profile.first_reply_at,null);assert.equal(profile.bd_grade,'');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM creator_submissions WHERE creator_id=?').get(profile.id).n,2);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{db.close();}
});

test('lead, independent experience histories and result revisions survive complete backup restore',async()=>{
 const f=await setup();await f.act(f.users.admin,'leadAssignment',{userId:f.users.bd.id,active:true,note:'TEST任命'});
 await f.act(f.users.indonesia,'practiceCreate',{scopeId:f.scope,title:'TEST经验',category:'outreach',scene:'复合作沟通',method:'测试步骤',effect:'待验证',evidence:proof,shareConfirmed:true});
 const row=await f.submit();await f.review(row);const root=mkdtempSync(join(tmpdir(),'lj-bd-handover-'));
 try{await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},join(root,'test.tar'));await restoreBackup(join(root,'test.tar'),join(root,'restored'));const restored=openDatabase(join(root,'restored/business.sqlite'));
  for(const name of ['creator_profiles','creator_leads','creator_practices','creator_practice_history','creator_dossiers','creator_dossier_links'])assert.deepEqual(restored.sqlite.prepare(`SELECT * FROM ${name} ORDER BY 1`).all(),f.sqlite.prepare(`SELECT * FROM ${name} ORDER BY 1`).all());restored.sqlite.close();
 }finally{rmSync(root,{recursive:true,force:true});}
});


test('queued and reassigned handoff tasks follow the effective BD owner without granting acceptance',async()=>{
 const f=await setup(),row=await f.submit();
 await f.act(f.users.admin,'intakeReview',{submissionId:row.id,version:row.version,decision:'queued',ownerId:f.users.other.id,nextAt:future(),nextAction:'新负责人核实深度合作意向',note:'交给专门负责人跟进'});
 assert.equal(f.profile(row.creator_id).accepted_at,null);
 assert.equal((await readCreators(f.db,f.users.other)).submissions[0].responsibleBd,f.users.other.id);
 assert.equal((await creatorWorkspaceTasks(f.db,f.users.other)).filter(t=>t.entity===row.creator_id||t.entity==='submission:'+row.id).length,1);
 assert.equal((await readCreators(f.db,f.users.bd)).submissions.length,0);
 await f.change(f.users.admin,row.creator_id,'bdMaintain',{grade:'B',ownerId:f.users.bd.id,intent:'核实复合作意向',note:'重新分配负责人',nextAt:future(),nextAction:'承接原跟进计划'});
 assert.deepEqual((await creatorWorkspaceTasks(f.db,f.users.bd)).filter(t=>t.entity===row.creator_id||t.entity==='submission:'+row.id).map(t=>t.entity),['submission:'+row.id]);
 assert.equal((await creatorWorkspaceTasks(f.db,f.users.other)).some(t=>t.entity===row.creator_id),false);
 assert.equal(f.profile(row.creator_id).accepted_at,null);
});


test('pending handoff can pause before acceptance and resume without losing its source',async()=>{
 const f=await setup(),row=await f.submit();
 await f.change(f.users.bd,row.creator_id,'pause',{nextOwner:f.users.bd.id,nextAt:future(),nextAction:'条件恢复后重新评估',note:'达人当前无时间合作'});
 assert.equal((await readCreators(f.db,f.users.bd)).submissions[0].paused,true);
 assert.equal((await creatorWorkspaceTasks(f.db,f.users.bd)).length,0);
 await assert.rejects(()=>f.review(row),/暂停/);
 await f.change(f.users.bd,row.creator_id,'resume',{nextOwner:f.users.bd.id,nextAt:future(),nextAction:'继续接收流程',note:'达人已恢复排期'});
 assert.equal(f.profile(row.creator_id).accepted_at,null);
 assert.equal((await creatorWorkspaceTasks(f.db,f.users.bd)).length,1);
 await f.review(row);assert.ok(f.profile(row.creator_id).accepted_at);
});
