import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as x from 'xlsx';
import {contentFixture,original,ago,date,seedCreator} from './content-center-fixture.mjs';
import {readPlatformReports,readCenter} from '../lib/content-center.mjs';
import {readCreators} from '../lib/creators.mjs';
import {metricSheetRows} from '../lib/content-metrics-import.mjs';
import {parseReport,reportDateRange,platformSheetRows,findReportHeader,reportVideoUrl} from '../lib/content-platform-report.mjs';
import {siteTemplate,templatePath} from '../lib/content-report-template.mjs';
import {SITE_CURRENCIES} from '../lib/sales-data.mjs';

const id='7429912345678901234';
const source=readFileSync(new URL('../public'+templatePath,import.meta.url));

test('公司原版 31 列模板：五站币种、原表日期、创作者资料、链接、百分比和长编号',async()=>{
 const rawBook=x.read(source),original=metricSheetRows(x,rawBook.Sheets.Sheet1);
 assert.equal(original[2].length,31);
 for(const site of Object.keys(SITE_CURRENCIES)){
  const bytes=await siteTemplate(source,site);
  if(site==='印尼')assert.deepEqual(bytes,source);
  const book=x.read(bytes);
  assert.deepEqual(book.SheetNames,['Sheet1']);
  const sheet=book.Sheets.Sheet1,matrix=metricSheetRows(x,sheet),head=findReportHeader(matrix);
  assert.equal(head,2);assert.equal(matrix[2].length,31);
  assert.deepEqual(reportDateRange(matrix,head),{start:'2026-11-08',end:'2026-11-14'});
  assert.deepEqual(matrix[2].filter((_,i)=>i<22||i>25),original[2].filter((_,i)=>i<22||i>25));
  assert.throws(()=>parseReport(matrix,site),/1 至 500/);
  const row=['创作者 A','000345','通勤包视频','打开视频','2026-11-12 09:10','7345678901234567891','包款 A',
    1000,13,2,3,4,5,800,40,10,8,5,3,9,6,3,3608608,2157856,1450752,272081,0.0982,'2%',0.45,'12.5%','互动稳定'];
  x.utils.sheet_add_aoa(sheet,[row],{origin:'A4'});
  sheet.D4.l={Target:'https://www.tiktok.com/@test/video/'+id};sheet.AA4.z='0.00%';sheet.AC4.z='0%';
  const imported=x.read(x.write(book,{type:'buffer',bookType:'xlsx'}),{type:'buffer',cellDates:true}).Sheets.Sheet1;
  const filled=platformSheetRows(x,imported,metricSheetRows(x,imported),head);
  const [record]=parseReport(filled,site);
  assert.deepEqual(record,{line:4,videoId:id,creatorName:'创作者 A',creatorId:'000345',videoInfo:'通勤包视频',publishTime:'2026-11-12 09:10',
    productId:'7345678901234567891',products:'包款 A',views:1000,likes:13,comments:2,shares:3,followers:4,liveClicks:5,
    impressions:800,clicks:40,customers:10,orders:8,videoOrders:5,indirectOrders:3,units:9,videoUnits:6,indirectUnits:3,
    attributedGmv:3608608,videoGmv:2157856,indirectGmv:1450752,gpm:272081,ctr:9.82,liveRate:2,finishRate:45,ctor:12.5,diagnosis:'互动稳定'});
  assert.throws(()=>parseReport(filled,site==='印尼'?'泰国':'印尼'),/币种/);
 }
 const csv=x.read('Video ID,Comments,Views\n'+id+',0,\n',{type:'string',raw:true});
 const [parsed]=parseReport(metricSheetRows(x,csv.Sheets[csv.SheetNames[0]]),'印尼');assert.equal(parsed.videoId,id);assert.equal(parsed.comments,0);assert.equal(parsed.views,undefined);
 assert.throws(()=>parseReport([['Video ID','Views'],[Number(id),1]],'印尼'),/舍入/);
 assert.throws(()=>parseReport([['Video ID','Views'],['12345',1],['12345',0]],'印尼'),/重复/);
});
test('实际写入按站点授权，保留未登记的视频，发布后关联；同期间去重与修订独立于累计观察',async()=>{
 const f=contentFixture(),op=f.users.malaysia;
 try{
  const form={site:'马来西亚',currency:'MYR',start:ago(9).slice(0,10),end:date(),file:'my.csv',
    rows:[{videoId:'987654321001',creatorName:'MY 示例',views:0,attributedGmv:12.01,videoGmv:10,indirectGmv:2.01,gpm:300}]};
  const save=()=>f.act(op,'importPlatformReport',form),read=()=>readPlatformReports(f.db,op,form.site);
  await assert.rejects(f.act(f.users.indonesia,'importPlatformReport',form),{status:403});
  await assert.rejects(readPlatformReports(f.db,f.users.indonesia,form.site),{status:403});
  await assert.rejects(f.act(op,'importPlatformReport',{...form,currency:'IDR'}),/币种/);
  await assert.rejects(f.act(op,'importPlatformReport',{...form,rows:[...form.rows,{videoId:'123456',views:-1}]}),/第 3 行/);
  assert.equal((await read()).rows.length,0);
  await save();await save();let [row]=(await read()).rows;
  assert.equal(row.revision,1);assert.equal(row.matched,0);
  assert.equal(row.videoUrl,'https://www.tiktok.com/player/v1/987654321001');
  await original(f);row=(await read()).rows[0];assert.equal(row.matched,1);assert.equal(row.metrics.views,0);
  assert.equal(row.videoUrl,'https://www.tiktok.com/@loongjump.demo.my/video/987654321001');
  form.rows[0].gpm=310;await save();row=(await read()).rows[0];assert.equal(row.revision,2);assert.equal(row.metrics.attributedGmv,12.01);assert.equal(row.metrics.gpm,310);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM content_metrics').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM content_platform_reports').get().n,2);
  const idReport={...form,site:'印尼',currency:'IDR',rows:[{videoId:form.rows[0].videoId,creatorName:'ID 示例',views:19}]};
  await f.act(f.users.indonesia,'importPlatformReport',idReport);
  assert.equal((await readPlatformReports(f.db,f.users.indonesia,'印尼')).rows[0].videoUrl,'https://www.tiktok.com/player/v1/987654321001');
  const list=(user,period='all')=>readPlatformReports(f.db,user,'',0,period);
  assert.deepEqual((await list(op)).rows.map(r=>r.metrics.creatorName),['MY 示例']);
  assert.deepEqual((await list(f.camera,'month')).rows.map(r=>r.metrics.creatorName).sort(),['ID 示例','MY 示例']);
  assert.equal((await list(f.camera,'previous')).rows.length,0);
  delete form.rows[0].creatorName;await save();
  assert.equal((await read()).rows[0].metrics.creatorName,'MY 示例');
 }finally{f.sqlite.close();}
});
test('视频直达链接核对编号和域名，缺原链接的历史记录可按完整编号打开',()=>{
 const fallback='https://www.tiktok.com/player/v1/'+id;
 assert.equal(reportVideoUrl(id,'https://m.tiktok.com/@test/video/'+id+'?lang=id'),'https://www.tiktok.com/@test/video/'+id);
 for(const url of ['javascript:alert(1)','https://www.tiktok.com.evil.test/@test/video/'+id,'https://www.tiktok.com/@test/video/987654321001']){
   assert.equal(reportVideoUrl(id,url),fallback);
 }
 assert.equal(reportVideoUrl('7.42E+18'), '');
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

test('导入回执区分写入、重复与未关联发布，并在重试时返回原回执',async()=>{
 const f=contentFixture(),p={site:'马来西亚',currency:'MYR',start:ago(2).slice(0,10),end:date(),file:'TEST receipt.csv',rows:[{line:4,videoId:'987654321001',creatorName:'TEST',views:123}]};
 const r=await f.act(f.users.malaysia,'importPlatformReport',p);assert.equal(r.receipt.written,1);assert.equal(r.receipt.unmatched,1);assert.equal(r.receipt.rows[0].line,4);assert.match(r.receipt.rows[0].reason,/已保存并进入/);
 const same=await f.act(f.users.malaysia,'importPlatformReport',p);assert.equal(same.receipt.written,0);assert.equal(same.receipt.unchanged,1);assert.equal(same.receipt.unmatched,1);
});
