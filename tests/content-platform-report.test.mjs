import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as x from 'xlsx';
import {contentFixture,original,ago,date,seedCreator} from './content-center-fixture.mjs';
import {readPlatformReports,readCenter} from '../lib/content-center.mjs';
import {readCreators} from '../lib/creators.mjs';
import {metricSheetRows} from '../lib/content-metrics-import.mjs';
import {parseReport,reportHeaders,platformSheetRows,findReportHeader} from '../lib/content-platform-report.mjs';
import {SITE_CURRENCIES} from '../lib/sales-data.mjs';

test('运营模板：第三行表头、Excel 链接与百分数、CSV 长编号，分别验证五站币种',()=>{
 for(const site of Object.keys(SITE_CURRENCIES)){
  const columns=reportHeaders(site),id='7429912345678901234',row=columns.map(()=>null);
  row[0]='打开视频';for(const [j,key] of ['Video-attributed GMV','Video GMV','Video indirect GMV','GPM'].entries())row[columns.findIndex(s=>s.startsWith(key+' ('))]=[3608608,2157856,1450752,272081][j];
  const sheet=x.utils.aoa_to_sheet([['平台导出'],[],columns,row]),rate=columns.indexOf('Click-through rate');
  sheet.A4.l={Target:'https://www.tiktok.com/@test/video/'+id};
  sheet[x.utils.encode_cell({r:3,c:rate})]={t:'n',z:'0.00%',v:0.0982};
  const book=x.utils.book_new();x.utils.book_append_sheet(book,sheet,'Video performance');
  const imported=x.read(x.write(book,{type:'buffer',bookType:'xlsx'}),{type:'buffer'}).Sheets['Video performance'];
  const matrix=metricSheetRows(x,imported),head=findReportHeader(matrix);assert.equal(head,2);
  const [record]=parseReport(platformSheetRows(x,imported,matrix,head),site);
  assert.deepEqual(record,{line:4,videoId:id,attributedGmv:3608608,videoGmv:2157856,indirectGmv:1450752,gpm:272081,ctr:9.82});
  const csv=x.read('Video ID,Comments,Views\n'+id+',0,\n',{type:'string',raw:true});
  const [parsed]=parseReport(metricSheetRows(x,csv.Sheets[csv.SheetNames[0]]),site);assert.equal(parsed.videoId,id);assert.equal(parsed.comments,0);assert.equal(parsed.views,undefined);
  const other=site==='印尼'?'泰国':'印尼';assert.throws(()=>parseReport(matrix,other),/币种/);
 }
 assert.throws(()=>parseReport([['Video ID','Views'],[Number('7429912345678901234'),1]],'印尼'),/舍入/);
 assert.throws(()=>parseReport([['Video ID','Views'],['12345',1],['12345',0]],'印尼'),/重复/);
});
test('实际写入按站点授权，保留未登记的视频，发布后关联；同期间去重与修订独立于累计观察',async()=>{
 const f=contentFixture(),op=f.users.malaysia;
 try{
  const form={site:'马来西亚',currency:'MYR',start:ago(9).slice(0,10),end:date(),file:'my.csv',
    rows:[{videoId:'987654321001',views:0,attributedGmv:12.01,videoGmv:10,indirectGmv:2.01,gpm:300}]};
  const save=()=>f.act(op,'importPlatformReport',form),read=()=>readPlatformReports(f.db,op,form.site);
  await assert.rejects(f.act(f.users.indonesia,'importPlatformReport',form),{status:403});
  await assert.rejects(readPlatformReports(f.db,f.users.indonesia,form.site),{status:403});
  await assert.rejects(f.act(op,'importPlatformReport',{...form,currency:'IDR'}),/币种/);
  await assert.rejects(f.act(op,'importPlatformReport',{...form,rows:[...form.rows,{videoId:'123456',views:-1}]}),/第 3 行/);
  assert.equal((await read()).rows.length,0);
  await save();await save();let [row]=(await read()).rows;
  assert.equal(row.revision,1);assert.equal(row.matched,0);
  await original(f);row=(await read()).rows[0];assert.equal(row.matched,1);assert.equal(row.metrics.views,0);
  form.rows[0].gpm=310;await save();row=(await read()).rows[0];assert.equal(row.revision,2);assert.equal(row.metrics.attributedGmv,12.01);assert.equal(row.metrics.gpm,310);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM content_metrics').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM content_platform_reports').get().n,2);
 }finally{f.sqlite.close();}
});
test('实拍与达人原片均能省略标题和补充说明',async()=>{
 const f=contentFixture();try{
  const common={due:date(),sku:'BAG-A',site:'印尼',scene:'公司静拍'};
  for(const source of ['studio','ai','creator']){
   if(source==='creator')seedCreator(f);
   const {id}=await f.act(f.users.indonesia,'create',{...common,source,sourceContentId:'video-demo',colors:'黑色、青色',directions:'产品展示、自定义'});
   const s=f.current('content_scripts',id);assert.match(s.title,/印尼.*BAG-A/);assert.equal(s.brief,'');
   if(source==='studio')assert.equal(s.colors,'黑色、青色');
  }
  assert.equal((await readCenter(f.db,f.users.admin)).scripts.length,3);
 }finally{f.sqlite.close();}
});
test('指定待审测试单作废留痕；已批准单、同达人其他待办、其他账号原样保留',async()=>{
 const migration=readFileSync(new URL('../drizzle/0062_studio_report_and_bd_correction.sql',import.meta.url),'utf8');
 for(const approved of [true,false]){
  const f=contentFixture();try{
   seedCreator(f);const db=f.sqlite;
   db.exec("DROP TABLE content_platform_reports;ALTER TABLE creator_rounds DROP COLUMN test_archived_at");
   db.exec("UPDATE creator_scopes SET shop='Loong Jump'; UPDATE creator_profiles SET name='neuisrosita';");
   db.prepare("INSERT INTO users(id,name,email,role,created_at,updated_at) VALUES('bd-demo','肖惋欣','xwx@loongjump.com','达人BD',?,?)").run(ago(5),ago(5));
   const stmt=db.prepare("INSERT INTO creator_rounds(id,creator_id,round_no,status,terms_json,original_due_at,effective_due_at,author_id,approved_at,created_at,updated_at) VALUES(?,'creator-demo',?,?, '{}',?,?,'id-ops',?,?,?)");
   const number='BD-20261106-B90D729A';stmt.run('target',number,approved?'approved':'pending',date(),date(),approved?ago(1):null,date(),date());
   stmt.run('other','ANOTHER','pending',date(),date(),null,date(),date());
   db.exec(migration);
   assert.equal(db.prepare("SELECT name FROM users WHERE id='bd-demo'").get().name,'肖婉欣');
   assert.equal(f.current('creator_rounds','target').status,approved?'approved':'cancelled');
   assert.equal(f.current('creator_rounds','other').status,'pending');
   assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='archiveTestRound'").get().n,approved?0:1);
   const view=await readCreators(f.db,f.users.admin);
   assert.equal(view.rounds.some(r=>r.id==='target'),approved);assert.ok(view.rounds.some(r=>r.id==='other'));
   assert.ok(!view.tasks.some(t=>t.taskKey==='approval:target'));assert.ok(view.tasks.some(t=>t.taskKey==='approval:other'));
  }finally{f.sqlite.close();}
 }
});
