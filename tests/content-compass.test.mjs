import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFixture,original,seedCreator,brief,date,ago} from './content-center-fixture.mjs';
import {readCenterCompass,readPlatformReports} from '../lib/content-center.mjs';
import {readContentCompass} from '../lib/content-compass.mjs';
import {metricColumns,parseMetricSheet} from '../lib/content-metrics-import.mjs';

test('罗盘按发布站点与当地月份统计，每条视频仅计最长窗口的当前修订，保留缺报与零',async t=>{
 const f=contentFixture();t.after(()=>f.sqlite.close());
 const {post}=await original(f),op=f.users.malaysia;
 const record=(days,gmv,views,orders)=>f.act(op,'observe',{postId:post,version:f.current('content_posts',post).version,
   days,observedAt:ago(0),views,gmv,orders,evidence:'示例',note:'视频累计'});
 await record(1,10,100,1);await record(7,20,300,2);await record(7,25,350,0);
 const published=f.current('content_posts',post);
 // Corrections from an older workbook without a GMV field preserve the captured amount.
 const headers=metricColumns.slice(0,10).map(([,name])=>name);
 const rows=parseMetricSheet([headers,[published.url,7,ago(0),380,'','','',20,'原表','修订']], [published]);
 await f.act(op,'importMetrics',{rows});
 assert.equal(f.sqlite.prepare('SELECT gmv_minor FROM content_metrics ORDER BY rowid DESC LIMIT 1').get().gmv_minor,2500);
 const read=async(period,at)=> (await readContentCompass(f.db,f.camera,period,at,async()=>({rates:{}}))).rows;
 const my=rows=>rows.find(x=>x.site==='马来西亚');
 const boundary='2026-04-30T16:00:00.000Z';
 f.sqlite.prepare('UPDATE content_posts SET published_at=? WHERE id=?').run(boundary,post);
 const now=Date.parse('2026-05-05T01:00:00Z');
 assert.equal(my(await read('previous',now)).videos,0);
 let row=my(await read('month',now));
 assert.deepEqual([row.videos,row.views,row.orders,row.gmvMinor,row.missingRate],[1,380,null,null,1]);
 f.sqlite.prepare('INSERT INTO finance_rates VALUES(?,?,?,?,?,?,?,?)').run('my-test','2026-05','MYR',1,1.5,'示例',f.users.admin.id,ago(0));
 row=my(await read('month',now));assert.deepEqual([row.gmvMinor,row.gmvCount,row.missingRate],[3750,1,0]);
 await assert.rejects(readContentCompass(f.db,{role:'工厂'}),{status:403});
 await assert.rejects(read('x',now),{status:400});
 seedCreator(f);await f.act(f.users.indonesia,'create',{...brief,source:'creator',sourceContentId:'video-demo',due:date()});
 f.sqlite.prepare("INSERT INTO creator_observations SELECT 'obs-revision',content_id,window_days,revision+1,observed_at,?,actor_id,created_at FROM creator_observations WHERE id='obs-demo'").run(JSON.stringify({views:0,orders:0,revenueMinor:0,currency:'CNY'}));
 const all=await read('all',Date.now());
 const id=all.find(x=>x.site==='印尼');
 assert.equal(all.length,5);assert.deepEqual([id.videos,id.views,id.orders,id.gmvMinor],[1,0,0,0]);
 assert.equal(all.find(x=>x.site==='泰国').videos,0);
});

test('运营报表导入后直接进入罗盘，未关联、已修订、跨月和缺汇率均按原口径展示',async t=>{
 const f=contentFixture();t.after(()=>f.sqlite.close());
 const op=f.users.malaysia,site='马来西亚',now=Date.parse('2025-05-25T04:00:00Z');
 const store=(start,end,rows)=>f.act(op,'importPlatformReport',{site,start,end,rows,currency:'MYR',file:'report.xlsx'});
 const read=(actor=f.camera,period='month',range='')=>readCenterCompass(f.db,actor,period,range,now,async()=>new Response(null,{status:503}));
 const row=result=>result.reports.rows.find(r=>r.site===site);
 const first={videoId:'123456',views:30,orders:0,attributedGmv:10.02,videoGmv:4,gpm:99};
 await store('2025-04-28','2025-05-03',[first,{videoId:'223456',orders:3}]);
 await store('2025-04-28','2025-05-03',[{...first,views:35}]);
 await store('2025-05-04','2025-05-05',[{videoId:first.videoId,views:5,orders:1}]);
 let data=await read(),r=row(data);
 assert.deepEqual([r.entries,r.views,r.viewCount,r.orders,r.orderCount,r.gmvMinor,r.missingRate],[3,40,2,4,3,null,1]);
 assert.equal(data.rows.find(s=>s.site===site).videos,0);
 assert.equal(row(await read(op,'previous')).entries,0);
 assert.deepEqual((await read(f.users.indonesia)).reports.ranges,[]);
 assert.deepEqual((await read(f.users.indonesia)).reports.rows.map(r=>r.site),['印尼']);
 await assert.rejects(read(f.users.supply),{status:403});
 f.sqlite.prepare('INSERT INTO finance_rates VALUES(?,?,?,?,?,?,?,?)').run('compass-rate','2025-05','MYR',1,1.5,'示例',f.users.admin.id,ago(0));
 assert.equal(row(await read()).gmvMinor,1503);
 f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES(?, ?,1,'closed',?,?,?,?)")
  .run('compass-closed','2025-05',JSON.stringify({rates:{MYR:{rate:2}}}),'锁定',f.users.admin.id,ago(0));
 assert.equal(row(await read()).gmvMinor,2004);
 // A complete interval supersedes its two component reports for this video only.
 await store('2025-04-28','2025-05-06',[{...first,views:50,orders:2}]);
 r=row(await read());assert.deepEqual([r.entries,r.views,r.orders,r.overlaps],[2,50,5,0]);
 // Partial overlap cannot be apportioned. Selecting a specific range recovers its exact figures.
 await store('2025-05-05','2025-05-10',[{...first,views:22}]);
 r=row(await read());assert.deepEqual([r.entries,r.views,r.orders,r.overlaps],[1,null,3,1]);
 const range='2025-05-05~2025-05-10';
 r=row(await read(op,'month',range));assert.deepEqual([r.entries,r.overlaps,r.views,r.gmvMinor],[1,0,22,2004]);
 const detail=await readPlatformReports(f.db,op,site,0,'month',now,range);
 assert.equal(detail.rows.length,1);assert.equal(detail.rows[0].matched,0);assert.equal(detail.rows[0].metrics.views,r.views);
});

test('罗盘自动折算五站原币，区分参考、财务和关账汇率，可复算合计并复用历史导入',async t=>{
 const f=contentFixture();t.after(()=>f.sqlite.close());
 const now=Date.parse('2025-05-25T08:00:00Z'),effective=Date.parse('2025-05-25T00:00:00Z');
 const rates={CNY:1,USD:0.15,IDR:2400,MYR:0.6,THB:5,VND:3500,PHP:8};
 let requests=0;
 const quote=async()=>{
   requests++;
   return Response.json({result:'success',base_code:'CNY',rates,time_last_update_unix:effective/1000,time_next_update_unix:effective/1000+86400});
 };
 const {post}=await original(f);
 await f.act(f.users.malaysia,'observe',{postId:post,version:f.current('content_posts',post).version,
   days:7,observedAt:ago(0),gmv:60,currency:'MYR',orders:1,evidence:'测试',note:'累计'});
 f.sqlite.prepare('UPDATE content_posts SET published_at=? WHERE id=?').run('2025-05-01T00:00:00Z',post);
 for(const [site,currency] of Object.entries({'印尼':'IDR','马来西亚':'MYR','泰国':'THB','越南':'VND','菲律宾':'PHP'})){
   await f.act(f.users.admin,'importPlatformReport',{site,currency,start:'2025-05-01',end:'2025-05-02',file:'report.csv',
     rows:[{videoId:'998877',attributedGmv:rates[currency]*100},{videoId:'998878',attributedGmv:0},{videoId:'998879',views:15}]});
 }
 const read=()=>readCenterCompass(f.db,f.camera,'month','',now,quote);
 let result=await read();
 assert.equal(requests,1);
 assert.equal(result.rows.find(r=>r.site==='马来西亚').gmvMinor,10000);
 assert.equal(result.reports.rows.reduce((n,r)=>n+r.gmvMinor,0),50000);
 for(const r of result.reports.rows){
   assert.deepEqual([r.gmvCount,r.missingRate,r.entries,r.referenceCount],[2,0,3,1]);
   const [detail]=r.conversions;
   assert.deepEqual([detail.rate,detail.basis,detail.asOf,detail.cnyMinor],[1/rates[detail.currency],'reference',new Date(effective).toISOString(),10000]);
 }
 f.sqlite.prepare('INSERT INTO finance_rates VALUES(?,?,?,?,?,?,?,?)').run('fixed','2025-05','MYR',1,1.5,'示例',f.users.admin.id,ago(0));
 result=await read();
 assert.equal(requests,1);
 assert.equal(result.reports.rows.reduce((n,r)=>n+r.gmvMinor,0),49000);
 assert.equal(result.reports.rows.find(r=>r.site==='马来西亚').conversions[0].basis,'finance');
 f.sqlite.prepare("INSERT INTO finance_period_events(id,month,revision,status,snapshot_json,evidence,actor_id,created_at) VALUES(?,?,1,'closed',?,?,?,?)")
   .run('closed','2025-05',JSON.stringify({rates:{MYR:{rate:2}}}),'封存',f.users.admin.id,ago(0));
 result=await read();
 for(const r of result.reports.rows.filter(r=>r.site!=='马来西亚')){
   assert.deepEqual([r.gmvMinor,r.gmvCount,r.missingRate,r.referenceCount,r.conversions[0].basis],[0,1,1,0,'closedMissing']);
 }
 assert.equal(result.reports.rows.find(r=>r.site==='马来西亚').gmvMinor,12000);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM finance_rates').get().n,1);
});

test('罗盘汇总覆盖明细第二页，重复导入与系统发布的同一视频分别保留各自口径',async t=>{
 const f=contentFixture();t.after(()=>f.sqlite.close());
 const op=f.users.malaysia,site='马来西亚';await original(f);
 const rows=Array.from({length:51},(_,i)=>({videoId:i?String(80000+i):'987654321001',views:1,orders:0}));
 const form={site,currency:'MYR',start:date(),end:date(),rows,file:'test.csv'};
 await f.act(op,'importPlatformReport',form);await f.act(op,'importPlatformReport',form);
 const data=await readCenterCompass(f.db,op,'all');
 const imported=data.reports.rows.find(r=>r.site===site);
 assert.deepEqual([imported.entries,imported.views,imported.orders,imported.gmvMinor],[51,51,0,null]);
 assert.equal(data.rows.find(r=>r.site===site).videos,1);
 const second=await readPlatformReports(f.db,op,site,50);assert.equal(second.rows.length,1);
});
