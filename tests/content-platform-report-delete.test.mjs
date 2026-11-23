import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFixture,original,ago} from './content-center-fixture.mjs';
import {mutateCenter,previewReport,readCenterCompass,readPlatformReports,reportHistory} from '../lib/content-center.mjs';

const site='马来西亚',start='2025-05-01',end='2025-05-02',now=Date.parse('2025-05-25T08:00:00Z');
const videoId='987654321001',reason='报表填错，删除后重新核对导入';
const values={videoId,creatorName:'测试创作者',views:100,orders:2,attributedGmv:12.5,videoGmv:10,gpm:80};
const form=rows=>({site,start,end,currency:'MYR',file:'TEST-ONLY.csv',rows});
const deletion=(revision=1)=>({site,start,end,videoId,revision,reason});
const offline=async()=>new Response(null,{status:503});

function setup(t){
 const f=contentFixture();t.after(()=>f.sqlite.close());
 f.sqlite.prepare('INSERT INTO finance_rates VALUES(?,?,?,?,?,?,?,?)').run('delete-rate','2025-05','MYR',1,1.5,'测试汇率',f.users.admin.id,ago(0));
 const op=f.users.malaysia;
 const store=(rows=[values],actor=op)=>f.act(actor,'importPlatformReport',form(rows));
 const remove=(revision=1,actor=op,extra={})=>f.act(actor,'deletePlatformReport',{...deletion(revision),...extra});
 const read=(actor=op)=>readPlatformReports(f.db,actor,site,0,'all',now);
 const compass=()=>readCenterCompass(f.db,op,'all','',now,offline);
 const count=(table,where='1=1')=>f.sqlite.prepare('SELECT COUNT(*) n FROM '+table+' WHERE '+where).get().n;
 return {...f,op,store,remove,read,compass,count};
}

test('报表删除保留全部修订和操作记录，明细、覆盖率、期间和播放/订单/人民币 GMV 同步重算',async t=>{
 const f=setup(t);
 await f.store([values,{videoId:'987654321002',views:50,orders:1,attributedGmv:5}]);
 await f.store([{...values,views:120}]);
 let report=(await f.compass()).reports.rows.find(r=>r.site===site);
 assert.deepEqual([report.entries,report.views,report.orders,report.gmvMinor],[2,170,3,2625]);
 await f.remove(2);
 const detail=await f.read();
 assert.deepEqual(detail.rows.map(r=>r.video_id),['987654321002']);
 assert.deepEqual(detail.coverage,{total:1,matched:0});
 report=(await f.compass()).reports.rows.find(r=>r.site===site);
 assert.deepEqual([report.entries,report.views,report.orders,report.gmvMinor],[1,50,1,750]);
 const revisions=f.sqlite.prepare('SELECT * FROM content_platform_reports WHERE video_id=? ORDER BY revision').all(videoId);
 assert.equal(revisions.length,3);assert.equal(revisions[0].deleted_at,null);assert.equal(revisions[1].deleted_at,null);
 const tombstone=revisions[2];
 assert.equal(tombstone.revision,3);assert.ok(tombstone.deleted_at);assert.equal(tombstone.deleted_by,f.op.id);assert.equal(tombstone.delete_reason,reason);
 assert.equal(tombstone.metrics_json,revisions[1].metrics_json);assert.equal(tombstone.source_file,revisions[1].source_file);
 const history=await reportHistory(f.db,f.op,site,start,end,videoId,0);
 assert.deepEqual(history.rows.map(r=>r.revision),[3,2,1]);
 assert.equal(history.rows[0].deleted_by,f.op.id);assert.equal(history.rows[0].delete_reason,reason);
 assert.equal(f.count('content_events',"action='deletePlatformReport'"),1);
 const audit=f.sqlite.prepare("SELECT * FROM audit_logs WHERE action='deletePlatformReport'").get();
 assert.equal(audit.actor_id,f.op.id);assert.equal(audit.entity_type,'content_platform_report');
 assert.deepEqual(JSON.parse(audit.entity_id),[site,start,end,videoId]);
 assert.deepEqual(JSON.parse(audit.detail_json),{site,start,end,videoId,revision:2,deletedRevision:3,reason,sourceFile:'TEST-ONLY.csv'});
 await f.remove(1,f.op,{videoId:'987654321002'});
 const empty=await f.compass();report=empty.reports.rows.find(r=>r.site===site);
 assert.deepEqual([report.entries,report.views,report.orders,report.gmvMinor],[0,null,null,null]);
 assert.deepEqual(empty.reports.ranges,[]);assert.equal((await f.read()).rows.length,0);
});

test('运营只能删除当前由本人提交且仍有站点权限的报表；主管和管理员可管理，拍摄及其他岗位不可删除',async t=>{
 const f=setup(t),coworker={id:'my-colleague',role:'运营',name:'同站运营',site,channel:'TikTok'};
 f.sqlite.prepare('INSERT INTO users(id,email,name,role,site,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
  .run(coworker.id,'colleague@example.test',coworker.name,coworker.role,site,'TikTok',ago(1),ago(1));
 await f.store();
 for(const actor of [coworker,f.camera,f.users.indonesia,f.users.finance,f.users.supply])
  await assert.rejects(f.remove(1,actor),{status:403});
 assert.equal((await f.read()).rows[0].canDelete,true);
 assert.equal((await f.read(coworker)).rows[0].canDelete,false);
 assert.equal((await f.read(f.camera)).rows[0].canDelete,false);
 for(const actor of [f.users.admin,f.lead])assert.equal((await f.read(actor)).rows[0].canDelete,true);
 // A colleague's newer correction is not the original operator's record to remove.
 await f.store([{...values,views:110}],coworker);
 await assert.rejects(f.remove(2),{status:403});
 assert.equal((await f.read()).rows[0].canDelete,false);
 await f.remove(2,f.lead);
 await f.store();
 await f.remove(4,f.users.admin);
 assert.equal((await f.read()).rows.length,0);
 await f.store();
 f.sqlite.prepare("UPDATE users SET channel='Shopee' WHERE id=?").run(f.op.id);
 await assert.rejects(f.remove(6),{status:403});
 assert.equal(f.count('content_platform_reports', 'deleted_at IS NOT NULL'),2);
});

test('删除版本必须精确，重复点击安全重放，旧版本和重复删除不产生额外记录',async t=>{
 const f=setup(t);await f.store();await f.store([{...values,views:101}]);
 for(const revision of [1,0,-1,1.5,undefined,'2']){
  await assert.rejects(f.remove(revision,f.op,{revision}),e=>[400,409].includes(e.status));
 }
 await assert.rejects(f.remove(2,f.op,{reason:''}),{status:400});
 assert.equal(f.count('content_platform_reports'),2);
 const request={operationId:crypto.randomUUID(),action:'deletePlatformReport',...deletion(2)};
 const saved=await mutateCenter(f.db,f.op,request);
 assert.deepEqual(await mutateCenter(f.db,f.op,request),saved);
 await assert.rejects(mutateCenter(f.db,f.op,{...request,reason:'更换原因'}),{status:409});
 await assert.rejects(f.remove(2),{status:409});
 await assert.rejects(f.remove(3),{status:409});
 assert.equal(f.count('content_platform_reports'),3);
 assert.equal(f.count('content_events',"action='deletePlatformReport'"),1);
});

test('删除后重新导入允许同值恢复，但缺失字段不会沿用已删除记录的旧指标',async t=>{
 const f=setup(t);await f.store();await f.remove();
 let preview=await previewReport(f.db,f.op,form([values]));
 assert.equal(preview.rows[0].revision,2);assert.equal(preview.rows[0].changed,true);
 await f.store();let row=(await f.read()).rows[0];
 const {videoId:ignored,...metrics}=values;
 assert.equal(row.revision,3);assert.deepEqual(row.metrics,metrics);
 await f.remove(3);
 preview=await previewReport(f.db,f.op,form([{videoId,views:0}]));
 assert.equal(preview.rows[0].revision,4);assert.deepEqual(preview.rows[0].metrics,{views:0});
 await f.store([{videoId,views:0}]);row=(await f.read()).rows[0];
 assert.equal(row.revision,5);assert.deepEqual(row.metrics,{views:0});
 assert.equal(f.count('content_platform_reports'),5);
 const result=(await f.compass()).reports.rows.find(r=>r.site===site);
 assert.deepEqual([result.entries,result.views,result.orders,result.gmvMinor],[1,0,null,null]);
 await f.store([{videoId,views:0}]);assert.equal(f.count('content_platform_reports'),5);
});

test('报表删除不删除已关联发布记录，也不抹掉独立登记的累计观察数据',async t=>{
 const f=setup(t),{post}=await original(f);
 await f.act(f.op,'observe',{postId:post,version:f.current('content_posts',post).version,
  days:7,observedAt:ago(0),views:55,orders:1,gmv:20,evidence:'TEST-ONLY',note:'独立累计观察'});
 await f.store();assert.equal((await f.read()).rows[0].matched,1);
 const posts=f.sqlite.prepare('SELECT * FROM content_posts').all();
 const observations=f.sqlite.prepare('SELECT * FROM content_metrics').all();
 await f.remove();
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM content_posts').all(),posts);
 assert.deepEqual(f.sqlite.prepare('SELECT * FROM content_metrics').all(),observations);
 assert.equal((await f.read()).coverage.total,0);
 const result=await readCenterCompass(f.db,f.op,'all','',Date.now(),offline);
 assert.equal(result.rows.find(r=>r.site===site).views,55);
 assert.equal(result.reports.rows.find(r=>r.site===site).entries,0);
});

test('删除提交前遇到新修订、站点权限变更或事务失败时整笔回滚',async t=>{
 for(const scenario of ['revision','scope','audit']){
  await t.test(scenario,async t=>{
   const f=setup(t);await f.store();const batch=f.db.batch;
   if(scenario==='audit'){
    f.sqlite.exec("CREATE TRIGGER reject_delete_event BEFORE INSERT ON content_events WHEN NEW.action='deletePlatformReport' BEGIN SELECT RAISE(ABORT,'TEST audit unavailable');END");
   }else{
    let intercepted=false;
    f.db.batch=async statements=>{
     if(!intercepted){
      intercepted=true;
      if(scenario==='revision')await f.store([{...values,views:777}]);
      else f.sqlite.prepare("UPDATE users SET channel='Shopee' WHERE id=?").run(f.op.id);
     }
     return batch(statements);
    };
   }
   await assert.rejects(f.remove(),scenario==='audit'?/TEST audit unavailable/:{status:409});
   assert.equal(f.count('content_platform_reports','deleted_at IS NOT NULL'),0);
   assert.equal(f.count('content_events',"action='deletePlatformReport'"),0);
   assert.equal(f.count('audit_logs',"action='deletePlatformReport'"),0);
   assert.equal(f.count('system_operations',"action='content.deletePlatformReport'"),0);
   const latest=f.sqlite.prepare('SELECT * FROM content_platform_reports ORDER BY revision DESC LIMIT 1').get();
   assert.equal(JSON.parse(latest.metrics_json).views,scenario==='revision'?777:100);
  });
 }
});

