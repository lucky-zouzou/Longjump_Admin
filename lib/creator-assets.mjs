import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {fail,required,link,instant,financeValue} from './creator-model.mjs';
import {assetKey,buildCreatorAssets,capabilityFormats,replicationSummary} from './creator-assets-model.mjs';
const all=async(db,sql,args=[]) => (await db.prepare(sql).bind(...args).all()).results;
const parse=r=>({...r,data:JSON.parse(r.data_json||'{}')});
const isReviewer=a=>['管理员','运营主管'].includes(a.role);
const editable=a=>['管理员','运营','达人BD'].includes(a.role);
const visible=(a,s)=>['管理员','运营主管','财务'].includes(a.role)||(a.role==='达人BD'&&s.bd_id===a.id)||(a.role==='运营'&&[s.operator_id,s.backup_id].includes(a.id));
const keySql='a.site=s.site AND a.platform=s.platform AND a.platform_id=p.platform_id';
export const libraryActions=['capability','caseCreate','caseRevise','caseReview','caseArchive'];

export async function readCreatorLibrary(db,actor,snapshot){
 const keys=new Set(snapshot.profiles.map(assetKey)),assets=buildCreatorAssets((await all(db,'SELECT * FROM creator_assets')).filter(a=>keys.has(assetKey(a))),snapshot),assetIds=new Set(assets.map(a=>a.id));
 const history=(await all(db,'SELECT * FROM creator_asset_history ORDER BY revision DESC')).filter(h=>assetIds.has(h.asset_id)).map(parse);
 const allRounds=(await all(db,'SELECT * FROM creator_rounds')).map(r=>({...r,terms:JSON.parse(r.terms_json)})),allFinance=(await all(db,'SELECT * FROM creator_finance')).map(parse),allContents=await all(db,'SELECT id,url FROM creator_contents');
 const books=await all(db,'SELECT b.*,a.site,a.platform FROM creator_playbooks b JOIN creator_assets a ON a.id=b.asset_id ORDER BY b.updated_at DESC');
 const pids=new Set(snapshot.profiles.map(p=>p.id)),visibleBooks=[];
 for(const row of books){
  const source=allRounds.find(r=>r.id===row.round_id),sourceVisible=source&&pids.has(source.creator_id);
  if(row.status!=='approved'&&!sourceVisible&&!isReviewer(actor))continue;
  const current=source&&financeValue(source,allFinance),sourceFresh=source?.status==='completed'&&source.version===row.source_version&&(current?.id||null)===row.finance_id;
  const uses=snapshot.rounds.filter(r=>r.terms.playbookId===row.id);
  visibleBooks.push({id:row.id,title:row.title,status:row.status,data:JSON.parse(row.data_json),site:row.site,platform:row.platform,version:row.version,author_id:row.author_id,updated_at:row.updated_at,sourceFresh,sourceVerified:Boolean(current),sourceVisible,sourceCreatorId:sourceVisible?source.creator_id:null,sourceRoundId:sourceVisible?source.id:null,sourceContentUrl:allContents.find(c=>c.id===row.content_id)?.url,sourceSkus:source?.terms.items?.map(i=>i.sku)||[],sourceProfitCny:sourceVisible&&current?current.data.profitCnyMinor/100:null,replication:replicationSummary(uses,snapshot.finances),uses:uses.map(r=>({id:r.id,creatorId:r.creator_id,roundNo:r.round_no,status:r.status,adaptation:r.terms.adaptation,completedAt:r.completed_at}))});
 }
 const auditable=new Set(visibleBooks.filter(b=>b.sourceVisible||isReviewer(actor)).map(b=>b.id));
 const playbookHistory=(await all(db,'SELECT * FROM creator_playbook_history ORDER BY created_at DESC')).filter(h=>auditable.has(h.playbook_id)).map(h=>({id:h.id,playbookId:h.playbook_id,revision:h.revision,action:h.action,actor:h.actor_name,at:h.created_at,note:JSON.parse(h.snapshot_json).note}));
 return {assets,assetHistory:history,playbooks:visibleBooks,playbookHistory};
}

export async function mutateCreatorLibrary(db,actor,p){
 if(!['管理员','运营','运营主管','达人BD','财务'].includes(actor.role))fail('当前岗位没有达人库权限',403);
 await assertWritable(db);
 const clock=await db.prepare("SELECT version FROM creator_clock WHERE id='global'").first(),user=await db.prepare('SELECT role,active FROM users WHERE id=?').bind(actor.id).first();
 if(!user||!user.active||user.role!==actor.role)fail('账号权限已变化',403);
 const now=new Date().toISOString(),statements=[],action=p.action;
 const put=(table,values)=>{const keys=Object.keys(values);statements.push(db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).bind(...keys.map(k=>values[k])));};
 const update=(table,id,values)=>{const keys=Object.keys(values);statements.push(db.prepare(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')},version=version+1,updated_at=? WHERE id=?`).bind(...keys.map(k=>values[k]),now,id));};
 const check=(row)=>{if(!row||row.version!==Number(p.version))fail('资料已更新，请刷新重试',409);};
 const scopes=await all(db,'SELECT * FROM creator_scopes'),profiles=await all(db,'SELECT * FROM creator_profiles');
 const canProfile=id=>{const profile=profiles.find(x=>x.id===id);return profile&&visible(actor,scopes.find(s=>s.id===profile.scope_id));};
 let resultId;
 if(action==='capability'){
  if(!editable(actor))fail('当前岗位不能维护能力画像',403);
  const asset=await db.prepare('SELECT * FROM creator_assets WHERE id=?').bind(required(p.assetId,'达人资产')).first();check(asset);
  const linked=await all(db,`SELECT p.id FROM creator_profiles p JOIN creator_scopes s ON s.id=p.scope_id JOIN creator_assets a ON ${keySql} WHERE a.id=?`,[asset.id]);
  if(!linked.some(p=>canProfile(p.id)))fail('没有该达人画像权限',403);
  if(!Array.isArray(p.formats)||!p.formats.length||p.formats.some(v=>!Object.hasOwn(capabilityFormats,v)))fail('请选择有依据的内容能力');
  const asOf=instant(p.at,'能力核验时间');if(asOf>now)fail('能力核验时间不能晚于现在');
  const data={languages:required(p.languages,'可合作语言',200),formats:[...new Set(p.formats)],categories:required(p.categories,'适配品类',300),audience:required(p.audience,'受众与市场适配依据'),priceFit:required(p.priceFit,'适配价格带及币种'),strengths:required(p.strengths,'擅长方法与例子'),limits:required(p.limits,'能力边界与不适用场景'),evidence:link(p.evidence),asOf,reviewStatus:actor.role==='运营'?'pending':'reviewed',reviewer:actor.name,reason:required(p.note,'本次更新依据')};
  update('creator_assets',asset.id,{data_json:JSON.stringify(data)});
  put('creator_asset_history',{id:crypto.randomUUID(),asset_id:asset.id,revision:asset.version+1,data_json:JSON.stringify(data),actor_id:actor.id,actor_name:actor.name,created_at:now});resultId=asset.id;
 }else{
  let book=action==='caseCreate'?null:await db.prepare('SELECT * FROM creator_playbooks WHERE id=?').bind(required(p.playbookId,'经验案例')).first();
  if(action!=='caseCreate')check(book);
  const roundId=book?.round_id||required(p.roundId,'来源合作'),round=await db.prepare('SELECT * FROM creator_rounds WHERE id=?').bind(roundId).first();
  if(!round)fail('来源合作不存在',404);
  const profile=profiles.find(x=>x.id===round.creator_id),scope=scopes.find(s=>s.id===profile.scope_id);
  const asset=await db.prepare('SELECT * FROM creator_assets WHERE site=? AND platform=? AND platform_id=?').bind(scope.site,scope.platform,profile.platform_id).first();
  if(!asset)fail('达人资产不存在',404);
  const finances=(await all(db,'SELECT * FROM creator_finance WHERE round_id=?',[round.id])).map(parse),finance=financeValue(round,finances);
  let values,note;
  if(action==='caseCreate'||action==='caseRevise'){
   if(!editable(actor)||!canProfile(profile.id))fail('没有该合作经验录入权限',403);
   if(round.status!=='completed')fail('先完成内容验收与交付，再沉淀可复用经验');
   if(book&&!['pending','returned'].includes(book.status))fail('已入库经验不能覆盖，请另建新案例或停用旧案例');
   if(action==='caseCreate'&&Number(p.version)!==round.version)fail('来源合作已变化，请刷新',409);
   const content=await db.prepare("SELECT id,url FROM creator_contents WHERE id=? AND round_id=? AND status='accepted'").bind(required(p.contentId,'已验收内容'),round.id).first();if(!content)fail('请选择本轮已验收的视频或直播');
   if(p.shareConfirmed!==true)fail('请确认经验内容可供公司五站复用，不含私人联系方式或未获授权素材');
   const data={audience:required(p.audience,'目标受众与适配场景'),method:required(p.method,'具体执行步骤'),hook:required(p.hook,'内容开头或直播话术方法'),sellingPoints:required(p.sellingPoints,'卖点与展示方式'),conditions:required(p.conditions,'成功前提与适用条件'),limits:required(p.limits,'不适用场景与风险'),replicate:required(p.replicate,'复用验证方案'),evidence:link(p.evidence),shareConfirmed:true};
   values={title:required(p.title,'案例标题',150),content_id:content.id,data_json:JSON.stringify(data),status:'pending',author_id:actor.id,reviewer_id:null,source_version:round.version,finance_id:finance?.id||null};note='提交经验审核';
  }else if(action==='caseReview'){
   if(!isReviewer(actor))fail('仅管理员或运营主管可审核经验',403);if(book.author_id===actor.id)fail('案例作者不能自行审核');
   if(book.status==='archived')fail('已停用案例不能重新发布，请建立新版本案例');
   if(!['approve','return'].includes(p.decision))fail('请选择通过或退回');
   if(p.decision==='approve'&&round.status!=='completed')fail('来源交付尚未完成');
   if(p.decision==='approve'&&!await db.prepare("SELECT id FROM creator_contents WHERE id=? AND round_id=? AND status='accepted'").bind(book.content_id,round.id).first())fail('来源内容尚未验收');
   values={status:p.decision==='approve'?'approved':'returned',reviewer_id:actor.id,source_version:round.version,finance_id:finance?.id||null};note=required(p.note,'审核意见与适用边界');
  }else if(action==='caseArchive'){
   if(!isReviewer(actor))fail('仅管理员或运营主管可停用经验',403);if(book.status==='archived')fail('案例已停用');values={status:'archived',reviewer_id:actor.id};note=required(p.note,'停用原因');
  }else fail('不支持的达人库操作');
  if(!book){resultId=crypto.randomUUID();book={id:resultId,asset_id:asset.id,round_id:round.id,version:1,...values,created_at:now,updated_at:now};put('creator_playbooks',book);}
  else{resultId=book.id;update('creator_playbooks',book.id,values);book={...book,...values,version:book.version+1};}
  put('creator_playbook_history',{id:crypto.randomUUID(),playbook_id:book.id,revision:book.version,action,snapshot_json:JSON.stringify({...book,note}),actor_id:actor.id,actor_name:actor.name,created_at:now});
 }
 await atomicBatch(db,[guardStatement(db,actor,'creator.'+action,"COALESCE((SELECT version FROM creator_clock WHERE id='global'),0)=?",[clock?.version||0]),...statements]);
 return {ok:true,id:resultId};
}

export async function validatePlaybookReference(db,p){
 if(!p.playbookId)return {};
 const book=await db.prepare('SELECT * FROM creator_playbooks WHERE id=?').bind(required(p.playbookId,'参考案例')).first();
 if(!book||book.status!=='approved')fail('仅可引用已审核入库且未停用的经验');
 const source=await db.prepare('SELECT * FROM creator_rounds WHERE id=?').bind(book.round_id).first(),finances=(await all(db,'SELECT * FROM creator_finance WHERE round_id=?',[book.round_id])).map(parse),finance=financeValue(source,finances);
 if(source.status!=='completed'||source.version!==book.source_version||(finance?.id||null)!==book.finance_id)fail('来源合作或核算已变化，请先复核经验再引用');
 return {playbookId:book.id,playbookVersion:book.version,playbookTitle:book.title,adaptation:required(p.adaptation,'本次适配调整与验证指标')};
}
