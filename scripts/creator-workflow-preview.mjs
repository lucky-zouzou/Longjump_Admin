// Disposable synthetic data; never reads production records or user spreadsheets.
import {fixture} from '../tests/fixtures.mjs';
import {mutateCreator} from '../lib/creators.mjs';
import {creatorFees} from '../lib/creator-model.mjs';
import {releaseMigrations} from '../lib/backup-version.mjs';
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve('work/creator-workflow-preview'),target=root+'/business.sqlite';if(existsSync(target))throw Error('Existing preview retained; no overwrite');mkdirSync(root,{recursive:true});
const f=fixture(),now=new Date().toISOString(),future=new Date(Date.now()+7*86400000).toISOString(),old=new Date(Date.now()-20*86400000).toISOString(),proof='https://example.test/TEST-ONLY';
const admin={id:'local-admin',role:'管理员',name:'演示管理员'},bd={id:'bd-preview',role:'达人BD',name:'演示BD组长'};
for(const u of [admin,bd])f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u.id,u.id+'@example.test',u.name,u.role,now,now);
f.sqlite.prepare("UPDATE users SET name='印尼运营（演示）' WHERE id='id-ops'").run();
const act=(a,action,p={})=>mutateCreator(f.db,a,{action,...p}),follow={nextOwner:f.users.indonesia.id,nextAt:future,nextAction:'核对内容排期与下一轮合作意向'};
const change=(a,id,action,p={})=>act(a,action,{creatorId:id,version:p.roundId?f.sqlite.prepare('SELECT version FROM creator_rounds WHERE id=?').get(p.roundId).version:f.sqlite.prepare('SELECT version FROM creator_profiles WHERE id=?').get(id).version,...p});
for(const [i,site] of ['印尼','马来西亚','泰国','越南','菲律宾'].entries()){
 const scope=(await act(admin,'scope',{site,platform:'TikTok',shop:'TEST-ONLY '+site+'店',operatorId:f.users.indonesia.id,backupId:f.users.malaysia.id,bdId:bd.id})).id;
 for(let j=0;j<(i===0?4:2);j++){
  const id=(await act(f.users.indonesia,'create',{scopeId:scope,platformId:`demo-${i}-${j}`,name:['通勤穿搭','日常开箱','旅行收纳','城市直播'][j]+' · '+site+'（演示）',kind:j===3?'live':'video',profileUrl:'https://example.test/creator/'+i+'-'+j,contact:'TEST-ONLY@example.test',language:site+'语（合成）',fit:'合成演示：展示容量、日常穿搭与真实使用场景',evidence:proof,...follow})).id;
  await change(f.users.indonesia,id,'contact',{at:old,note:'演示：已首次联系',evidence:proof,...follow});
  if(j||i===0)await change(f.users.indonesia,id,'reply',{at:old,note:'演示：收到合作意向',evidence:proof,...follow});
  if(j===1)await change(f.users.indonesia,id,'handoff',{sku:'BAG-A',fit:'场景受众匹配',intent:'希望持续合作',proposal:'视频1条，排期另行确认',quote:'纯佣条件待审批',openIssues:'待核对下一轮SKU',evidence:proof,at:old,...follow});
  if(i===0&&j===1)await change(bd,id,'accept',{note:'演示：进入深度维护',...follow,nextOwner:bd.id});
  if(i===0&&j===0){
   await change(f.users.indonesia,id,'round',{items:[{sku:'BAG-A',sampleQty:0}],videos:1,lives:0,currency:'CNY',budget:'50',commission:'按批准协议执行',requirements:'真实容量展示',rights:'无额外投流授权',stockCheck:'演示核验库存',zone:'Asia/Jakarta',dueAt:future,evidence:proof});
   const r=f.sqlite.prepare('SELECT id FROM creator_rounds WHERE creator_id=?').get(id).id;await change(admin,id,'approve',{roundId:r,note:'演示条件独立审批'});
   await change(f.users.indonesia,id,'content',{roundId:r,sku:'BAG-A',kind:'video',url:'https://example.test/video/demo',at:new Date().toISOString(),linkValid:true,skuCorrect:true,accurate:true,agreed:true,note:'合成内容已验收',evidence:proof});
   await change(f.users.indonesia,id,'complete',{roundId:r,note:'演示完整合作',evidence:proof,...follow});
   await change(f.users.finance,id,'finance',{roundId:r,date:now.slice(0,10),sourceRef:'TEST-ONLY-SETTLEMENT',currency:'CNY',rate:1,rateBasis:'人民币示例',netRevenue:1200,orders:18,ordersFrom:old,ordersAsOf:now,costs:Object.fromEntries(Object.keys(creatorFees).map(k=>[k,{mode:'separate',amount:k==='product'?300:20,evidence:'TEST-ONLY凭证'}])),confirmed:true,evidence:proof,note:'合成示例财务，不是真实经营结果'});
  }
 }
 await act(f.users.indonesia,'intakeSubmit',{rows:[{scopeId:scope,qualified:true,contact:'TEST-ONLY@example.test',performance:'合成数据：已有视频合作并出单，详见演示记录',submittedOn:now.slice(0,10),platformId:`demo-${i}-0`,profileUrl:'https://example.test/creator/'+i+'-0',name:site+'潜力达人（演示）',kind:'video',method:'commission',category:'active',grade:i===0?'A':'B',styles:['会自己根据产品创作','真人出镜+口播+产品展示'],orders:i===2?'':18-i*2,gmv:i===2?'':1200-i*100,currency:'CNY',followers:6000+i*2500,views:3200+i*100,requestKind:i===0?'sku':i===1?'sample':'maintenance',sku:'BAG-A',reason:'演示：内容匹配，需复核表现后安排合作资源',evidence:proof}]});
 const request=f.sqlite.prepare('SELECT * FROM creator_submissions WHERE scope_id=?').get(scope);
 if(i===1||i===3)await act(bd,'intakeReview',{submissionId:request.id,version:1,decision:i===1?'returned':'queued',nextAt:future,nextAction:i===1?'补齐近期播放与订单截图':'核对新款排期后安排深度交接',note:i===1?'请补充30天数据来源':'计划下周核对达人排期'});
}
await act(admin,'leadAssignment',{userId:bd.id,active:true,note:'TEST-ONLY合成组长授权'});
f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const m of releaseMigrations)f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(m.name,m.sha256,now);
f.sqlite.exec("VACUUM INTO '"+target.replaceAll("'","''")+"'");f.sqlite.close();console.log('Synthetic BD workflow preview ready');
