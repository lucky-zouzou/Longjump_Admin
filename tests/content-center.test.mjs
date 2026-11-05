import test from 'node:test';
import assert from 'node:assert/strict';
import {contentFixture,brief,date,ago,original,seedCreator} from './content-center-fixture.mjs';
import {mutateCenter,readCenter} from '../lib/content-center.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBackup,restoreBackup} from '../server/backup.mjs';
import {openDatabase,fileBucket} from '../server/storage.mjs';

test('实拍 → 跨站认领 → 24h/7d → 复拍及后续验证，保留原始版本和空值',async()=>{
 const f=contentFixture(),{script,v,post}=await original(f),p={postId:post,days:1,observedAt:ago(7),views:0,orders:'',note:'订单暂缺',evidence:'演示截图'};
 await assert.rejects(f.act(f.users.indonesia,'observe',{...p,version:2}),{status:403});
 await assert.rejects(f.act(f.camera,'observe',{...p,version:2}),{status:403});
 await assert.rejects(f.act(f.users.malaysia,'observe',{...p,version:2,observedAt:ago(7.5)}),/未成熟/);
 await f.act(f.users.malaysia,'observe',{...p,version:2});await f.act(f.users.malaysia,'observe',{...p,version:3,days:7,observedAt:ago(.9),views:800});
 await assert.rejects(f.act(f.users.malaysia,'observe',{...p,version:2}),{status:409});
 await f.act(f.camera,'review',{postId:post,decision:'复拍',finding:'样本少',hypothesis:'开头未突出容量',change:'只换装包镜头',site:'印尼',ownerId:'id-ops',due:date(),scene:'公司静拍'});
 await f.act(f.camera,'review',{postId:post,decision:'跨站测试',finding:'点击较多',hypothesis:'使用情景合适',change:'测试印尼字幕',site:'印尼',ownerId:'id-ops',due:date(),account:'demo.id',language:'印尼语',traffic:'自然',changes:'印尼字幕'});
 const a=await readCenter(f.db,f.camera);assert.equal(a.writeSites.length,0);assert.equal(a.posts.length,2);assert.equal(a.versions.length,1);
 assert.equal(a.metrics.find(r=>r.days===1).orders,null);assert.equal(a.metrics.find(r=>r.days===1).views,0);
 const remake=a.scripts.find(s=>s.id!==script);assert.equal(remake.parent_version_id,v);assert.equal(remake.status,'待排期');
 const cross=a.posts.find(p=>p.site==='印尼');assert.equal(a.reviews.find(r=>r.decision==='跨站测试').next_post_id,cross.id);
 await f.act(f.users.indonesia,'publish',{postId:cross.id,version:1,url:'https://www.tiktok.com/@demo.id/video/987654321002',publishedAt:ago(1)});
 assert.equal((await readCenter(f.db,f.camera)).posts.find(p=>p.id===cross.id).version,2);
 const root=mkdtempSync(join(tmpdir(),'content-backup-'));try{
  const archive=join(root,'full.tar');await createBackup({DB:f.db,WHOLESALE_FILES:fileBucket(join(root,'files'))},archive);await restoreBackup(archive,join(root,'restored'));
  const restored=openDatabase(join(root,'restored','business.sqlite'));assert.deepEqual((await readCenter(restored,f.camera)).reviews,a.reviews);restored.sqlite.close();
 }finally{rmSync(root,{recursive:true,force:true});f.sqlite.close();}
});

test('达人原片只关联一次，授权按站点／截止日期／原版二剪限制并动态撤销',async()=>{
 const f=contentFixture();seedCreator(f);const payload={...brief,source:'creator',sourceContentId:'video-demo',due:date()};
 await assert.rejects(f.act(f.users.malaysia,'create',payload),{status:403});
 const script=(await f.act(f.users.indonesia,'create',payload)).id;
 await assert.rejects(f.act(f.users.indonesia,'create',payload),{status:409});
 const read=()=>readCenter(f.db,f.users.malaysia);let data=await read();const v=data.versions[0],post=data.posts[0];
 assert.equal(data.sources.length,0);assert.equal(v.master_url,'');assert.equal(post.url,'');assert.equal(data.external[0].views,330);
 const claim={site:'马来西亚',versionId:v.id,account:'demo.my',language:'马来语',traffic:'自然',planned:date()};
 await assert.rejects(f.act(f.users.malaysia,'claim',claim),{status:403});
 const grant={scriptId:script,mode:'direct',sites:['马来西亚'],evidence:'演示授权凭据',end:ago(-9).slice(0,10)};
 await assert.rejects(f.act(f.users.indonesia,'rights',{...grant,version:1}),{status:403});
 await f.act(f.lead,'rights',{...grant,version:1});assert.ok((await read()).versions[0].master_url);
 await assert.rejects(f.act(f.users.malaysia,'claim',{...claim,changes:'更换字幕'}),/仅限原版/);
 const plan=(await f.act(f.users.malaysia,'claim',claim)).id;await f.act(f.lead,'rights',{...grant,version:2,mode:'reference'});
 await assert.rejects(f.act(f.users.malaysia,'publish',{postId:plan,version:1,publishedAt:ago(1),url:'https://www.tiktok.com/@demo.my/video/123'}),{status:403});
 await assert.rejects(f.act(f.users.indonesia,'observe',{postId:post.id,version:1,days:7}),/达人模块/);
 await f.act(f.lead,'rights',{...grant,version:3,end:ago(1).slice(0,10)});assert.equal((await read()).versions[0].master_url,'');
 await f.act(f.lead,'rights',{...grant,version:4,mode:'edit'});f.sqlite.exec("UPDATE creator_contents SET version=version+1 WHERE id='video-demo'");
 assert.equal((await read()).versions[0].master_url,'');f.sqlite.close();
});

test('重复提交、维护锁、越权与 AI 返工：成片修订保留旧版',async()=>{
 const f=contentFixture(),a=f.users.indonesia,form={operationId:crypto.randomUUID(),action:'create',...brief,source:'ai',due:date()};
 const call=()=>mutateCenter(f.db,a,form);const {id}=await call();assert.deepEqual(await call(),{id});
 await assert.rejects(mutateCenter(f.db,a,{...form,title:'其他标题'}),{status:409});
 await assert.rejects(f.act(f.users.malaysia,'create',{...brief,due:date()}),{status:403});
 await assert.rejects(readCenter(f.db,f.users.finance),{status:403});
 const delivery={scriptId:id,version:1,label:'AI A',storyboard:'先拍材质',master:'https://example.test/a',productRef:'https://example.test/b',prompt:'按实物参考绘制',productChecked:true};
 await assert.rejects(f.act(a,'deliver',{...delivery,productChecked:false}),/实物/);
 await assert.rejects(f.act(a,'deliver',{...delivery,master:'javascript:alert(1)'}),/HTTPS/);
 const v=(await f.act(a,'deliver',delivery)).id;await assert.rejects(f.act(f.users.malaysia,'accept',{versionId:v,version:1}),{status:403});
 await f.act(a,'return',{versionId:v,version:1,feedback:'修正手柄长度'});
 const v2=(await f.act(a,'deliver',{...delivery,version:3,label:'AI B'})).id;await f.act(a,'accept',{versionId:v2,version:1});
 const base={...brief,parentId:v2,site:'马来西亚',due:date()};const adapted=(await f.act(f.users.malaysia,'create',base)).id;
 assert.equal(f.current('content_scripts',adapted).parent_version_id,v2);assert.equal(f.current('content_versions',v).status,'退回修改');
 f.sqlite.prepare("INSERT OR REPLACE INTO system_maintenance(id,mode,actor_id,expires_at,updated_at) VALUES('global','backup','test',?,?)").run(ago(-1),ago(0));
 await assert.rejects(f.act(f.users.malaysia,'create',base),{status:409});f.sqlite.close();
});
