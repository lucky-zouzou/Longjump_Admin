import {canonicalId,fail,integer,minor,link,required,txt} from './creator-model.mjs';

export const intakeRequests={profile:'达人资料建档',sample:'再次寄样',sku:'新增SKU合作',maintenance:'申请组长深度维护',paid:'申请付费合作',live:'直播合作支持',other:'其他'};
export const intakeStatuses={pending:'待组长处理',queued:'已安排跟进',returned:'待运营补充',accepted:'已接收待执行'};
export const intakeGrades={S:'S · 重点潜力',A:'A · 优质',B:'B · 普通',C:'C · 观察'};
export const intakeStyles=['真人出镜+口播+产品展示','非垂类但是出单','简单展示','常规开箱视频（账号统一口播）','真人出镜+产品展示，不口播','会自己根据产品创作','会发布3条视频以上'];
export const intakeHeaders=['创建日期','月份','国家','达人id','TK主页链接','达人联系方式','达人类型','合作方式','粉丝数','近30天有效订单','近30天GMV','GMV币种','平均播放量','达人分类','运营评估等级','视频风格/视频类型评估（多选，逗号分隔）','本次需求','申请SKU','申请原因','数据佐证链接','达人名称','沟通语言'];
const currencyCodes=['CNY','IDR','MYR','THB','VND','PHP','USD'];
const optionalInt=(v,label)=>v==null||v===''?null:integer(v,label);
export function intakeDate(value,label='创建日期'){
 const date=txt(value).replaceAll('/','-');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)fail(label+'无效，请用 YYYY-MM-DD');
 return date;
}
export function normalizeIntake(p,today){
 const submittedOn=intakeDate(p.submittedOn);if(submittedOn>today)fail('创建日期不能晚于当地今天');
 if(p.month&&p.month!==submittedOn.slice(0,7))fail('月份须与创建日期一致');
 const requestKind=p.requestKind||'profile';if(!intakeRequests[requestKind])fail('提交需求无效');
 const grade=p.grade||'';if(grade&&!intakeGrades[grade])fail('评估等级无效');
 const kind=p.kind||'';if(kind&&!['video','live','both'].includes(kind))fail('达人类型无效');
 const method=p.method||'';if(method&&!['commission','paid','mixed'].includes(method))fail('合作方式无效');
 const category=p.category||'';if(category&&!['active','occasional','unverified'].includes(category))fail('达人分类无效');
 const styles=p.styles||[];if(!Array.isArray(styles)||styles.some(s=>!intakeStyles.includes(s)))fail('视频风格无效');
 const gmvMinor=p.gmv==null||p.gmv===''?null:minor(p.gmv,'近30天GMV'),currency=p.currency||'';
 if(gmvMinor!==null&&!currencyCodes.includes(currency)||currency&&!currencyCodes.includes(currency))fail('GMV须明确原币种，旧模板“元”不能自动当人民币');
 return {submittedOn,month:submittedOn.slice(0,7),platformId:canonicalId(p.platformId),profileUrl:link(p.profileUrl,'达人主页'),name:txt(p.name,120),contact:txt(p.contact,500),language:txt(p.language,100),grade,kind,method,category,styles:[...new Set(styles)].sort(),followers:optionalInt(p.followers,'粉丝数'),orders:optionalInt(p.orders,'近30天有效订单'),gmvMinor,currency,views:optionalInt(p.views,'平均播放量'),requestKind,sku:txt(p.sku,150),reason:requestKind==='profile'?txt(p.reason):required(p.reason,'申请原因'),evidence:p.evidence?link(p.evidence,'数据佐证'):''};
}
export function mapIntakeRow(row,defaults={}){
 const pick=(...keys)=>{for(const k of keys)if(row[k]!=null&&row[k]!=='')return String(row[k]).trim();return '';};
 const type=pick('达人类型','合作类型'),method=pick('合作方式'),category=pick('达人分类'),request=pick('本次需求','本次提交需求'),styles=pick('视频风格/视频类型评估（多选，逗号分隔）','视频风格','视频风格/视频类型评估');
 // Protect the comma contained in this particular style before splitting CSV multi-values.
 const token='__NO_SPEECH__',parts=styles.replaceAll('真人出镜+产品展示，不口播',token).split(/[,，;；|\n]/).map(x=>x.trim().replace(token,'真人出镜+产品展示，不口播')).filter(Boolean);
 return {scopeId:defaults.scopeId,site:pick('国家'),submittedOn:pick('创建日期'),month:pick('月份'),platformId:pick('达人id','达人ID','TikTok ID','达人 TikTok ID'),profileUrl:pick('TK主页链接','TikTok主页链接','主页链接'),contact:pick('达人联系方式','联系方式'),name:pick('达人名称'),language:pick('沟通语言'),kind:({'视频':'video','直播':'live','视频＋直播':'both','视频+直播':'both'})[type]||type,method:({'纯佣':'commission','付费':'paid','纯佣+付费':'mixed','纯佣＋付费':'mixed'})[method]||method,category:({'出单且勤快':'active','出单不勤快':'occasional','出单但不勤快':'occasional','待核实':'unverified'})[category]||category,grade:pick('运营评估等级').slice(0,1),followers:pick('粉丝数'),orders:pick('近30天有效订单'),gmv:pick('近30天GMV','近30天GMV（元）'),currency:pick('GMV币种','币种')||defaults.currency||'',views:pick('平均播放量'),styles:parts,requestKind:Object.keys(intakeRequests).find(k=>intakeRequests[k]===request)||request||'profile',sku:pick('申请SKU','申请产品 / SKU'),reason:pick('申请原因','运营评估 / 申请原因'),evidence:pick('数据佐证链接','证据链接')};
}
export function collaborationStage(profile,rounds=[]){
 if(profile.state==='paused')return '暂停维护';
 if(profile.state==='handoff')return '待移交';
 if(rounds.some(r=>r.creator_id===profile.id&&['approved','executing'].includes(r.status)))return '待回收内容';
 if(profile.accepted_at)return '深度维护';
 return '运营建联';
}
