import {readSalesTargets} from './sales-targets.mjs';
import {summarizeTargets,targetSites,targetChannels,targetAccess} from './sales-target-model.mjs';
import {readPeriodProfitLines} from './finance-ledger.mjs';
import {localDay} from './promotion-model.mjs';
import {navigationForRole} from './permissions.mjs';
import {loadForecast} from './forecast.ts';
import {readBusinessActions} from './business-actions.mjs';
import {actionKinds,actionRoles,canReadActions} from './business-action-model.mjs';

const sales = /业绩|贡献|销售额|营收|销售收入|成交额|卖得|GMV/i;
const spend = /投入|投放|广告|花费|消耗/;
const units = /销量|销售件数|卖了多少件|卖出多少件/;
const compare = /哪|那个|各站|五站|排名|排行|占比|相比|对比|比较|最[高低多少大小差好强弱]|偏[高低]|拖后腿|不划算|优先|怎么样|表现|复盘|效率|投产|多少|几成/;
const manual = /怎么(?:填|录|导入|导出|设置)|如何(?:填|录|导入|设置)|在哪(?:填|录)|找哪个按钮|什么意思|什么是|是什么|怎么计算|如何计算/;
const otherBasis = /利润|毛利|净利|全成本|总投入|人力|人工成本|资金占用|库存投入|预算|ROI|投资回报率|目标|完成率|增长率|转化率|客单价/i;
const otherTopics = /备货|生产|海运|清仓|回款|选品|直播场次|达人佣金/;
const efficiency=/投放效率|投放回报|广告效率|投产比|广告产出|投入产出|ROAS/i;
const priority=/(?:哪个|哪些|各个|各|哪一?)站点?.{0,12}(?:优先复盘|先看|重点关注)|(?:经营|运营).{0,8}(?:先看哪|优先复盘|先查哪|怎么样|情况如何|情况怎样|表现如何)|各站.{0,5}经营情况/;
const profitIntent=/利润|赚[钱了没得]|挣[钱了没得]|赚不赚|挣不挣|赔钱|赔了|最亏|亏[得损了钱]|盈利/;
const adValue=/钱.{0,4}花.{0,4}(?:值|冤|划算|亏)|(?:广告|投放).{0,8}(?:值不值|划算|回本|白花|白投|白烧|赚回来)|(?:烧钱|花钱多|花得多).{0,8}(?:卖|回报)|投放.{0,6}打水漂|(?:广告|钱).{0,6}(?:要不要|该不该|还要).{0,3}(?:继续)?投/;
const attention=/拖后腿|(?:站点?|市场).{0,6}(?:拉胯|卖不动|表现差|卖得差)|生意(?:怎么样|好不好)|(?:这月|本月|这个月).{0,4}(?:做得怎么样|做得咋样)/;
const plainSales=/卖了多少钱|卖了多少件|卖出多少件|卖得(?:最好|最差|怎么样|咋样)|卖得最[多少]|卖得好不好/;
const overall=/一共|总共|加起来|合计|总额|五站总|整体/;
const unclearBusiness=/^(?:小品同学[，, ]*)?(?:那|咱们|我们|公司|我们公司)?(?:现在|最近|目前|这阵子|本月|这月|这个月)?(?:整体)?(?:怎么样(?:了)?|情况(?:如何|怎么样)|给我个结论|帮我分析(?:一下)?|钱(?:都)?花哪[里儿]去了)[？?！!。\s]*$/;
const targetQuestion=/销售目标|销量目标|目标销量|销售.{0,5}达标|目标.{0,8}(?:完成|还差|差多少|追上|能达|达成)|离目标|(?:本月|这个月|上个月|我们).{0,8}(?:达标|完成任务|达成目标)/;
const platformComparison=/哪(?:个|一)?平台|平台(?:之间|对比|排名)|(?:虾皮|shopee|tiktok|tk).*(?:和|比|与).*(?:虾皮|shopee|tiktok|tk).*(?:哪个|谁)/i;
const explain=/^(?:那|所以)?(?:你是|你)?(?:为什么(?:这么说|这么看|是这样|这么判断)?|为啥(?:呢|这么说)?|依据(?:呢|是什么|在哪[里儿]?)?|凭什么(?:这么说|这么判断)?|怎么看出来的|怎么得出的|怎么算出来的|接下来(?:呢|怎么办|怎么做)?|怎么办|怎么处理|谁(?:来)?(?:跟进|负责)|(?:我?该)?找谁|我该怎么做|能不能说简单点|说简单点|直接说结果)[呢呀啊吧吗？?。！!\s]*$/;
const asksWhy=q=>/为什么|为啥|依据|凭什么|怎么看出来|怎么得出|怎么算出来/.test(q);
const asksOwner=q=>/跟进|谁负责|谁来负责|找谁/.test(q);
const metricNames=['mix','sales','spend','units','efficiency','profit','adValue','priority','target','qtyTarget'];
const comparisons=['asc','desc'];
const pct=n=>(100*n).toFixed(1)+'%';
const money=n=>'¥'+n.toLocaleString('zh-CN',{maximumFractionDigits:2});
const aliases={'马来西亚':/马来|大马/,'印尼':/印尼|印度尼西亚/,'泰国':/泰国/,'越南':/越南/,'菲律宾':/菲律宾/};
function channelsIn(q){return targetChannels.filter(c=>(c==='TikTok'?/tiktok|抖音|tk/i:/shopee|虾皮/i).test(q));}
function sitesIn(q){return targetSites.filter(site=>aliases[site].test(q));}
const skuPattern=/\bSKU\s*[:：]?\s*([a-z0-9][a-z0-9_-]{0,79})\b|\b([a-z0-9]+(?:[-_][a-z0-9]+)+)\b/i;
// Keep the spoken answer short. The underlying records remain available in the dialog.
function briefing(headline,basis,action,period,details=[]){
  return {answer:[headline,basis,action].filter(Boolean).join('\n'),brief:{period,details:details.filter(Boolean)}};
}
const actionQuestion=/(?:哪个|哪一?个?|那个)站点?.{0,8}(?:最让人操心|最让人担心|最操心|最危险|最急|最需要盯)|(?:今天|现在|眼下).{0,10}(?:先盯|最该盯|最该管|最急|最要紧|最需要我处理)|(?:有哪|哪[一件个些]).{0,4}(?:急事|最急的事|事最急|事最要紧)/;
export async function answerPriority(db,actor,q,at,prior){
  const follow=validDecisionContext(prior)&&prior.metric==='priority'&&followUp(q,prior)&&!sales.test(q)&&!spend.test(q)&&!profitIntent.test(q)&&!units.test(q);
  if(!actionQuestion.test(q)&&!follow)return null;
  if(/销售额|广告|利润|预算|操作步骤|怎么使用|回款|订单|审批|员工|客户|工资/.test(q))return null;
  const respond=(answer,ledger=null)=>({source:'ledger',intent:'live',guide:null,notice:'',answer,ledger});
  if(!canReadActions(actor))return respond('这个账号看不到经营行动单，可以请运营主管核对。');
  let sites=sitesIn(q),channels=channelsIn(q);
  if(follow&&/月|年/.test(q))return respond('行动单按最近一次证据排优先级。要复盘某个月，可以问“上个月哪站投入多、贡献少”。');
  if(follow&&!sites.length&&!/各站|五站|全部/.test(q))sites=prior.site?[prior.site]:prior.selectedSites||[];
  if(follow&&!channels.length&&prior.channel&&!/全部|两个平台/.test(q))channels=[prior.channel];
  if(actor.role==='运营'&&(sites.some(s=>s!==actor.site)||channels.some(c=>c!==actor.channel)))return respond('你可以查自己负责的站点和平台，跨站问题请运营主管核对。');
  const queue=await readBusinessActions(db,actor,new Date(at),{site:sites.length===1?sites[0]:''});
  const open=queue.records.filter(r=>r.status!=='resolved'&&(!sites.length||sites.includes(r.site))&&(!channels.length||channels.includes(r.channel)));
  const active=open.filter(r=>r.snapshot.condition==='active'),verify=open.filter(r=>r.snapshot.condition==='verify');
  const first=active[0]||verify[0],ledger={page:'business-actions',label:'查看经营行动单'};
  if(!first)return respond('所查范围的行动单里暂时没有已触发或待核实的事项。可以核对最近一次证据更新时间。',ledger);
  const fact=first.snapshot,who=queue.users.find(u=>u.id===first.owner_id)?.name;
  const headline=(active.length?'先跟进':'先补证据，再判断')+first.site+' '+first.channel+' 的 '+first.sku+'。';
  const basis=active.length?'行动单记录了“'+(actionKinds[first.kind]||fact.title)+'”，在 '+active.length+' 条已触发事项中排第一。':'还有 '+verify.length+' 条记录待核实，这一条排在最前。';
  const cutoff=fact.window?.cutoff,local=localDay(new Date(at),first.site);
  const yesterday=new Date(Date.parse(local)-86400000).toISOString().slice(0,10);
  const owner=who?'请'+who:'请'+actionRoles(first.kind).primary;
  const action=owner+(who?'跟进。':'先认领。')+(!cutoff||cutoff<yesterday?'先更新证据，确认问题是否仍在。':fact.mustActDate?'行动单处理期限为 '+fact.mustActDate+'。':'');
  const context={metric:'priority',order:'desc',site:sites.length===1?sites[0]:'',selectedSites:sites,channel:channels.length===1?channels[0]:'',month:localDay(new Date(at),first.site).slice(0,7)};
  return {...respond('',{...ledger,entity:first.id}),decisionContext:context,...briefing(headline,basis,action,'经营行动单 · '+(fact.window?.cutoff?'证据截至 '+fact.window.cutoff:'截止日期待核实'),[fact.today,'顺序沿用行动单的处理时限、证据可靠性和可挽回金额。'])};
}
export function validProductionContext(c){
  return !!c&&targetSites.includes(c.site)&&targetChannels.includes(c.channel)&&typeof c.sku==='string'&&/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(c.sku);
}
export async function answerProduction(db,actor,q,at,previous,prior){
  const aboutProduction=/启动生产|建议生产|生产建议|该不该生产|开工|排产|备货|补货|大促.{0,8}货够|货.{0,4}够不够卖/.test(q);
  const wantsBasis=/依据|为什么|为啥|大促|活动|要不要|该不该|建议|多少|怎么算|怎么[算做]|预判|考虑|够不够|吗/.test(q);
  const followSku=previous==='production-basis'&&skuPattern.test(q)&&!sales.test(q)&&!spend.test(q)&&!units.test(q);
  const follow=previous==='production-basis'&&validProductionContext(prior)&&(explain.test(q)||/^(?:那)?(?:大促|活动|交期|库存|下个月大促)(?:呢|考虑了吗|算进去了吗)[？?。]*$/.test(q));
  if(!(aboutProduction&&wantsBasis)&&!followSku&&!follow)return null;
  if(/审批|提交|操作步骤|按钮|导出/.test(q))return null;
  const reply=(answer,hasAccess=true)=>({answer,source:'ledger',intent:'live',guide:null,notice:'',
    ledger:hasAccess?{page:'suggestions',label:'核对补货与生产测算'}:null});
  if(!navigationForRole(actor.role).includes('suggestions'))return reply('生产测算需要补货驾驶舱权限，可以请供应链核对这条建议。',false);
  const sites=follow?[prior.site]:sitesIn(q),channels=follow?[prior.channel]:channelsIn(q),ops=actor.role==='运营';
  if(ops&&(!targetSites.includes(actor.site)||!targetChannels.includes(actor.channel)||
    sites.some(site=>site!==actor.site)||channels.some(channel=>channel!==actor.channel)))return reply('你只能核对自己负责站点和平台的生产建议。',false);
  const site=ops?actor.site:sites.length===1?sites[0]:'',channel=ops?actor.channel:channels.length===1?channels[0]:'';
  const match=q.match(skuPattern),sku=follow?prior.sku:match?.[1]||match?.[2];
  const basis='先看近 7、21、56 天的日均需求，权重分别为 50%、30%、20%。按生产、运输和复盘天数算目标库存，加入安全库存，再扣除可用供应，最后核对起订量、产能和预算。';
  const campaign='大促看该站点、平台和 SKU 登记的活动日期及需求倍数。已按活动日期逐日叠加需求，并按海运预计到仓日、工厂承诺完工日加运输周期计算供应；没有承诺日期的在产不假定按时到货。';
  if(!site||!channel||!sku)return {...reply(''),...briefing('要判断这款货要不要开工，请告诉我'+[!site&&'站点',!channel&&'平台',!sku&&'完整 SKU'].filter(Boolean).join('、')+'。','我会算现有库存和在途能撑多久，再看生产是否赶得上。',/大促|活动/.test(q)?'大促按已登记的日期和需求倍数计入。':'','补货驾驶舱',[basis,campaign])};
  const date=localDay(new Date(at),site);
  const {suggestions}=await loadForecast(db,actor,date,[site,channel,sku].join('|'));
  const row=suggestions[0],scope=[site,channel,sku].join(' · ');
  if(!row)return reply(scope+' 暂时查不到对应的测算记录。可以核对 SKU 的完整拼写和所属平台。');
  const qty=row.suggestedProduction;
  let headline=scope+' 目前无法确认生产数量。';
  if(qty>0)headline=scope+' 建议启动生产 '+qty+' 件。';
  if(qty===0)headline=scope+' 本次建议新增生产 0 件。';
  let reason=qty==null?(row.readinessReasons.join('，')||row.alertReason):'预计每天卖 '+row.forecastDaily.toFixed(2)+' 件，要覆盖 '+row.horizonDays+' 天，目标库存 '+row.targetQty+' 件。';
  if(qty!=null&&asksWhy(q))reason+='其中安全库存 '+row.safetyStock+' 件，测算已计入的供应有 '+row.planningPosition+' 件。';
  const stock='可用库存 '+(row.qty??'待核实')+' 件，海运在途 '+row.seaInTransit+' 件，生产中 '+row.productionInProgress+' 件。';
  const p=row.policy;
  const event=p?.campaign_start&&p?.campaign_end?'已登记活动 '+p.campaign_start+' 至 '+p.campaign_end+'，需求倍数 '+(p.campaign_factor??1)+'，本次覆盖期综合活动系数 '+row.eventFactor.toFixed(2)+'。':'这个范围还没有登记带起止日期的活动。';
  const constraints=row.limits.length?'数量受'+row.limits.join('、')+'限制。':'';
  const promo=/大促|活动|交期/.test(q);
  if(promo&&/够|断货|赶得上/.test(q)){
    const shortage=row.projection?.firstShortageDate;
    if(qty==null||!p?.campaign_start||!p?.campaign_end)headline=scope+' 目前还判断不了大促前的货够不够。';
    else if(shortage&&shortage<=p.campaign_end)headline=scope+' 有缺货风险，按当前需求估算可能在 '+shortage+' 出现缺口。';
    else headline=scope+' 的活动能否按时供货，还要核对逐日需求和实际到仓日。';
    if(qty!=null)reason+='当前建议新增生产 '+qty+' 件。';
  }
  const action=constraints+(promo?event+'请供应链逐日核对活动前能到多少货。':qty==null?'请运营和供应链补齐上述记录再定数量。':stock);
  return {...reply(''),productionContext:{site,channel,sku},...briefing(headline,reason,action,date+' · 补货驾驶舱',[basis,stock,event,campaign])};
}
export function validDecisionContext(c){
  return !!c&&typeof c==='object'&&typeof c.month==='string'&&/^20\d{2}-(0[1-9]|1[0-2])$/.test(c.month)&&
    metricNames.includes(c.metric)&&comparisons.includes(c.order)&&['aggregate','byPlatform','targetRanking'].every(k=>c[k]===undefined||typeof c[k]==='boolean')&&
    (c.selectedSites===undefined||Array.isArray(c.selectedSites)&&c.selectedSites.length<=targetSites.length&&c.selectedSites.every(s=>targetSites.includes(s)))&&
    (c.channel===''||targetChannels.includes(c.channel))&&(c.site===''||targetSites.includes(c.site));
}
function followUp(q,c){
  if(validDecisionContext(c)&&explain.test(q))return true;
  return validDecisionContext(c)&&/^(?:那|那么|换成|改看|换|看看|只看|看|再看|单看|按)?(?:上个?月|本月|这个月|这月|上上个?月|\d{1,2}月|20\d\d[-年]\d{1,2}月?|全部(?:站点|平台)?|五站|两个平台|各站|印尼|马来西亚|泰国|越南|菲律宾|虾皮|shopee|tiktok|tk|(?:按)?(?:利润|销售额|销量|广告费|业绩|投入)(?:看|排名)?)[呢呀啊吧吗？?。\s]*$/i.test(q);
}
function isDecision(q,c){
  if(followUp(q,c))return true;
  if(manual.test(q))return false;
  if(otherTopics.test(q))return false;
  if(/员工|同事|个人|老板自己|哪个人|哪位/.test(q))return false;
  if(targetQuestion.test(q))return true;
  if(adValue.test(q)||attention.test(q)||plainSales.test(q)||profitIntent.test(q)&&/钱|亏|总共|整体/.test(q))return true;
  if(priority.test(q))return true;
  const scoped=/站点|国家|市场|站|平台/.test(q)||sitesIn(q).length||channelsIn(q).length;
  return !!(scoped&&compare.test(q)&&(sales.test(q)||spend.test(q)||units.test(q)||efficiency.test(q)||otherBasis.test(q)||profitIntent.test(q)));
}
function period(q,at,previous){
  const today=localDay(new Date(at),'马来西亚'),current=today.slice(0,7);
  const absolute=[...q.matchAll(/(20\d{2})[-年/](\d{1,2})月?/g)];
  const months=[...q.matchAll(/(\d{1,2})月/g)];
  if(absolute.length>1||months.length>1||/季度|半年|去年|上周|本周|这周|周一|昨天|前天|过去|本季度|上季度|上半年|下半年|最近\s*[\d一二两三四五六七八九十]+[天周月]|近\s*[\d一二两三四五六七八九十]+[天周月]|昨日|昨天|今天|今日|\d+[日号]|20\d\d[-/]\d{1,2}[-/]\d|环比|同比|上月.*本月|本月.*上月/.test(q))return '';
  if(absolute.length||months.length){
    const year=absolute[0]?.[1]||current.slice(0,4),m=Number(absolute[0]?.[2]||months[0][1]);
    return m>=1&&m<=12?year+'-'+String(m).padStart(2,'0'):'';
  }
  if(/上上个?月|上个?月/.test(q)){
    const t=new Date(current+'-01T00:00:00Z');
    t.setUTCMonth(t.getUTCMonth()-(q.includes('上上')?2:1));return t.toISOString().slice(0,7);
  }
  if(/明年|今年|未来|下月|下个月|年度|全年|本周|周末|上星期|这星期|本星期|\d+天|一周|上旬|中旬|下旬/.test(q))return '';
  if(/本月|这个月|这月|目前|当前|现在/.test(q))return current;
  if(/个月/.test(q))return '';
  return previous||current;
}
function formatSite(row,totals,metric){
  const salesShare=row.revenueCny!=null&&totals.revenueCny>0?row.revenueCny/totals.revenueCny:null;
  const adShare=row.adCostCny!=null&&totals.adCostCny>0?row.adCostCny/totals.adCostCny:null;
  const amt=(v,s)=>v==null?'待补':money(v)+(s==null?'':'（占 '+pct(s)+'）');
  const text=metric==='efficiency'?'全店销售额／广告费 '+(row.roas==null?'待核实或无广告支出':row.roas.toFixed(2)+' 倍'):
    metric==='units'?'已报销量 '+(row.qty==null?'待补':row.qty.toLocaleString('zh-CN')+' 件'):
    metric==='sales'?'已报销售额 '+amt(row.revenueCny,salesShare):
    metric==='spend'?'已报广告费 '+amt(row.adCostCny,adShare):
    '销售 '+amt(row.revenueCny,salesShare)+'，广告 '+amt(row.adCostCny,adShare);
  return {...row,salesShare,adShare,gap:salesShare!=null&&adShare!=null?adShare-salesShare:null,text};
}
function extreme(rows,key,order){
  const known=rows.filter(r=>Number.isFinite(r[key]));
  if(!known.length)return [];
  const best=Math[order==='asc'?'min':'max'](...known.map(r=>r[key]));
  return known.filter(r=>Math.abs(r[key]-best)<1e-10);
}
const names=rows=>rows.map(r=>r.site).join('、');
function chooseMetric(q,previous){
  if(targetQuestion.test(q))return /销量|件数|多少件/.test(q)?'qtyTarget':'target';
  if(profitIntent.test(q))return 'profit';
  if(adValue.test(q))return 'adValue';
  if(efficiency.test(q))return 'efficiency';
  if(priority.test(q)||attention.test(q)||spend.test(q)&&sales.test(q))return 'mix';
  if(units.test(q))return 'units';
  if(spend.test(q))return 'spend';
  if(sales.test(q)||plainSales.test(q))return 'sales';
  return previous||'mix';
}

export async function answerDecision(db,actor,q,at,prior){
  if(unclearBusiness.test(q)&&!validDecisionContext(prior)&&['管理员','运营主管','财务','运营'].includes(actor.role)){
    const questions=['今天最该盯哪件事？','这个月钱花得值不值？',...(['管理员','财务'].includes(actor.role)?['我们本月赚了多少钱？']:[])];
    return {answer:'你想先知道哪件事？选一句，我直接查给你。',questions,intent:'live',source:'conversation',guide:null,notice:''};
  }
  const follow=followUp(q,prior);
  if(!isDecision(q,prior))return null;
  const reply=(answer,extra={})=>({source:'ledger',intent:'live',guide:null,notice:'',answer,...extra});
  try{targetAccess(actor);}catch(e){if(e.status!==403)throw e;return reply('这个账号没有「月度任务与贡献」的读取权限，跨站经营比较可由运营主管、管理员或财务查看。');}
  const sites=sitesIn(q),channels=channelsIn(q);
  const restricted=actor.role==='运营';
  if(restricted&&(sites.some(s=>s!==actor.site)||channels.some(c=>c!==actor.channel)))
    return reply('你的账号可以查'+actor.site+' · '+actor.channel+'。跨站比较需要有五站查看权限的账号。');
  const prev=follow?prior:null,month=period(q,at,prev?.month);
  if(!month)return reply('这里可以按自然月比较站点。你想看哪个月？比如“2026年10月各站销售额排名”。');
  const filter=(specified,clear,inherited)=>specified.length===1?specified[0]:specified.length||clear?'':inherited||'';
  const channel=restricted?actor.channel:filter(channels,/全部平台|两个平台|^全部[呢？?。]*$/.test(q),prev?.channel);
  const site=restricted?actor.site:filter(sites,/全部站点|各站|五站|^全部[呢？?。]*$/.test(q),prev?.site);
  const metric=chooseMetric(q,prev?.metric);
  const byPlatform=platformComparison.test(q)||!!prev?.byPlatform&&!channels.length;
  let order=prev?.order||(metric==='mix'?'asc':'desc');
  if(/最低|最少|最小|最差|最弱|最不|垫底|偏低|亏(?:损|得|了)?最[多大]|最亏|赔钱|亏钱|拖后腿/.test(q))order='asc';
  else if(/最高|最多|最大|最好|最强|最赚钱|最挣钱/.test(q))order='desc';
  let selectedSites=sites.length>1?sites:prev?.selectedSites||[];
  if(site||restricted||/全部站点|各站|五站|^全部[呢？?。]*$/.test(q))selectedSites=[];
  const asksGroup=overall.test(q)||/卖了多少钱|卖了多少件|赚了多少钱|挣了多少/.test(q)||metric==='profit'&&/我们|公司|整体|本月|这个月/.test(q);
  const aggregate=!!prev?.aggregate||asksGroup&&!/哪|哪个|最|排行|排名|各站|谁/.test(q);
  const targetRanking=!!prev?.targetRanking||/哪|排名|最高|最低/.test(q);
  const context={month,channel,site,metric,order,selectedSites,aggregate,byPlatform,targetRanking},ledger={page:'sales-targets',label:'核对月度任务与贡献',month};
  const result=(answer,questions=[])=>reply(answer,{decisionContext:context,ledger,questions});
  if(month>localDay(new Date(at),'马来西亚').slice(0,7))return result('这个月份还没有已发生的销售和广告消耗。可以查本月或已经结束的月份。');
  if(/线下|分销|OEM|订单号|单品|\bSKU\b/i.test(q))
    return result('月度站点比较汇总 TikTok 和 Shopee 的线上日报。可以问这两个平台的站点表现；单品或线下分销需要各自的明细台账。');
  if(byPlatform&&restricted)return reply('你的账号仅能查看'+site+' '+channel+'，比较两个平台需要有跨平台权限。');
  if(metric==='profit'&&!/净利|毛利|人力|总投入/.test(q)){
    if(!['管理员','财务'].includes(actor.role))return reply('按站点汇总已核实贡献利润需要财务月结账册权限。你的账号可在月度任务中查看获准范围的销售与广告费。',{ledger});
    const profit=await readPeriodProfitLines(db,actor,month);
    const permittedSites=site?[site]:selectedSites.length?selectedSites:targetSites;
    const axis=byPlatform?'channel':'site',labels=byPlatform?targetChannels:permittedSites;
    const summaries=labels.map(name=>{
      const entries=profit.lines.filter(l=>l[axis]===name&&permittedSites.includes(l.site)&&targetChannels.includes(l.channel)&&(!channel||l.channel===channel));
      const confirmed=entries.filter(l=>Number.isFinite(l.confirmed));
      return {site:name,amount:confirmed.length?confirmed.reduce((v,l)=>v+l.confirmed,0)/100:null,pending:entries.filter(l=>l.confirmed==null||l.reason).length};
    });
    const known=summaries.filter(r=>r.amount!=null).sort((a,b)=>order==='asc'?a.amount-b.amount:b.amount-a.amount);
    const periodLabel=month+' · '+(channel||'TikTok＋Shopee')+' · '+(profit.closed?'已关账':'月结预览');
    const details=[...known,...summaries.filter(r=>r.amount==null)].map(x=>x.site+'　'+(x.amount==null?'暂无已核金额':money(x.amount))+(x.pending?'，'+x.pending+' 项待核实':''));
    let headline='财务台账暂无已核金额，还判断不了赚了还是亏了。',basis='';
    if(known.length){
      const grouped=context.aggregate;
      const best=known[0],ties=known.filter(r=>r.amount===best.amount);
      const value=grouped?known.reduce((sum,r)=>sum+r.amount,0):best.amount;
      const scope=grouped?'所查线上站点':names(ties);
      headline=scope+'已核的贡献利润'+(value<0?'为负，亏了 '+money(-value):value===0?'为零':'为 '+money(value))+'。';
      if(!grouped&&/亏|赔钱/.test(q)&&known.every(r=>r.amount>=0))headline='有已核金额的站点里，暂时没有出现负贡献利润。';
      const label=byPlatform?'平台':'站点';
      if(!grouped&&known.length>=2)basis='在有已核金额的'+label+'里，'+names(ties)+(order==='asc'?'最低。':'最高。');
      if(grouped||summaries.length>1)basis+='已核到 '+known.length+'/'+summaries.length+' 个'+label+'。';
    }
    const incomplete=known.length<summaries.length||summaries.some(r=>r.pending);
    const action=incomplete?'还有销售或费用待核，请财务补齐后再判断整体盈亏。':'这里按财务已核的线上贡献利润计算。';
    return {...reply('',{decisionContext:context,ledger:{page:'cost-profit',label:'核对财务月结',view:'finance',month},questions:[month+'各站销售贡献和广告投入占比']}),...briefing(headline,basis,action,periodLabel,details)};
  }
  const isTarget=metric==='target'||metric==='qtyTarget';
  if(isTarget&&/利润|预算|回款|产量|库存/.test(q))return result('月度任务里有销售额和销量两种目标。你想核对哪一种？');
  if(!isTarget&&otherBasis.test(q))return result('这项指标要单独核对。你想看已经花了多少广告费，还是财务核实后赚了多少？',[month+'各站广告费排名',month+'各站贡献利润排名']);
  const report=await readSalesTargets(db,actor,month,{now:new Date(at)});
  const matchesSite=r=>selectedSites.length?selectedSites.includes(r.site):!site||r.site===site;
  const rows=report.rows.filter(r=>(!channel||r.channel===channel)&&(!byPlatform||matchesSite(r))),total=summarizeTargets(rows);
  const axis=byPlatform?'channel':'site',groupName=byPlatform?'平台':'站点';
  const scopes=[...new Set(rows.map(r=>r[axis]))];
  const all=scopes.map(s=>formatSite({site:s,...summarizeTargets(rows.filter(r=>r[axis]===s))},total,metric));
  const shown=byPlatform?all:all.filter(matchesSite);
  const window=rows.map(r=>r.window.to).filter(Boolean).sort();
  const scopeText=restricted?'仅本人范围 '+site+' · '+channel:[site||selectedSites.join('、'),channel||'TikTok＋Shopee'].filter(Boolean).join(' · ');
  const header=month+' · '+scopeText+'。'+(window.length?(window[0]===window.at(-1)?'截至各站当地 '+window[0]:'各站当地截止日 '+window[0]+' 至 '+window.at(-1))+'。':'这个月还没有已结束的经营日。');
  if(!window.length)return result(header);
  if(isTarget){
    const scopes=rows.filter(matchesSite),assigned=scopes.filter(r=>r.target),sum=summarizeTargets(assigned);
    const inUnits=metric==='qtyTarget',amount=inUnits?n=>n+' 件':money;
    const actual=inUnits?sum.targetActualQty:sum.targetActual,target=inUnits?sum.targetQty:sum.targetRevenue;
    const reason='已设置目标 '+assigned.length+'/'+scopes.length+' 个站点平台。';
    if(!assigned.length||actual==null||target<=0)return {...result(''),...briefing('还算不出离目标差多少。',reason,'请运营主管核对月度目标和已报销售。',header)};
    const gap=Math.max(0,target-actual),kind=inUnits?'销量':'销售额';
    const headline=gap?'已分配任务的'+kind+'距目标还差 '+amount(gap)+'。':'已报'+kind+'已达到已分配的月度目标。';
    const basis='已报 '+amount(actual)+'，目标 '+amount(target)+'，完成 '+pct(actual/target)+'。';
    const complete=inUnits?sum.qtyComplete:sum.revenueComplete;
    const remaining=assigned.map(r=>r.window.monthDays-r.window.expectedDays);
    let action=reason;
    if(!complete)action+='有日报或金额待补，差额会随补报变化。';
    else if(gap&&remaining[0]>0&&remaining.every(n=>n===remaining[0]))action+='剩余 '+remaining[0]+' 天，平均每天还需 '+amount(inUnits?Math.ceil(gap/remaining[0]):gap/remaining[0])+'。';
    const details=assigned.map(r=>r.site+' '+r.channel+'　'+kind+'目标 '+amount(inUnits?r.target.quantity:r.target.revenue_cny));
    if(targetRanking&&(!site||byPlatform)){
      const ready=shown.filter(r=>r.assigned===r.scopeCount&&(inUnits?r.qtyComplete:r.revenueComplete));
      const rate=inUnits?'quantityAchievement':'achievement',comparable=ready.filter(r=>Number.isFinite(r[rate]));
      if(comparable.length<2)return {...result(''),...briefing('还排不出'+groupName+'目标完成率的高低。','目标和实际销售均可核的只有 '+comparable.length+'/'+shown.length+' 个'+groupName+'。','请运营主管先核对任务分配和日报。',header,details)};
      const first=extreme(comparable,rate,order);
      return {...result(''),...briefing(names(first)+'的'+kind+'目标完成率'+(order==='asc'?'最低':'最高')+'。','已完成 '+pct(first[0][rate])+'，共 '+comparable.length+' 个'+groupName+'可比。',reason,header,details)};
    }
    return {...result(''),...briefing(headline,basis,action,header,details)};
  }
  const mixed=metric==='mix'||metric==='adValue';
  const needsSales=metric!=='spend',needsSpend=mixed||metric==='spend'||metric==='efficiency';
  const key={units:'qty',sales:'revenueCny',mix:'revenueCny',adValue:'revenueCny',spend:'adCostCny',efficiency:'roas'}[metric];
  const metricLabel={units:'销量',sales:'销售额',mix:'销售额',adValue:'销售额',spend:'广告费',efficiency:'全店销售额／广告费'}[metric];
  const amount=(r)=>metric==='units'?r.qty+' 件':metric==='efficiency'?r.roas.toFixed(2)+' 倍':money(r[key]);
  const sorted=[...shown].sort((a,b)=>a[key]==null||b[key]==null?Number(a[key]==null)-Number(b[key]==null):(order==='asc'?1:-1)*(a[key]-b[key]));
  const known=sorted.filter(r=>r[key]!=null);
  const relevant=!restricted&&['mix','adValue','sales','spend'].includes(metric)?all:shown;
  const missing=relevant.filter(r=>needsSales&&!(metric==='units'?r.qtyComplete:r.revenueComplete)||needsSpend&&!r.costComplete);
  const rankable=known.length>=2,one=shown.length===1?shown[0]:null;
  let lead='',basis='',action='';
  let focus=one||known[0];
  const comparable=shown.filter(r=>r.gap!=null);
  const gaps=extreme(comparable,'gap','desc');
  if(one){
    lead=one.site+'这段时间的记录'+(mixed?'里，':'里，'+metricLabel+'为')+(mixed?one.text:one[key]==null?'待核实':amount(one))+'。';
    if(restricted)lead=lead.replace(/（占 [\d.]+%）/g,'');
    if(metric==='adValue')basis='是否回本还需要广告带来的订单收入和对应成本。';
  }else if(mixed&&comparable.length>=2&&gaps[0].gap>0){
    focus=gaps[0];
    lead='按已报广告费，优先复核'+names(gaps)+'。';
    basis=focus.site+'广告费占比 '+pct(focus.adShare)+'，销售额占比 '+pct(focus.salesShare)+'，相差 '+(focus.gap*100).toFixed(1)+' 个百分点。';
    if(metric==='mix'&&rankable)basis+='按已报数据，'+names(extreme(known,key,order))+'的销售额'+(order==='asc'?'最低':'最高')+'。';
    if(metric==='adValue')basis+='是否回本还要核对广告带来的订单和成本。';
  }else if(mixed){
    lead=comparable.length<2?'暂时看不出哪个'+groupName+'的广告钱更值得花。':'目前可比较的 '+comparable.length+' 个'+groupName+'里，广告费份额都没有高过销售额份额。';
    if(rankable&&metric==='mix')basis='按已报数据，'+names(extreme(known,key,order))+'的销售额'+(order==='asc'?'最低':'最高')+'。';
    if(comparable.length<2){
      basis+='有可比数据的'+groupName+'不足两个。';
      if(known.length===1)basis+=known[0].site+'已报销售额 '+money(known[0].revenueCny)+'。';
    }
    else if(metric==='adValue')basis='要判断是否回本，还缺广告带来的订单收入和对应成本。';
  }else if(context.aggregate){
    const subset=rows.filter(r=>shown.some(s=>s.site===r[axis])),summary=summarizeTargets(subset);
    lead=summary[key]==null?'目前还没有可核对的'+metricLabel+'。':'所查范围已报'+metricLabel+'合计 '+amount(summary)+'。';
    basis='共 '+shown.length+' 个'+groupName+'，其中 '+known.length+' 个有已报数据。';
  }else if(rankable){
    const first=extreme(known,key,order);
    lead='按已报数据，'+names(first)+'的'+metricLabel+(order==='asc'?'最低':'最高')+'。';
    basis=(first.length>1?'并列站点均为':first[0].site+'为')+amount(first[0])+'，共有 '+known.length+' 个'+groupName+'可比。';
  }else{
    lead='有可比数据的'+groupName+'不足两个，暂时排不出先后。';
    if(known.length)basis=known[0].site+'已报'+metricLabel+' '+amount(known[0])+'。';
  }
  if(missing.length){
    const check=focus&&missing.includes(focus)?focus:missing[0];
    const counts=[];
    if(needsSales&&!check.revenueComplete)counts.push('完整日报 '+check.completeDays+'/'+check.expectedDays);
    if(needsSpend&&!check.costComplete)counts.push('广告 '+check.adDays+'/'+check.expectedDays);
    action=check.site+'还有待核数据'+(counts.length?'（'+counts.join('，')+' 个平台日）':'')+'。'+(needsSpend?'先让运营补记录、财务核对广告费，再定预算。':'请运营核对日报，补齐后再定结论。');
  }else if(mixed)action='可请运营核对广告带来的订单，由财务核算这些订单的利润。';
  if(metric==='efficiency')basis+=(basis?' ':'')+'分母是实际广告费，分子是全店销售额。广告归因还要看平台记录。';
  if(follow&&mixed&&asksWhy(q)&&focus?.gap!=null&&!restricted){
    basis=focus.site+'报了 '+money(focus.adCostCny)+' 广告费，'+(byPlatform?'两个平台':'五站')+'合计 '+money(total.adCostCny)+'，占 '+pct(focus.adShare)+'。销售额是 '+money(focus.revenueCny)+'，占'+(byPlatform?'两个平台':'五站')+' '+money(total.revenueCny)+' 的 '+pct(focus.salesShare)+'。';
    if(metric==='adValue')basis+='广告是否回本还要看广告带来的订单。';
  }
  if(follow&&asksOwner(q)&&focus){
    const assigned=rows.filter(r=>r[axis]===focus.site);
    const owners=assigned.filter(r=>r.ownerValid&&r.ownerName).map(r=>(byPlatform?r.site:r.channel)+' 由'+r.ownerName+'负责');
    const unassigned=assigned.filter(r=>!r.ownerValid).map(r=>byPlatform?r.site:r.channel);
    lead='先找'+focus.site+'的月度任务负责人。';
    basis=[...owners,unassigned.length?unassigned.join('、')+' 还没有有效的任务负责人，请运营主管指定':''].filter(Boolean).join('。')+'。';
    action=needsSpend?'运营核对成交和广告记录，财务核对广告费。':'请负责人核对本站销售日报。';
  }
  if(restricted)basis+=(basis?' ':'')+'仅含你负责的'+site+' '+channel+'。';
  const details=sorted.map(r=>r.site+'　'+(restricted?r.text.replace(/（占 [\d.]+%）/g,''):r.text));
  for(const r of missing)details.push(r.site+'　'+[needsSales?'日报 '+r.completeDays+'/'+r.expectedDays:'',needsSpend?'广告 '+r.adDays+'/'+r.expectedDays:''].filter(Boolean).join('，'));
  if(!restricted&&mixed)details.push('占比分母为'+(byPlatform?'所选站点两个平台':'所选平台五站')+'已报合计，补报后会变化。');
  if(rows.some(r=>r.unconverted||r.repeatedDays||needsSales&&r.revenueMissing&&r.completeDays===r.expectedDays))details.push('还有缺失金额、换汇或疑似重复的广告记录需要核对。');
  if(metric!=='units')details.push(report.fx.status==='unavailable'?'参考汇率暂不可用，外币金额待补。':'金额按任务台账参考汇率折算人民币'+(report.fx.effectiveAt?'（'+report.fx.effectiveAt.slice(0,10)+'）':'')+'。');
  return {...result('',restricted?[]:[month+'只看TikTok各站销售贡献与广告投入',month+'只看Shopee各站销售贡献与广告投入'].filter(x=>!channel||!x.includes(channel))),...briefing(lead,basis,action,header,details)};
}
