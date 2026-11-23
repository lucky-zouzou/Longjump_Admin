import {localDay,shiftDay} from './promotion-model.mjs';
import {targetSites,targetChannels,buildTargetReport} from './sales-target-model.mjs';
import {salesFactStatements} from './sales-facts.mjs';
import {cachedSalesFx} from './sales-fx.mjs';

const aliases={'马来西亚':/马来西亚|马来|大马/,'印尼':/印尼|印度尼西亚/,'泰国':/泰国/,'越南':/越南/,'菲律宾':/菲律宾/};
const day=86400000;
const validDate=s=>typeof s==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
const ranges=['yesterday','today','beforeYesterday','last7','last30','thisWeek','lastWeek','dates'];
const reply=answer=>({answer,source:'ledger',intent:'live',guide:null,notice:''});
const plain=q=>q.replace(/[\s，,。？！?!]/g,'');
const channels=q=>targetChannels.filter(c=>(c==='TikTok'?/tiktok|\btk\b/i:/shopee|虾皮/i).test(q));
const dailyWords=/昨天|昨日|今天|今日|前天|每天|每日|日报|(?:近|过去)\s*\d+\s*天|最近|这几天|本周|这周|上周|日期|\d{1,2}月\d{1,2}[日号]|20\d{2}-\d{2}-\d{2}/;
const salesWords=/销售|销量|销售额|营收|业绩|生意|卖得|卖了|卖货|卖出|成交|GMV|日报|广告|投放/i;
const procedure=/怎么(?:填|录|导入|上传|操作)|如何(?:填|录|导入|上传|操作)|导入.*(?:失败|报错)|模板|按钮|手册|每天.*(?:做什么|先忙|工作|职责)/;
export function validSalesContext(c){
 return !!c&&typeof c==='object'&&!Array.isArray(c)&&ranges.includes(c.range)&&['previous','week'].includes(c.compare)&&
  Array.isArray(c.sites)&&c.sites.length<=5&&new Set(c.sites).size===c.sites.length&&c.sites.every(s=>targetSites.includes(s))&&
  ['',...targetChannels].includes(c.channel)&&
  (c.range!=='dates'||validDate(c.from)&&validDate(c.to)&&c.from<=c.to&&(Date.parse(c.to)-Date.parse(c.from))/day<31);
}
function followUp(q,c){
 if(!validSalesContext(c))return false;
 let text=plain(q).replace(/^(?:那么|那|只看|改看|看看|看|再看)/,'').replace(/(?:呢|怎么样|如何|的呢)$/,'');
 if(['为什么','为什么下滑','为什么下降','为什么掉了','怎么跟进','下一步怎么做','怎么回事','有什么建议','怎么办','谁负责','我该找谁','给我依据','详细说说','哪里下降最多','哪个SKU卖得好'].includes(text))return true;
 if(/^(?:20\d{2}-\d{2}-\d{2}|(?:20\d{2}年)?\d{1,2}月\d{1,2}[日号])(?:至(?:20\d{2}-\d{2}-\d{2}|(?:20\d{2}年)?\d{1,2}月\d{1,2}[日号]))?$/.test(text))return true;
 for(const re of Object.values(aliases))text=text.replace(re,'');
 return /^(?:全部站点|全部平台|所有站点|所有平台|TK|TikTok|Shopee|虾皮|昨天|前天|今天|近7天|近30天|本周|上周|和上周比|跟上周比|比上周同期|与前一天比较|和前天比|和昨天比|[、和与])*$/i.test(text);
}
function requestedPeriod(q,now){
 const dates=[...q.matchAll(/20\d{2}-\d{2}-\d{2}/g)].map(m=>m[0]);
 if(!dates.length)for(const m of q.matchAll(/(?:(20\d{2})年)?(\d{1,2})月(\d{1,2})[日号]/g))dates.push(`${m[1]||now.slice(0,4)}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`);
 if(dates.length){
  if(dates.length>2||dates.some(d=>!validDate(d)))return {error:'日期没对上。可以这样问：2026-11-20 至 2026-11-22 销售总结。'};
  const from=dates[0],to=dates.at(-1);
  if(from>to||(Date.parse(to)-Date.parse(from))/day>=31)return {error:'每日简报一次支持连续 1 至 31 天。请把起止日期缩短一点，月度汇总仍可直接问“本月销售怎么样”。'};
  return {range:'dates',from,to};
 }
 const rolling=q.match(/(?:近|过去)\s*(\d+)\s*天/);
 if(rolling){if(!['7','30'].includes(rolling[1]))return {error:'滚动简报支持近7天或近30天；也可以给我连续31天内的起止日期。'};return {range:rolling[1]==='7'?'last7':'last30'};}
 if(/前天/.test(q)&&!/(?:和|跟|比|与)前天/.test(q))return {range:'beforeYesterday'};
 if(/昨天|昨日/.test(q)&&!/(?:和|跟|比|与)昨天/.test(q))return {range:'yesterday'};
 if(/今天|今日/.test(q))return {range:'today'};
 if(/本周|这周/.test(q))return {range:'thisWeek'};
 if(/上周/.test(q)&&!/(?:和|跟|比|与)上周/.test(q))return {range:'lastWeek'};
 if(/最近|这几天/.test(q))return {range:'last7'};
 return null;
}
function windowFor(c,site,now){
 const today=localDay(new Date(now),site),yesterday=shiftDay(today,-1);
 const monday=shiftDay(today,-((new Date(today).getUTCDay()+6)%7));
 let from,to;
 if(c.range==='dates'){from=c.from;to=c.to;}
 else if(c.range==='today')from=to=today;
 else if(c.range==='beforeYesterday')from=to=shiftDay(today,-2);
 else if(c.range==='thisWeek'){from=monday;to=yesterday;}
 else if(c.range==='lastWeek'){from=shiftDay(monday,-7);to=shiftDay(monday,-1);}
 else {to=yesterday;from=shiftDay(to,c.range==='last7'?-6:c.range==='last30'?-29:0);}
 const days=[];for(let d=from;d<=to&&days.length<=31;d=shiftDay(d,1))days.push(d);
 return {from,to,days,expectedDays:days.length,current:to>=today,today};
}
const number=n=>n==null?'待补':Number(n).toLocaleString('zh-CN',{maximumFractionDigits:2});
const money=n=>n==null?'待补':'¥'+number(n);
const change=(n,base)=>base===0?(n===0?'仍为 0':`从 0 增至 ${number(n)}，不计算增长率`):n===base?'持平（0.0%）':`${n>=base?'增加':'减少'} ${number(Math.abs(n-base))}（${(Math.abs((n-base)/base)*100).toFixed(1)}%）`;

export async function answerSalesBrief(db,actor,question,now,previous){
 const follow=followUp(question,previous),period=requestedPeriod(question,now);
 if(procedure.test(question)||(!follow&&(!salesWords.test(question)||!(dailyWords.test(question)||/销售.*(?:总结|反馈|简报)|(?:总结|反馈).*销售/.test(question)))))return null;
 // Keep monthly finance/production and explicit unsupported dimensions out of a daily sales answer.
 if(/本月|这个月|上个月|备货|生产|利润|回款|到账|成本/.test(question))return null;
 if(!['管理员','财务','运营主管','运营'].includes(actor.role))return reply('这个账号没有销售金额简报权限。可以请对应站点运营或管理、财务同事查看。');
 if(/线下|分销|小时|订单数|多少单|转化率|退款率/.test(question))return reply('这份简报目前核对 TikTok、Shopee 的销售件数、销售额和广告费。订单数、转化率或分销履约不能用件数代替，请到对应台账核对。');
 if(/\bSKU\s*[:：]?\s*[a-z0-9]|\b[a-z]+[a-z0-9]*[-_][a-z0-9_-]+\b/i.test(question))return reply('这份简报先汇总站点和平台，并列出销量前列 SKU。指定单个 SKU 的逐日销售与广告明细，请在销售台账筛选该商品；我不会拿全店金额当成这款的金额。');
 if(/新加坡|香港|中国|美国|Amazon|亚马逊|Lazada/i.test(question))return reply('这份简报覆盖马来西亚、印尼、泰国、越南、菲律宾的 TikTok 和 Shopee。你提到的其他站点或平台暂未纳入，不能拿现有五站合计代替。');
 if(period?.error)return reply(period.error);
 const selected=Object.keys(aliases).filter(s=>aliases[s].test(question)),platforms=channels(question);
 if(platforms.length>1&&!(question.includes('和')||question.includes('、')||question.includes('全部')))return reply('想看 TikTok、Shopee 合计，还是只看其中一个平台？');
 let c={range:'yesterday',sites:[],channel:'',compare:'previous',...(follow?previous:{}),...(period||{})};
 if(selected.length)c.sites=selected;
 if(/全部站点|所有站点|五站|各站|全公司/.test(question))c.sites=[];
 if(platforms.length)c.channel=platforms.length===1?platforms[0]:'';
 if(/全部平台|所有平台|双平台/.test(question))c.channel='';
 if(/(?:和|跟|比|与)上周|上周同期/.test(question))c.compare='week';
 if(/前一天|和前天|和昨天/.test(question))c.compare='previous';
 if(actor.role==='运营'){
  if(!targetSites.includes(actor.site)||!targetChannels.includes(actor.channel))return reply('当前账号还没有完整的站点和平台范围，请管理员补齐后再查。');
  if(selected.some(s=>s!==actor.site)||platforms.some(p=>p!==actor.channel))return reply(`你的账号只能查 ${actor.site} / ${actor.channel}。跨站汇总请运营主管或管理员查看。`);
  c={...c,sites:[actor.site],channel:actor.channel};
 }
 const sites=c.sites.length?c.sites:targetSites,scopes=sites.flatMap(site=>(c.channel?[c.channel]:targetChannels).map(channel=>({site,channel})));
 const windows=Object.fromEntries(sites.map(s=>[s,windowFor(c,s,now)]));
 if(Object.values(windows).some(w=>w.to>w.today))return reply('所选日期包含未来日期，还没有实际销量。请查已经发生的日期。');
 if(Object.values(windows).some(w=>!w.expectedDays))return reply('本周还没有结束的自然日。可以问“今天销售怎么样”看截至当前已报数据，或查上周。');
 const prior=Object.fromEntries(sites.map(s=>{const w=windows[s],offset=c.compare==='week'?7:w.expectedDays;const days=w.days.map(d=>shiftDay(d,-offset));return [s,{...w,from:days[0],to:days.at(-1),days,current:false}];}));
 if(c.compare==='week'&&Object.values(windows).some(w=>w.expectedDays>7))return reply('超过7天的区间与上周会重叠。请改问“近7天与前7天比较”，或给我更短的日期范围。');
 const from=Object.values(prior).map(w=>w.from).sort()[0],to=Object.values(windows).map(w=>w.to).sort().at(-1);
 const scope={sql:` AND site IN (${sites.map(()=>'?').join(',')})${c.channel?' AND channel=?':''}`,args:[...sites,...(c.channel?[c.channel]:[])]};
 // Database facts are grouped on the server. No customer, order or sales rows go to a model.
 const result=await db.batch([
  ...salesFactStatements(db,from,to,scope),
  db.prepare(`SELECT id,name,site,channel FROM users WHERE active=1 AND role='运营'${scope.sql}`).bind(...scope.args),
  db.prepare(`SELECT business_date date,site,channel,sku,SUM(qty) qty FROM sales_records WHERE reversed_at IS NULL AND business_date BETWEEN ? AND ? AND channel IN ('TikTok','Shopee')${scope.sql} GROUP BY business_date,site,channel,sku`).bind(from,to,...scope.args),
 ]);
 const [raw,spend,coverage,users,skuRows]=result.map(r=>r.results||[]),fx=await cachedSalesFx(db,Date.parse(now));
 const build=w=>buildTargetReport({month:'',scopes,raw,spend,coverage,users,fx,now:new Date(now),windows:w,inventory:[],targets:[]});
 const current=build(windows),before=build(prior),total=current.total;
 const todayOpen=Object.values(windows).some(w=>w.current);
 const complete=total.qtyComplete&&!todayOpen;
 let head=total.qty==null?'这段时间还没有收到销售数据，先别把它当成零销量。':`${complete?'这段时间':'截至查询时，已报数据'}卖出 ${number(total.qty)} 件，${total.revenueComplete&&!todayOpen?'销售额':'已知销售额'} ${money(total.revenueCny)}${total.revenueCny==null?'（金额或汇率待补）':''}。`;
 if(/哪个站|哪一站|哪个平台|最高|最低|最差/.test(question)){
  const metric=/销售额|金额|营收|GMV/i.test(question)?'revenueCny':'qty',label=metric==='qty'?'销量':'销售额',ranked=/平台|渠道/.test(question)?current.groups:current.sites;
  if(complete&&(metric==='qty'||total.revenueComplete)&&ranked.length>1){
   const asc=/最低|最差|最少/.test(question),sorted=[...ranked].sort((a,b)=>asc?a[metric]-b[metric]:b[metric]-a[metric]);
   const winners=sorted.filter(r=>r[metric]===sorted[0][metric]).map(r=>r.name).join('、');
   head+=` ${winners}${label}${asc?'最低':'最高'}${sorted.filter(r=>r[metric]===sorted[0][metric]).length>1?'（并列）':''}。`;
  }else if(!complete||!total.revenueComplete)head+=' 数据未齐，暂不做站点排名。';
 }
 const comparable=complete&&before.total.qtyComplete;
 const comparison=todayOpen?'今天还没结束，只展示已报进度，不拿它和昨天全天硬比较。':comparable?`对比上一${c.compare==='week'?'周同期':'等长期间'}，销量${change(total.qty,before.total.qty)}${total.revenueComplete&&before.total.revenueComplete?`；销售额${change(total.revenueCny,before.total.revenueCny)}`:''}。`:'两期日报尚未全部齐备，暂不判断整体增长或下滑。';
 const missing=current.rows.filter(r=>!r.qtyComplete).sort((a,b)=>(b.expectedDays-b.completeDays)-(a.expectedDays-a.completeDays)),adsPending=current.rows.filter(r=>!r.costComplete);
 const changes=current.rows.map(r=>{const old=before.rows.find(x=>x.key===r.key);return {...r,old,delta:r.qtyComplete&&old.qtyComplete&&!todayOpen?r.qty-old.qty:null};}).filter(r=>r.delta!=null).sort((a,b)=>a.delta-b.delta);
 const decline=changes.find(r=>r.delta<0);
 const owners=r=>users.filter(u=>u.site===r.site&&u.channel===r.channel).map(u=>u.name).join('、')||'该站点运营（账号负责人待配置）';
 const action=missing.length?`先请 ${owners(missing[0])} 补齐 ${missing[0].site} / ${missing[0].channel} 的日报；当前查询共 ${total.expectedDays-total.completeDays} 个站点／平台／日期待核对。`:decline?`优先请 ${owners(decline)} 核对 ${decline.site} / ${decline.channel}：可比销量少了 ${number(-decline.delta)} 件，结合库存、活动和流量查原因，暂不直接认定是投放问题。`:adsPending.length?`销量已核对；下一步请 ${owners(adsPending[0])} 核对 ${adsPending[0].site} / ${adsPending[0].channel} 的广告费，再判断投放效率。`:'先关注下面的畅销 SKU，核对可售库存和补货进度；销量变化的原因仍需结合活动及流量验证。';
 const scopeText=`${sites.length===5?'五站':sites.join('、')} / ${c.channel||'TikTok + Shopee'}（不含线下分销）`;
 const periodText=[...new Set(Object.values(windows).map(w=>`${w.from} 至 ${w.to}`))].join('；');
 const details=[`范围：${scopeText}。日期按各站点当地时间，读取时间 ${now}。`,
  `日报齐备 ${total.completeDays}/${total.expectedDays} 个站点／平台／日期；缺报不作零，销售件数不等于订单数。`,
  `比较区间：${[...new Set(Object.values(prior).map(w=>`${w.from} 至 ${w.to}`))].join('；')}；${before.total.completeDays}/${before.total.expectedDays} 份完整日报。`,
  ...current.rows.map(r=>`${r.site} / ${r.channel}：已报 ${number(r.qty)} 件，已知销售额 ${money(r.revenueCny)}，已知广告费 ${money(r.adCostCny)}；日报 ${r.completeDays}/${r.expectedDays}${r.repeatedDays?'；疑似重复店铺广告费待核对':''}。`),
 ];
 for(const r of missing){const recorded=new Set(coverage.filter(x=>x.site===r.site&&x.channel===r.channel).map(x=>x.date));const dates=r.window.days.filter(d=>!recorded.has(d));details.push(`${r.site} / ${r.channel} 缺完整日报：${dates.slice(0,5).join('、')}${dates.length>5?` 等 ${dates.length} 天`:''}；请 ${owners(r)} 核对。`);}
 if(complete&&total.revenueComplete&&current.sites.length>1){const best=[...current.sites].sort((a,b)=>b.revenueCny-a.revenueCny)[0];details.push(`完整口径中，${best.name} 销售额最高：${money(best.revenueCny)}。`);}
 for(const r of changes.filter(r=>r.delta<0).slice(0,3))details.push(`${r.site} / ${r.channel} 可比销量：${number(r.old.qty)} → ${number(r.qty)} 件。`);
 const top=new Map();for(const r of skuRows){const w=windows[r.site];if(r.date>=w.from&&r.date<=w.to)top.set(r.sku,(top.get(r.sku)||0)+r.qty);}
 const best=[...top].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,5);
 if(best.length)details.push('已报销量前列 SKU：'+best.map(([sku,qty])=>`${sku} ${number(qty)} 件`).join('；')+'。');
 for(const r of current.rows.filter(r=>r.unconverted))details.push(`${r.site} / ${r.channel} 原币待折算：${r.original.map(o=>`${o.currency} 销售额 ${number(o.revenue)}，广告费 ${number(o.adCost)}`).join('；')}。`);
 details.push(fx.effectiveAt?`人民币使用销售看板同源参考汇率（${fx.effectiveAt}，${fx.status==='stale'?'缓存较旧':'已缓存'}），两期采用同一汇率；不代表交易日财务结算。`:'暂缺可用参考汇率，外币不强行折成人民币；CNY 已知金额仍显示。');
 details.push('销售额不等于利润或到账。只读简报不修改广告预算、售价、生产单或财务数据。');
 const adLine=`${total.costComplete&&!todayOpen?'广告费':'已知广告费'} ${money(total.adCostCny)}${!total.costComplete?'，费用或完整性仍待核对':''}。`+(complete&&total.revenueComplete&&total.costComplete&&total.revenueCny>0?` 广告费占销售额 ${(100*total.adCostCny/total.revenueCny).toFixed(1)}%；这是全店口径，不是广告归因或利润率。`:'');
 return {...reply([head,comparison,adLine,action].join('\n')),salesContext:c,brief:{period:periodText+' · '+scopeText,details},
  notice:'我刚核对了销售台账，先看结论，展开下面可查依据。',
  questions:['近7天销售总结','昨天销售总结','今天销售怎么样'],ledger:{page:actor.role==='财务'?'sales-targets':'sales',label:actor.role==='财务'?'查看月度销售与贡献':'查看销售台账'}};
}
