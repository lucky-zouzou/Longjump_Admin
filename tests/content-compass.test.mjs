import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFixture,original,seedCreator,brief,date,ago} from './content-center-fixture.mjs';
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
 const read=async(period,at)=> (await readContentCompass(f.db,f.camera,period,at)).rows;
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
