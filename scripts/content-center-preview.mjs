// Local synthetic preview only. Refuse to overwrite an existing fixture.
import {existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {contentFixture,original,seedCreator,brief,date,ago} from '../tests/content-center-fixture.mjs';
import {releaseMigrations} from '../lib/backup-version.mjs';
const dir=resolve('work/content-center-preview'),path=resolve(dir,'business.sqlite');
if(existsSync(path))throw Error('Preview already exists; keeping all existing records.');
mkdirSync(dir,{recursive:true,mode:0o700});
const f=contentFixture(),{script,post}=await original(f);seedCreator(f);
await f.act(f.users.malaysia,'observe',{postId:post,version:2,days:1,observedAt:ago(6.99),views:670,clicks:15,orders:null,retention:47,evidence:'合成演示数据',note:'24 小时，归属订单待补录'});
await f.act(f.users.malaysia,'observe',{postId:post,version:3,days:7,observedAt:ago(.99),views:2320,clicks:65,orders:6,retention:48,evidence:'合成演示数据',note:'7 天累计，和 24 小时窗口重合'});
await f.act(f.camera,'review',{postId:post,decision:'跨站测试',finding:'演示样本中商品点击随观看增加',hypothesis:'装包全过程有助理解容量',change:'同一镜头换印尼语字幕验证',site:'印尼',ownerId:'id-ops',due:date(),account:'loongjump.demo.id',language:'印尼语',traffic:'自然',changes:'印尼语字幕'});
await f.act(f.camera,'deliver',{scriptId:script,version:4,label:'B · 先展示桌面物品',storyboard:'首镜只拍桌面，主体沿用 A 版。',master:'https://example.test/demo/master-B'});
await f.act(f.users.indonesia,'create',{...brief,source:'creator',sourceContentId:'video-demo',title:'达人上肩穿搭演示',sellingPoint:'穿搭',brief:'比较通勤与休闲搭配，保留上肩镜头作为创意参考。',due:date()});
const ai=(await f.act(f.users.malaysia,'create',{...brief,site:'马来西亚',source:'ai',title:'通勤包的材质细节',sellingPoint:'材质',brief:'展示经实物核实的包面纹理和五金。',due:date()})).id;
const aiVersion=(await f.act(f.users.malaysia,'deliver',{scriptId:ai,version:1,label:'纹理特写 A',storyboard:'先展示实物纹理，再切换通勤场景。',master:'https://example.test/demo/ai',
  productRef:'https://example.test/demo/reference',prompt:'参照产品图，保留颜色、形状与拉链位置。',productChecked:true})).id;
await f.act(f.users.malaysia,'accept',{versionId:aiVersion,version:1});
await f.act(f.users.indonesia,'create',{...brief,title:'外景通勤上肩穿搭',sku:'BAG-B',sellingPoint:'穿搭',scene:'外景拍摄',brief:'街头步行、侧面上肩和全身搭配各拍一组。',due:date()});
f.sqlite.exec('CREATE TABLE local_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');
for(const m of releaseMigrations)f.sqlite.prepare('INSERT INTO local_migrations VALUES(?,?,?)').run(m.name,m.sha256,ago(0));
f.sqlite.exec("VACUUM INTO '"+path.replaceAll("'","''")+"'");f.sqlite.close();console.log('Synthetic content center ready.');
