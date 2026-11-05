import {assertWritable, atomicBatch, guardStatement} from './atomic.mjs';
import {hasPermission} from './permissions.mjs';
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
export async function readCenter(db,identity){
  const actor=await who(db,identity),{writes,ownScopes}=await access(db,actor),at=nowISO();
  const [scripts,versions,posts,metrics,reviews,rights,sourceRows,external,people,skus]=await Promise.all([
    all(db,'SELECT * FROM content_scripts ORDER BY created_at DESC'),all(db,'SELECT * FROM content_versions ORDER BY created_at DESC'),
    all(db,'SELECT * FROM content_posts ORDER BY created_at DESC'),all(db,'SELECT * FROM content_metrics ORDER BY revision DESC'),
    all(db,'SELECT * FROM content_reviews ORDER BY created_at DESC'),all(db,'SELECT * FROM content_rights'),
    all(db,sourceQuery),all(db,`SELECT o.content_id,o.window_days days,o.revision,o.observed_at,
      json_extract(o.data_json,'$.views') views,json_extract(o.data_json,'$.clicks') clicks,json_extract(o.data_json,'$.orders') orders
      FROM creator_observations o JOIN content_scripts s ON s.source_content_id=o.content_id ORDER BY o.revision DESC`),
    all(db,"SELECT id,name,role,site,channel FROM users WHERE active=1 AND role IN ('管理员','运营主管','运营','拍摄剪辑') ORDER BY name"),
    all(db,'SELECT sku,name FROM sku_settings ORDER BY sku')
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

export async function mutateCenter(db,identity,p){
  if(!p||typeof p!=='object'||Array.isArray(p))stop('表单格式无效');
  const operation=field(p.operationId,'提交编号',80),actor=await who(db,identity);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(p,Object.keys(p).sort())))),n=>n.toString(16).padStart(2,'0')).join('');
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
      await createScript({source,site,sku:origin?.sku||field(p.sku,'SKU',120),title:field(p.title,'标题',120),audience:field(p.audience,'目标顾客',300),
        selling_point:field(p.sellingPoint,'主卖点',200),brief:field(p.brief,'脚本及必拍镜头'),due:day(p.due,'期望交付日'),scene,
        owner_id:actor.id,parent_version_id:parent?.id||null,source_content_id:origin?.id||null,status:source==='studio'?'待排期':origin?'已入库':'制作中'});
      if(origin){
        const versionId=crypto.randomUUID();
        insert('content_versions',{id:versionId,script_id:id,label:'达人原版',storyboard:field(p.brief,'创意说明'),master_url:origin.url,created_by:actor.id,status:'已验收',created_at:at});
        insert('content_posts',{id:crypto.randomUUID(),version_id:versionId,site,account:origin.platform_id,language:'来源原片',changes:'达人原创',traffic:'待核实',owner_id:actor.id,
          planned:localDay(site,origin.published_at),url:origin.url,video_key:origin.url.match(/\/video\/(\d+)/)?.[1]||null,published_at:origin.published_at,original:1,created_at:at});
      }
      break;
    }
    case 'schedule':{
      allowed(studio(actor));const s=await getScript(p.scriptId);expectVersion(s,p);state(s.source==='studio'&&['待排期','已排期'].includes(s.status));
      const shoot=day(p.shoot,'拍摄日期'),delivery=day(p.delivery,'交付日期');if(delivery<shoot)stop('交付日期须在拍摄日或之后');
      let joint=null;if(p.jointWith){const other=await getScript(p.jointWith);state(other.id!==s.id&&other.sku===s.sku&&other.source==='studio'&&other.shoot_date===shoot&&!other.joint_with);joint=other.id;}
      update('content_scripts',s,{status:'已排期',shoot_date:shoot,delivery_date:delivery,joint_with:joint});break;
    }
    case 'deliver':{
      const s=await getScript(p.scriptId);expectVersion(s,p);state(s.source!=='creator'&&(s.source==='ai'||!!s.shoot_date));
      allowed(s.source==='studio'?studio(actor):operator(actor)&&writeSites.includes(s.site));
      if(s.source==='ai'&&p.productChecked!==true)stop('请核对实物及 AI 内容标识');
      insert('content_versions',{id,script_id:s.id,label:field(p.label,'版本名称',100),storyboard:field(p.storyboard,'成片脚本'),master_url:link(p.master,'母版／成片链接'),
        raw_url:link(p.raw,'原始镜头链接',true),prompt:s.source==='ai'?field(p.prompt,'AI 提示词'):'',
        product_ref:s.source==='ai'?link(p.productRef,'实物参考链接'):'',created_by:actor.id,status:'待验收',created_at:at});
      update('content_scripts',s,{status:'待验收'});result=id;break;
    }
    case 'accept':case 'return':{
      const v=await getVersion(p.versionId),s=await getScript(v.script_id);expectVersion(v,p);allowed(operator(actor)&&writeSites.includes(s.site));
      state(v.status==='待验收');const accepted=p.action==='accept';
      const pending=await one(db,"SELECT id FROM content_versions WHERE script_id=? AND id<>? AND status='待验收'",s.id,v.id);
      update('content_scripts',s,{status:pending?'待验收':accepted?'已入库':'待改拍'});
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
      const post=await getPost(p.postId);targetSite(post.site);expectVersion(post,p);state(!!post.published_at);
      const days=choice(Number(p.days),[1,7],'观察窗口');if(post.original&&days===7)stop('达人原片的 7 天数据从达人模块引用');
      const observed=instant(p.observedAt,'取数时间');
      if(observed>at||Date.parse(observed)<Date.parse(post.published_at)+days*86400000)stop('观察窗口未成熟或取数时间在未来');
      const prev=await one(db,'SELECT MAX(revision) rev FROM content_metrics WHERE post_id=? AND days=?',post.id,days);
      insert('content_metrics',{id,post_id:post.id,days,revision:(prev.rev||0)+1,observed_at:observed,views:count(p.views,'播放量'),clicks:count(p.clicks,'商品点击'),
        orders:count(p.orders,'归属订单'),retention:count(p.retention,'开头留存率',true),evidence:field(p.evidence,'取数依据',600),note:field(p.note,'统计口径或缺失原因',800),actor_id:actor.id});
      update('content_posts',post,{created_at:post.created_at});result=id;break;
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
  try{await atomicBatch(db,[guardStatement(db,actor,'content.'+p.action,guard,[actor.id,actor.role,actor.site,actor.channel,clocks.seq,clocks.creator,...guardArgs]),...sql]);}
  catch(err){const saved=await replay();if(saved)return saved;if(/UNIQUE constraint/.test(String(err)))stop('记录已存在，请刷新核对',409);throw err;}
  return {id:result};
}
