import {videoFileResponse,videoFileType} from './content-video.mjs';
import {assertWritable, atomicBatch, guardStatement} from './atomic.mjs';
import {hasPermission} from './permissions.mjs';
import {salesMoney,SALES_CURRENCIES,SITE_CURRENCIES} from './sales-data.mjs';
import {reportDayBounds} from './content-compass.mjs';
import {reportValues,reportFields} from './content-platform-report.mjs';
import {creatorSites} from './creator-model.mjs';

export const sites=[...creatorSites];
export const sources={studio:'公司实拍原创',ai:'运营 AI 创作',creator:'达人视频'};
export const sceneNames=['公司静拍','外景拍摄','室内＋外景','AI 生成','达人原片'];
export const decisions=['复拍','跨站测试','暂缓'];
const zones={'印尼':'Asia/Jakarta','马来西亚':'Asia/Kuala_Lumpur','泰国':'Asia/Bangkok','越南':'Asia/Ho_Chi_Minh','菲律宾':'Asia/Manila'};
const nowISO=()=>new Date().toISOString();
function stop(message,status=400){throw Object.assign(new Error(message),{status});}
const all=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
const one=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const manager=a=>['管理员','运营主管'].includes(a.role);
const studio=a=>a.role==='拍摄剪辑'||manager(a);
const operator=a=>a.role==='运营'||manager(a);
const localDay=(site,at)=>new Intl.DateTimeFormat('en-CA',{timeZone:zones[site],year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
function field(value,label,max=3000,optional=false){
  if((value==null||value==='')&&optional)return '';
  if(typeof value!=='string'||!value.trim()||value.trim().length>max)stop('请核对'+label);
  return value.trim();
}
function choice(value,options,label){if(!options.includes(value))stop('请选择'+label);return value;}
function day(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)stop('请核对'+label);
  return value;
}
function instant(value,label){
  if(typeof value!=='string'||!/(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))stop('请核对'+label);
  return new Date(value).toISOString();
}
function link(value,label,optional=false){
  if(optional&&!value)return '';
  let url;try{url=new URL(field(value,label,2000));}catch{stop('请填写有效的'+label);}
  if(url.protocol!=='https:'||url.username||url.password)stop(label+'须使用 HTTPS 链接');
  return url.href;
}
function video(value){
  const url=new URL(link(value,'TikTok 视频链接'));
  const match=url.pathname.match(/^\/@[\w.-]+\/video\/(\d+)\/?$/);
  if(!['www.tiktok.com','tiktok.com','m.tiktok.com'].includes(url.hostname)||!match)stop('请粘贴 TikTok 视频完整链接（含 /@账号/video/数字）');
  return {url:'https://www.tiktok.com'+url.pathname.replace(/\/$/,''),key:match[1]};
}
function count(value,label,percent=false){
  if(value==null||value==='')return null;
  if(!['number','string'].includes(typeof value)||typeof value==='string'&&!value.trim())stop('请核对'+label);
  const n=Number(value);
  if(!Number.isFinite(n)||n<0||(percent?n>100:!Number.isSafeInteger(n)))stop('请核对'+label);
  return n;
}
function originalNumber(value,limit,label){
  const n=count(value,label);
  if(n===null||n<1||n>limit)stop(label+'须为 1 至 '+limit+' 的整数');
  return n;
}
function expectVersion(row,p){if(p.version!==row.version)stop('记录已变化，请刷新后再提交',409);}
function allowed(ok){if(!ok)stop('当前账号无权执行此操作',403);}
function state(ok){if(!ok)stop('当前状态无法执行此操作，请刷新核对',409);}
const sourceQuery=`SELECT c.id,c.url,c.published_at,c.version,json_extract(c.data_json,'$.sku') sku,
  s.site,s.id scope_id,s.shop,p.platform_id,r.round_no FROM creator_contents c
  JOIN creator_rounds r ON r.id=c.round_id JOIN creator_profiles p ON p.id=r.creator_id
  JOIN creator_scopes s ON s.id=p.scope_id WHERE c.kind='video' AND c.status='accepted'
  AND s.platform='TikTok' AND r.approved_at IS NOT NULL AND r.status<>'cancelled'`;
async function who(db,identity){
  const actor=await one(db,'SELECT id,name,role,site,channel,active FROM users WHERE id=?',identity.id);
  allowed(actor?.active&&hasPermission(actor.role,'content.read'));
  return actor;
}
async function access(db,actor){
  const scopes=await all(db,"SELECT id,site,operator_id,backup_id FROM creator_scopes WHERE platform='TikTok'");
  function writes(user){if(manager(user))return sites;if(user.role!=='运营')return [];
    return sites.filter(s=>(user.site===s&&user.channel==='TikTok')||scopes.some(c=>c.site===s&&[c.operator_id,c.backup_id].includes(user.id)));}
  const ownScopes=scopes.filter(s=>manager(actor)||[s.operator_id,s.backup_id].includes(actor.id)).map(s=>s.id);
  return {writes,ownScopes};
}
function reusable(right,source,site,at){
  return !!(right&&source&&right.source_version===source.version&&['direct','edit'].includes(right.mode)&&
    right.sites.split(',').includes(site)&&right.end_date>=localDay(site,at));
}
export async function contentTasks(db,actor){
  if(!['拍摄剪辑','运营','管理员','运营主管'].includes(actor.role))return [];
  const tasks=[];
  if(actor.role==='拍摄剪辑'){
    const scripts=await all(db,`SELECT s.* FROM content_scripts s LEFT JOIN users u ON u.id=s.studio_user_id AND u.active=1 AND u.role='拍摄剪辑'
      WHERE s.source='studio' AND s.status IN ('待排期','已排期','待改拍') AND (u.id IS NULL OR u.id=?) ORDER BY s.due,s.id`,actor.id);
    for(const s of scripts)tasks.push({tab:'content-center',entity:s.id,title:{'待排期':'安排拍摄','已排期':'交付成片','待改拍':'按反馈改拍'}[s.status],detail:s.site+' · '+s.title+' · '+(s.delivery_date||s.due),level:'amber'});
  }else{
    const sites=(await access(db,actor)).writes(actor);
    const pending=await all(db,`SELECT v.id,v.label,s.title,s.site,s.owner_id,u.active,u.role owner_role,u.site owner_site,u.channel owner_channel,
      EXISTS(SELECT 1 FROM creator_scopes c WHERE c.site=s.site AND c.platform='TikTok' AND (c.operator_id=u.id OR c.backup_id=u.id)) delegated
      FROM content_versions v JOIN content_scripts s ON s.id=v.script_id LEFT JOIN users u ON u.id=s.owner_id WHERE v.status='待验收' ORDER BY v.created_at,v.id`);
    for(const v of pending){
      const assigned=v.active&&(['管理员','运营主管'].includes(v.owner_role)||v.owner_role==='运营'&&(v.delegated||v.owner_site===v.site&&v.owner_channel==='TikTok'));
      if(sites.includes(v.site)&&(assigned?v.owner_id===actor.id:actor.role==='运营'||manager(actor)))
        tasks.push({tab:'content-center',entity:v.id,title:'验收成片',detail:v.site+' · '+v.title+' · '+v.label,level:'amber'});
    }
  }
  return tasks;
}
export async function materialAccess(db,identity){
  const actor=await who(db,identity);
  const {writes}=await access(db,actor);
  return {actor,writeSites:writes(actor),manage:studio(actor)};
}
export async function readCenter(db,identity){
  const actor=await who(db,identity),{writes,ownScopes}=await access(db,actor),at=nowISO();
  const [scripts,versions,posts,metrics,reviews,rights,sourceRows,external,people,skus]=await Promise.all([
    all(db,'SELECT s.*,f.original_name reference_name FROM content_scripts s LEFT JOIN content_reference_files f ON f.id=s.id ORDER BY s.created_at DESC'),all(db,'SELECT * FROM content_versions ORDER BY created_at DESC'),
    all(db,'SELECT * FROM content_posts ORDER BY created_at DESC'),all(db,'SELECT * FROM content_metrics ORDER BY revision DESC'),
    all(db,'SELECT * FROM content_reviews ORDER BY created_at DESC'),all(db,'SELECT * FROM content_rights'),
    all(db,sourceQuery),all(db,`SELECT o.content_id,o.window_days days,o.revision,o.observed_at,
      json_extract(o.data_json,'$.views') views,json_extract(o.data_json,'$.clicks') clicks,json_extract(o.data_json,'$.orders') orders,
      json_extract(o.data_json,'$.revenueMinor') gmv_minor,json_extract(o.data_json,'$.currency') currency
      FROM creator_observations o JOIN content_scripts s ON s.source_content_id=o.content_id ORDER BY o.revision DESC`),
    all(db,"SELECT id,name,role,site,channel FROM users WHERE active=1 AND role IN ('管理员','运营主管','运营','拍摄剪辑') ORDER BY name"),
    all(db,'SELECT sku,name,product_type FROM sku_settings ORDER BY sku')
  ]);
  const writeSites=writes(actor),selectSources=sourceRows.filter(c=>ownScopes.includes(c.scope_id));
  const grants=new Map(rights.map(r=>[r.script_id,r])),sourceById=new Map(sourceRows.map(s=>[s.id,s]));
  const byScript=new Map(scripts.map(s=>[s.id,s])),byVersion=new Map(versions.map(v=>[v.id,v]));
  function canOpen(s){
    if(s.source!=='creator')return true;
    const origin=sourceById.get(s.source_content_id);
    return !!origin&&(ownScopes.includes(origin.scope_id)||writeSites.some(site=>reusable(grants.get(s.id),origin,site,at)));
  }
  return {actor,writeSites,sites,skus,people:people.map(u=>({id:u.id,name:u.name,role:u.role,sites:writes(u)})),
    sources:selectSources.map(({id,site,sku,shop,round_no,platform_id,url})=>({id,site,sku,shop,round_no,platform_id,url})),
    scripts:scripts.map(s=>{
      const grant=grants.get(s.id),origin=sourceById.get(s.source_content_id);
      return {...s,rightsMode:grant?.mode||'reference',allowedSites:sites.filter(site=>reusable(grant,origin,site,at)),expires:grant?.end_date||'',rightsEvidence:manager(actor)?grant?.evidence||'':''};
    }),
    versions:versions.map(v=>canOpen(byScript.get(v.script_id))?v:{...v,master_url:'',raw_url:'',product_ref:''}),
    posts:posts.map(p=>{
      const s=byScript.get(byVersion.get(p.version_id).script_id);
      return canOpen(s)?p:{...p,url:'',video_key:null,local_url:''};
    }),
    metrics:metrics.map(({evidence,...m})=>({...m,evidence:posts.some(p=>p.id===m.post_id&&(manager(actor)||writeSites.includes(p.site)))?evidence:''})),
    external,reviews,generatedAt:at};
}

async function reportChanges(db,actor,p,at){
  allowed(operator(actor));const {writes}=await access(db,actor);
  const site=choice(p.site,sites,'站点');allowed(writes(actor).includes(site));
  const currency=SITE_CURRENCIES[site],start=day(p.start,'统计开始日'),end=day(p.end,'统计结束日');
  if(start>end||end>localDay(site,at))stop('请核对统计起止日期，结束日不能在站点当地未来');
  if(p.currency!==currency)stop('报表币种与站点不一致');
  if(!Array.isArray(p.rows)||p.rows.length<1||p.rows.length>500)stop('每次可导入 1 至 500 行');
  const prior=await all(db,'SELECT video_id,MAX(revision) revision,metrics_json FROM content_platform_reports WHERE site=? AND start_day=? AND end_day=? GROUP BY video_id',site,start,end);
  const known=new Map(prior.map(r=>[r.video_id,r])),seen=new Set();
  return p.rows.map((input,index)=>{
    const videoId=input?.videoId,line=Number.isInteger(input?.line)?input.line:index+2;
    if(typeof videoId!=='string'||!/^\d{5,22}$/.test(videoId)||seen.has(videoId))stop('第 '+line+' 行：视频编号无效或重复');
    seen.add(videoId);
    let incoming;try{incoming=reportValues(input);}catch(e){stop('第 '+line+' 行：'+e.message);}
    const old=known.get(videoId),revision=old?.revision||0,previous=JSON.parse(old?.metrics_json||'{}');
    const fields=[],metrics={};
    for(const [key] of reportFields){
      const before=previous[key],after=incoming[key];
      if(before==null&&after==null)continue;
      const value=after??(p.clearMissing===true?null:before);
      if(value!=null)metrics[key]=value;
      const kind=after==null?(value==null?'clear':'keep'):before==null?'add':value!==before?'change':'same';
      fields.push({key,kind,before:before??null,after:value??null});
    }
    return {videoId,revision,metrics,fields,changed:fields.some(f=>['add','change','clear'].includes(f.kind))};
  });
}
export async function previewReport(db,identity,p){
  const actor=await who(db,identity);
  return {rows:await reportChanges(db,actor,p,nowISO())};
}
export async function reportHistory(db,identity,site,start,end,videoId,offset){
  const actor=await who(db,identity),{writes}=await access(db,actor);
  choice(site,sites,'站点');allowed(studio(actor)||writes(actor).includes(site));
  day(start,'开始日期');day(end,'结束日期');
  if(!/^\d{5,22}$/.test(videoId)||!Number.isSafeInteger(offset)||offset<0)stop('无效的视频或页码');
  const rows=await all(db,'SELECT revision,source_file,created_at,metrics_json FROM content_platform_reports WHERE site=? AND start_day=? AND end_day=? AND video_id=? ORDER BY revision DESC LIMIT 21 OFFSET ?',site,start,end,videoId,offset);
  return {more:rows.length>20,rows:rows.slice(0,20).map(({metrics_json,...r})=>({...r,metrics:JSON.parse(metrics_json)}))};
}
export async function readPlatformReports(db,identity,site,offset=0,period='all',now=Date.now()){
  const actor=await who(db,identity),{writes}=await access(db,actor);
  const visible=studio(actor)?sites:writes(actor);
  if(site!==''){choice(site,sites,'站点');allowed(visible.includes(site));}
  if(!Number.isSafeInteger(offset)||offset<0)stop('无效的页码');
  const selected=site?[site]:visible;
  if(!selected.length)return {site,more:false,rows:[]};
  const bounds=selected.map(s=>[s,...reportDayBounds(s,period,now)]);
  const rows=await all(db,`WITH bounds(site,first_day,last_day) AS (VALUES ${bounds.map(()=>'(?,?,?)').join(',')})
    SELECT r.site,r.video_id,r.start_day,r.end_day,r.currency,r.revision,r.metrics_json,r.source_file,
    EXISTS(SELECT 1 FROM content_posts p WHERE p.video_key=r.video_id AND p.site=r.site AND p.published_at IS NOT NULL) matched
    FROM content_platform_reports r JOIN bounds b ON b.site=r.site AND r.end_day BETWEEN b.first_day AND b.last_day
    WHERE NOT EXISTS (SELECT 1 FROM content_platform_reports n WHERE n.site=r.site AND n.start_day=r.start_day AND n.end_day=r.end_day
      AND n.video_id=r.video_id AND n.revision>r.revision)
    ORDER BY r.end_day DESC,r.start_day DESC,r.site,r.video_id LIMIT 51 OFFSET ?`,...bounds.flat(),offset);
  return {site,more:rows.length>50,rows:rows.slice(0,50).map(({metrics_json,...r})=>({...r,metrics:JSON.parse(metrics_json)}))};
}

export const referenceLimit=16*1024*1024;

export async function readReference(db,bucket,identity,id,range,head){
  await who(db,identity);
  const file=await one(db,'SELECT * FROM content_reference_files WHERE id=?',id);
  if(!file)stop('参考视频不存在',404);
  return videoFileResponse(bucket,file,range,false,head,async()=>[{...file,base:0}]);
}

/** @param {{file:File,bucket:{put:Function,delete:Function}} | null} [attachment] */
export async function mutateCenter(db,identity,p,attachment=null){
  if(!p||typeof p!=='object'||Array.isArray(p))stop('表单格式无效');
  const operation=field(p.operationId,'提交编号',80),actor=await who(db,identity);
  let reference=null;
  if(attachment){
    allowed(operator(actor));
    if(p.action!=='create'||p.source!=='studio')stop('仅实拍需求可附参考视频');
    if(!(attachment.file instanceof Blob)||!attachment.file.size||attachment.file.size>referenceLimit)stop('参考视频须在 16 MB 以内');
    const bytes=new Uint8Array(await attachment.file.arrayBuffer());
    const type=videoFileType(bytes),name=field(attachment.file.name,'视频文件名',255);
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    reference={bytes,type,name,sha256:Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('')};
  }
  const keys=Object.keys(p);
  if(['importMetrics','importPlatformReport'].includes(p.action)){
    const limit=p.action==='importMetrics'?100:500;
    if(!Array.isArray(p.rows)||p.rows.length<1||p.rows.length>limit)stop('每次可导入 1 至 '+limit+' 行');
    for(const row of p.rows)keys.push(...Object.keys(row||{}));
  }
  const data=JSON.stringify(p,[...new Set(keys)].sort());
  const encoded=new TextEncoder().encode(reference?JSON.stringify([data,reference.name,reference.sha256]):data);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoded)),n=>n.toString(16).padStart(2,'0')).join('');
  async function replay(){
    const event=await one(db,'SELECT * FROM content_events WHERE operation_id=?',operation);
    if(!event)return null;
    if(event.actor_id!==actor.id||event.fingerprint!==hash)stop('此提交编号已被其他操作使用',409);
    return {id:event.result_id};
  }
  const existing=await replay();if(existing)return existing;
  await assertWritable(db);
  const clocks=await one(db,"SELECT COALESCE((SELECT MAX(seq) FROM content_events),0) seq,COALESCE((SELECT version FROM creator_clock WHERE id='global'),0) creator");
  const {writes,ownScopes}=await access(db,actor),writeSites=writes(actor),at=nowISO();
  const targetSite=s=>{choice(s,sites,'站点');allowed(writeSites.includes(s));return s;};
  const sql=[],guards=[],guardArgs=[];
  const id=crypto.randomUUID();
  let result=id;
  const insert=(table,values)=>{const keys=Object.keys(values);sql.push(db.prepare('INSERT INTO '+table+' ('+keys.join(',')+') VALUES ('+keys.map(()=>'?').join(',')+')').bind(...Object.values(values)));};
  const update=(table,row,values)=>{sql.push(db.prepare('UPDATE '+table+' SET '+Object.keys(values).map(k=>k+'=?').join(',')+',version=version+1 WHERE id=?').bind(...Object.values(values),row.id));result=row.id;};
  const row=async(table,key,label)=>{const entry=await one(db,'SELECT * FROM '+table+' WHERE id=?',key||'');if(!entry)stop(label+'不存在',404);return entry;};
  const getScript=id=>row('content_scripts',id,'脚本'),getVersion=id=>row('content_versions',id,'成片'),getPost=id=>row('content_posts',id,'发布记录');
  const getSource=id=>one(db,sourceQuery+' AND c.id=?',id);
  async function claimAllowed(s,site){
    if(s.source!=='creator')return null;
    const grant=await one(db,'SELECT * FROM content_rights WHERE script_id=?',s.id),origin=await getSource(s.source_content_id);
    allowed(reusable(grant,origin,site,at));
    return grant.mode;
  }
  async function createScript(values){
    if(!await one(db,'SELECT sku FROM sku_settings WHERE sku=?',values.sku))stop('请选择后台现有 SKU');
    insert('content_scripts',{id,created_by:actor.id,created_at:at,...values});
  }
  function postValues(version,site,owner,planned,mode,input){
    if(mode==='direct'&&input.localUrl)stop('原版授权不允许替换本地成片');
    const changes=mode==='direct'?'按授权原版发布':field(input.changes,'本地改动（原版可填写原版发布）');
    if(mode==='direct'&&input.changes&&input.changes!=='按授权原版发布')stop('当前授权仅限原版发布');
    return {version_id:version.id,site,owner_id:owner,planned,account:field(field(input.account,'账号',100).replace(/^@/,''),'账号',100).toLowerCase(),local_url:link(input.localUrl,'本地成片链接',true),language:field(input.language,'语言',64),
      traffic:choice(input.traffic,['自然','投流'],'流量类型'),changes,created_at:at};
  }
  async function observe(post,input,metricId,importing=false){
    targetSite(post.site);state(!!post.published_at);
    const days=choice(Number(input.days),[1,7],'观察窗口');
    if(post.original&&days===7)stop('达人原片的 7 天数据从达人模块引用');
    const observed=instant(input.observedAt,'取数时间');
    if(observed>at||Date.parse(observed)<Date.parse(post.published_at)+days*86400000)stop('观察窗口未成熟或取数时间在未来');
    const values={observed_at:observed,views:count(input.views,'播放量'),clicks:count(input.clicks,'商品点击'),
      orders:count(input.orders,'归属订单'),cart_adds:count(input.cartAdds,'加购次数'),retention:count(input.retention,'开头留存率',true),
      evidence:field(input.evidence,'取数依据',600),note:field(input.note,'统计口径或缺失原因',800)};
    const history=await all(db,'SELECT * FROM content_metrics WHERE post_id=? AND days=? ORDER BY revision DESC',post.id,days);
    if(Object.hasOwn(input,'gmv')){
      let amount;
      try{amount=salesMoney(input.gmv,'视频归属GMV');}catch(e){stop(e.message);}
      values.gmv_minor=amount===null?null:Math.round(amount*100);
      values.currency=amount===null?null:choice(input.currency||SITE_CURRENCIES[post.site],SALES_CURRENCIES,'GMV 币种');
    }else{
      values.gmv_minor=history[0]?.gmv_minor??null;
      values.currency=history[0]?.currency??null;
    }
    if(importing&&history.some(row=>Object.entries(values).every(([key,value])=>row[key]===value)))return false;
    expectVersion(post,input);
    if(importing&&history.length&&observed<history[0].observed_at)stop('取数时间早于当前记录，请核对');
    insert('content_metrics',{id:metricId,post_id:post.id,days,revision:(history[0]?.revision||0)+1,...values,actor_id:actor.id});
    return true;
  }
  switch(p.action){
    case 'create':{
      allowed(operator(actor));const source=choice(p.source,Object.keys(sources),'内容来源');
      let origin=null;
      if(source==='creator'){
        origin=await getSource(p.sourceContentId||'');allowed(origin&&ownScopes.includes(origin.scope_id));
        if(await one(db,'SELECT id FROM content_scripts WHERE source_content_id=?',origin.id))stop('该达人视频已经关联',409);
      }
      let parent=null;if(p.parentId){parent=await getVersion(p.parentId);state(parent.status==='已验收'&&!origin);}
      const site=targetSite(origin?.site||p.site),scene=source==='studio'?choice(p.scene,sceneNames.slice(0,3),'拍摄场景'):source==='ai'?'AI 生成':'达人原片';
      const sku=origin?.sku||field(p.sku,'SKU',120),due=day(p.due,'期望交付日');
      const title=field(p.title,'标题',120,true)||[site,sources[source],sku,due].join(' · ');
      await createScript({source,site,sku,title,audience:field(p.audience,'目标顾客',300,true),
        selling_point:field(p.sellingPoint,'主卖点',200,true),brief:field(p.brief,'脚本及必拍镜头',3000,true),due,scene,
        original_count:source==='studio'?originalNumber(p.originalCount??1,100,'原创条数'):1,
        colors:source==='studio'?field(p.colors,'拍摄颜色',200,true):'',directions:source==='studio'?field(p.directions,'内容方向',400,true):'',
        reference_url:source==='studio'?link(p.referenceUrl,'参考视频',true):'',
        owner_id:actor.id,parent_version_id:parent?.id||null,source_content_id:origin?.id||null,status:source==='studio'?'待排期':origin?'已入库':'制作中'});
      if(reference)insert('content_reference_files',{id,object_key:'content-references/'+id,original_name:reference.name,size:reference.bytes.length,content_type:reference.type,sha256:reference.sha256});
      if(origin){
        const versionId=crypto.randomUUID();
        insert('content_versions',{id:versionId,script_id:id,label:'达人原版',storyboard:field(p.brief,'创意说明',3000,true)||title,master_url:origin.url,created_by:actor.id,status:'已验收',created_at:at});
        insert('content_posts',{id:crypto.randomUUID(),version_id:versionId,site,account:origin.platform_id,language:'来源原片',changes:'达人原创',traffic:'待核实',owner_id:actor.id,
          planned:localDay(site,origin.published_at),url:origin.url,video_key:origin.url.match(/\/video\/(\d+)/)?.[1]||null,published_at:origin.published_at,original:1,created_at:at});
      }
      break;
    }
    case 'schedule':{
      allowed(studio(actor));const s=await getScript(p.scriptId);expectVersion(s,p);state(s.source==='studio'&&['待排期','已排期'].includes(s.status));
      const shoot=day(p.shoot,'拍摄日期'),delivery=day(p.delivery,'交付日期');if(delivery<shoot)stop('交付日期须在拍摄日或之后');
      let joint=null;if(p.jointWith){const other=await getScript(p.jointWith);state(other.id!==s.id&&other.sku===s.sku&&other.source==='studio'&&other.shoot_date===shoot&&!other.joint_with);joint=other.id;}
      const shooter=p.studioUserId||(actor.role==='拍摄剪辑'?actor.id:s.studio_user_id)||null;
      if(shooter){
        allowed(manager(actor)||shooter===actor.id);
        state(await one(db,"SELECT id FROM users WHERE id=? AND role='拍摄剪辑' AND active=1",shooter));
        guards.push("EXISTS(SELECT 1 FROM users WHERE id=? AND role='拍摄剪辑' AND active=1)");guardArgs.push(shooter);
      }
      update('content_scripts',s,{studio_user_id:shooter,status:'已排期',shoot_date:shoot,delivery_date:delivery,joint_with:joint});break;
    }
    case 'deliver':{
      const s=await getScript(p.scriptId);expectVersion(s,p);state(s.source!=='creator'&&(s.source==='ai'||!!s.shoot_date));
      allowed(s.source==='studio'?studio(actor):operator(actor)&&writeSites.includes(s.site));
      if(s.source==='ai'&&p.productChecked!==true)stop('请核对实物及 AI 内容标识');
      const originalNo=originalNumber(p.originalNo??(s.original_count===1?1:null),s.original_count,'原创序号');
      insert('content_versions',{id,script_id:s.id,original_no:originalNo,label:field(p.label,'版本名称',100),storyboard:field(p.storyboard,'成片脚本'),master_url:link(p.master,'母版／成片链接'),
        raw_url:link(p.raw,'原始镜头链接',true),prompt:s.source==='ai'?field(p.prompt,'AI 提示词'):'',
        product_ref:s.source==='ai'?link(p.productRef,'实物参考链接'):'',created_by:actor.id,status:'待验收',created_at:at});
      update('content_scripts',s,{status:'待验收'});result=id;break;
    }
    case 'accept':case 'return':{
      const v=await getVersion(p.versionId),s=await getScript(v.script_id);expectVersion(v,p);allowed(operator(actor)&&writeSites.includes(s.site));
      state(v.status==='待验收');const accepted=p.action==='accept';
      const pending=await one(db,"SELECT id FROM content_versions WHERE script_id=? AND id<>? AND status='待验收'",s.id,v.id);
      const acceptedSlots=await all(db,"SELECT DISTINCT original_no FROM content_versions WHERE script_id=? AND status='已验收'",s.id);
      const finished=new Set(acceptedSlots.map(row=>row.original_no));
      if(accepted)finished.add(v.original_no);
      const complete=finished.size>=s.original_count;
      const needsRetake=await one(db,"SELECT id FROM content_versions v WHERE script_id=? AND status='退回修改' AND NOT EXISTS(SELECT 1 FROM content_versions newer WHERE newer.script_id=v.script_id AND newer.original_no=v.original_no AND newer.status='已验收') AND original_no<>? LIMIT 1",s.id,v.original_no);
      update('content_scripts',s,{status:pending?'待验收':complete?'已入库':!accepted||needsRetake?'待改拍':'已排期'});
      update('content_versions',v,{status:accepted?'已验收':'退回修改',feedback:field(p.feedback,'验收意见',1000,accepted)});break;
    }
    case 'rights':{
      allowed(manager(actor));const s=await getScript(p.scriptId);expectVersion(s,p);state(s.source==='creator');
      const mode=choice(p.mode,['reference','direct','edit'],'素材使用范围'),origin=await getSource(s.source_content_id);
      if(!origin&&mode!=='reference')stop('来源视频需重新验收');
      const selected=Array.isArray(p.sites)?[...new Set(p.sites.map(x=>choice(x,sites,'授权站点')))]:[];
      if(mode!=='reference'&&!selected.length)stop('请选择获授权站点');
      const end=mode==='reference'?null:day(p.end,'授权截止日'),evidence=field(p.evidence,'授权依据或撤销说明',1500);
      sql.push(db.prepare(`INSERT INTO content_rights VALUES(?,?,?,?,?,?,?) ON CONFLICT(script_id) DO UPDATE SET mode=excluded.mode,sites=excluded.sites,end_date=excluded.end_date,evidence=excluded.evidence,actor_id=excluded.actor_id,source_version=excluded.source_version`).bind(s.id,mode,selected.join(','),end,evidence,actor.id,origin?.version||0));
      update('content_scripts',s,{status:s.status});break;
    }
    case 'claim':{
      const v=await getVersion(p.versionId),s=await getScript(v.script_id);state(v.status==='已验收');
      const site=targetSite(p.site),mode=await claimAllowed(s,site);
      insert('content_posts',{id,...postValues(v,site,actor.id,day(p.planned,'计划发布日期'),mode,p)});break;
    }
    case 'publish':{
      const post=await getPost(p.postId),v=await getVersion(post.version_id),s=await getScript(v.script_id);
      targetSite(post.site);allowed(manager(actor)||post.owner_id===actor.id);expectVersion(post,p);state(!post.published_at&&v.status==='已验收');
      const mode=await claimAllowed(s,post.site);
      if(mode==='direct'&&post.changes!=='按授权原版发布')stop('授权已调整，请重新认领原版');
      const published=instant(p.publishedAt,'发布时间');if(published>at)stop('发布时间不能晚于现在');
      const url=video(p.url);
      if(new URL(url.url).pathname.split('/')[1].slice(1).toLowerCase()!==post.account.toLowerCase())stop('视频链接账号与认领账号不一致');
      if(await one(db,'SELECT id FROM content_posts WHERE video_key=? OR url=?',url.key,url.url))stop('此视频已登记，不能重复发布',409);
      update('content_posts',post,{url:url.url,video_key:url.key,published_at:published});break;
    }
    case 'observe':{
      const post=await getPost(p.postId);
      await observe(post,p,id);
      update('content_posts',post,{created_at:post.created_at});result=id;break;
    }
    case 'importPlatformReport':{
      const file=field(p.file,'来源文件',255),changes=await reportChanges(db,actor,p,at);
      for(const [index,row] of changes.entries()){
        const expected=p.rows[index].expectedRevision;
        if((p.clearMissing===true||expected!==undefined)&&row.revision!==expected)stop('报表版本已变化，请重新核对差异',409);
        if(!row.changed)continue;
        insert('content_platform_reports',{site:p.site,start_day:p.start,end_day:p.end,video_id:row.videoId,revision:row.revision+1,currency:p.currency,
          metrics_json:JSON.stringify(row.metrics),source_file:file,actor_id:actor.id,created_at:at});
      }
      break;
    }
    case 'importMetrics':{
      allowed(operator(actor)&&writeSites.length);
      const seen=new Set(),changed=new Map();
      for(const [index,input] of p.rows.entries()){
        try{
          if(!input||typeof input!=='object')stop('无效的数据行');
          const record=video(input.url);
          const post=await one(db,'SELECT * FROM content_posts WHERE video_key=? AND url=?',record.key,record.url);
          if(!post||!writeSites.includes(post.site))stop('在可维护站点中找不到该发布链接');
          const key=post.id+'/'+Number(input.days);
          if(seen.has(key))stop('同一视频和观察窗口在表内重复');
          seen.add(key);
          if(await observe(post,input,crypto.randomUUID(),true))changed.set(post.id,post);
        }catch(error){stop('第 '+(Number.isSafeInteger(input?.line)&&input.line>=2?input.line:index+2)+' 行：'+error.message,error.status||400);}
      }
      for(const post of changed.values())update('content_posts',post,{created_at:post.created_at});
      result=id;break;
    }
    case 'review':{
      const post=await getPost(p.postId),v=await getVersion(post.version_id),base=await getScript(v.script_id);
      state(!!post.published_at);allowed(studio(actor)||writeSites.includes(post.site));
      const decision=choice(p.decision,decisions,'复盘决定'),change=field(p.change,'下一步动作'),site=choice(p.site,sites,'执行站点'),due=day(p.due,'验证日期');
      allowed(studio(actor)||writeSites.includes(site));
      const owner=await row('users',p.ownerId,'执行人');allowed(owner.active&&operator(owner)&&writes(owner).includes(site));
      guards.push('EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=? AND site IS ? AND channel IS ?)');guardArgs.push(owner.id,owner.role,owner.site,owner.channel);
      const reviewId=crypto.randomUUID();let child=null,plan=null;
      if(decision==='复拍'){
        await createScript({source:'studio',site,sku:base.sku,title:('复拍 · '+base.title).slice(0,120),parent_version_id:v.id,audience:base.audience,selling_point:base.selling_point,brief:change,
          due,scene:choice(p.scene,sceneNames.slice(0,3),'复拍场景'),owner_id:owner.id,source_content_id:null,status:'待排期'});child=id;
      }else if(decision==='跨站测试'){
        if(post.site===site)stop('跨站测试请选择其他站点');
        const mode=await claimAllowed(base,site);
        insert('content_posts',{id,...postValues(v,site,owner.id,due,mode,p)});plan=id;
      }
      insert('content_reviews',{id:reviewId,post_id:post.id,decision,finding:field(p.finding,'实际表现'),hypothesis:field(p.hypothesis,'原因假设'),change_note:change,
        site,owner_id:owner.id,due,next_script_id:child,next_post_id:plan,created_by:actor.id,created_at:at});result=reviewId;break;
    }
    default:stop('未知操作');
  }
  const guard=["NOT EXISTS(SELECT 1 FROM system_maintenance WHERE id='global' AND mode<>'normal' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    'EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=? AND site IS ? AND channel IS ?)',
    '(SELECT COALESCE(MAX(seq),0) FROM content_events)=?',"(SELECT COALESCE(MAX(version),0) FROM creator_clock WHERE id='global')=?",...guards].join(' AND ');
  insert('content_events',{operation_id:operation,actor_id:actor.id,action:p.action,fingerprint:hash,result_id:result,created_at:at});
  if(reference)await attachment.bucket.put('content-references/'+id,reference.bytes,{httpMetadata:{contentType:reference.type}});
  try{await atomicBatch(db,[guardStatement(db,actor,'content.'+p.action,guard,[actor.id,actor.role,actor.site,actor.channel,clocks.seq,clocks.creator,...guardArgs]),...sql]);}
  catch(err){
    if(reference&&!await one(db,'SELECT id FROM content_reference_files WHERE id=?',id))await attachment.bucket.delete('content-references/'+id);
    const saved=await replay();if(saved)return saved;if(/UNIQUE constraint/.test(String(err)))stop('记录已存在，请刷新核对',409);throw err;}
  return {id:result};
}
