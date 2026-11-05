import {fixture} from './fixtures.mjs';
import {mutateCenter} from '../lib/content-center.mjs';

export const ago=days=>new Date(Date.now()-days*86400000).toISOString();
export const date=()=>ago(0).slice(0,10);
export const brief={source:'studio',site:'印尼',sku:'BAG-A',title:'通勤包能装下哪些随身物品',audience:'通勤顾客',sellingPoint:'容量',scene:'公司静拍',
  brief:'桌面平铺折伞、水杯和钱包，连续拍下装入、拉上拉链和上肩后的包型。'};
export function contentFixture(){
  const f=fixture(),camera={id:'studio-demo',name:'拍摄剪辑（演示）',role:'拍摄剪辑'},lead={id:'lead-demo',name:'内容主管（演示）',role:'运营主管'};
  for(const u of [camera,lead])f.sqlite.prepare('INSERT INTO users(id,email,name,role,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(u.id,u.id+'@example.test',u.name,u.role,ago(1),ago(1));
  const act=(actor,action,p)=>mutateCenter(f.db,actor,{operationId:crypto.randomUUID(),action,...p});
  const current=(table,id)=>f.sqlite.prepare('SELECT * FROM '+table+' WHERE id=?').get(id);
  return {...f,camera,lead,act,current};
}
export async function original(f){
  const today=date(),idOp=f.users.indonesia,myOp=f.users.malaysia;
  const script=(await f.act(idOp,'create',{...brief,due:today})).id;
  await f.act(f.camera,'schedule',{scriptId:script,version:1,shoot:today,delivery:today});
  const v=(await f.act(f.camera,'deliver',{scriptId:script,version:2,label:'A · 先展示装满后的包',storyboard:'开头展示装好后的包，再逐件放入物品。',master:'https://example.test/demo/master-A'})).id;
  await f.act(idOp,'accept',{versionId:v,version:1});
  const post=(await f.act(myOp,'claim',{versionId:v,site:'马来西亚',account:'loongjump.demo.my',language:'马来语',traffic:'自然',changes:'更换本地字幕',planned:today})).id;
  await f.act(myOp,'publish',{postId:post,version:1,url:'https://www.tiktok.com/@loongjump.demo.my/video/987654321001',publishedAt:ago(8)});
  return {script,v,post};
}
export function seedCreator(f){
 const {sqlite}=f,old=ago(11),published=ago(9);
 sqlite.prepare("INSERT INTO creator_scopes(id,site,platform,shop,operator_id,bd_id,updated_at) VALUES('scope-demo','印尼','TikTok','演示店','id-ops','admin-1',?)").run(old);
 sqlite.prepare("INSERT INTO creator_profiles(id,scope_id,platform_id,name,kind,source_user_id,data_json,created_at,updated_at) VALUES('creator-demo','scope-demo','demo.creator','演示达人','video','id-ops','{}',?,?)").run(old,old);
 sqlite.prepare("INSERT INTO creator_rounds(id,creator_id,round_no,status,terms_json,original_due_at,effective_due_at,author_id,approved_at,created_at,updated_at) VALUES('round-demo','creator-demo','DEMO-ROUND','executing','{}',?,?,'id-ops',?,?,?)").run(old,old,old,old,old);
 sqlite.prepare("INSERT INTO creator_contents(id,round_id,kind,url,published_at,status,data_json,created_at,updated_at) VALUES('video-demo','round-demo','video','https://www.tiktok.com/@demo.creator/video/987654321119',?,'accepted',?,?,?)").run(published,JSON.stringify({sku:'BAG-A'}),old,old);
 sqlite.prepare("INSERT INTO creator_observations(id,content_id,window_days,revision,observed_at,data_json,actor_id,created_at) VALUES('obs-demo','video-demo',7,1,?,?,'id-ops',?)").run(ago(2),JSON.stringify({views:330,clicks:9,orders:null}),ago(2));
}
