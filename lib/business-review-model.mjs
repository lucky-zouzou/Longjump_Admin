export class ReviewError extends Error{constructor(message,status=400){super(message);this.status=status;}}
export const reviewToday=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export const addDays=(date,n)=>new Date(Date.parse(date)+n*86400000).toISOString().slice(0,10);
export function validReviewDate(value){return typeof value==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function reviewPeriod(kind,date,today=reviewToday(),anchor='2026-10-03'){
 if(!['weekly','monthly'].includes(kind)||!validReviewDate(date)||date>addDays(today,7))throw new ReviewError('请选择有效报告日期（最多提前一周）');
 if(!validReviewDate(anchor)||![5,6].includes(new Date(anchor).getUTCDay()))throw new ReviewError('请设置有效的周五或周六大小休基准日');
 const monday=d=>addDays(d,-((new Date(d).getUTCDay()+6)%7));
 const weeks=Math.round((Date.parse(monday(date))-Date.parse(monday(anchor)))/604800000),alternate=((weeks%2)+2)%2;
 const deadline=addDays(monday(date),new Date(anchor).getUTCDay()===5?(alternate?5:4):(alternate?4:5));
 const start=kind==='weekly'?addDays(deadline,-7):date.slice(0,7)+'-01';
 const end=kind==='weekly'?addDays(deadline,-1):new Date(Date.UTC(Number(start.slice(0,4)),Number(start.slice(5,7)),0)).toISOString().slice(0,10);
 const asOf=[end,addDays(today,-1)].sort()[0];
 return {kind,start,end,deadline:kind==='weekly'?deadline:start.slice(0,7)+'-28',asOf:asOf<start?null:asOf,dueAt:kind==='weekly'?deadline+'T07:00:00.000Z':start.slice(0,7)+'-28T15:59:59.999Z',meetingDate:kind==='monthly'?start.slice(0,7)+'-28':null,partial:asOf<end};
}

const metric=(key,label,unit='个',direction='up')=>({key,label,unit,direction});
const common=[metric('gmv','平台 GMV','币种'),metric('orders','支付订单数','单'),metric('visitors','访客数','人'),metric('adGmv','广告归因 GMV','币种'),metric('adSpend','平台广告消耗（同归因口径）','币种'),metric('refundGmv','退款金额','币种','down'),metric('cancelGmv','取消金额','币种','down')];
export function reviewMetrics(channel){return channel==='线下分销'?[metric('newLeads','新增有效商机','家'),metric('quotes','报价客户','家')]:channel==='TikTok'?[...common,metric('content','内容发布总数','条'),metric('creatorVideos','达人视频','条'),metric('aiVideos','AI 视频','条'),metric('originalVideos','原创视频','条'),metric('liveSessions','直播场次','场'),metric('liveHours','直播时长','小时'),metric('liveGmv','直播 GMV','币种')]:[...common,metric('naturalGmv','平台自然 GMV','币种'),metric('ctrBefore','优化前点击率','%'),metric('ctrAfter','优化后点击率','%'),metric('cvrBefore','优化前转化率','%'),metric('cvrAfter','优化后转化率','%'),metric('impressions','商品曝光','次'),metric('clicks','商品点击','次'),metric('creativeOptimized','素材优化数','条'),metric('productOptimized','商品优化数','个'),metric('campaigns','活动场次','场'),metric('campaignVisitors','活动访客','人'),metric('campaignOrders','活动订单','单'),metric('campaignGmv','活动 GMV','币种')];}
export const ratio=(a,b)=>a==null||b==null||b<=0?null:a/b;
export function derivedReviewMetrics(values,adCost){return {aov:ratio(values.gmv,values.orders),conversion:ratio(values.orders,values.visitors),ctr:ratio(values.clicks,values.impressions),adRoas:ratio(values.adGmv,adCost),adRate:ratio(adCost,values.gmv),liveShare:ratio(values.liveGmv,values.gmv),refundRate:ratio(values.refundGmv,values.gmv),cancelRate:ratio(values.cancelGmv,values.gmv),campaignConversion:ratio(values.campaignOrders,values.campaignVisitors),naturalShare:ratio(values.naturalGmv,values.gmv),ctrChange:values.ctrBefore==null||values.ctrAfter==null?null:values.ctrAfter-values.ctrBefore,cvrChange:values.cvrBefore==null||values.cvrAfter==null?null:values.cvrAfter-values.cvrBefore};}
export const reviewWriters=['运营'];
export const reviewReaders=['管理员','运营主管','财务','供应链'];
export function reviewAccess(actor){if(!actor||![...reviewWriters,...reviewReaders].includes(actor.role))throw new ReviewError('当前岗位无权访问经营复盘',403);}
export const isReviewWriter=actor=>actor.role==='运营'&&actor.site&&['TikTok','Shopee'].includes(actor.channel);
export function normalizeReviewData(input,channel,strict=false){
 const text=(v,n=2000)=>String(v??'').trim().slice(0,n),numeric=v=>{if(v==null||v==='')return null;const n=Number(v);if(!Number.isFinite(n)||n<0||n>1e12)throw new ReviewError('指标必须是非负有效数字');return n;};
 const metrics={};for(const m of reviewMetrics(channel)){const v=input.metrics?.[m.key]||{};metrics[m.key]={actual:numeric(v.actual),target:numeric(v.target),nextTarget:numeric(v.nextTarget),source:text(v.source,300)};if(strict&&metrics[m.key].actual!==null&&!metrics[m.key].source)throw new ReviewError(`${m.label}填写实际值时需注明平台报表或证据来源`);}
 const result={summary:text(input.summary),win:text(input.win),problem:text(input.problem),rootCause:text(input.rootCause),support:text(input.support),nextResult:text(input.nextResult),metrics};
 if(strict&&['summary','win','problem','rootCause','nextResult'].some(k=>result[k].length<4))throw new ReviewError('请完整填写结果总结、可复制经验、问题、根因和下期量化结果（每项至少4字）');
 return result;
}
