import {answerPlanProgress} from './employee-plan-progress.mjs';
import {answerDecision,answerPriority,answerProduction} from './employee-decisions.mjs';
import {loadForecast} from './forecast.ts';
import {forecastChanges} from './forecast-observations.mjs';
import {navigationForRole} from './permissions.mjs';
import {localDay} from './promotion-model.mjs';
const labels={production:'补货生产测算',priority:'经营行动优先级',profit:'贡献利润',sales:'销售额',ad_efficiency:'广告投放效率',plan:'月度备货进度'};
const prompts={production:'建议生产依据',priority:'今天先盯哪件急事',profit:'利润多少',sales:'销售额多少',ad_efficiency:'广告投放效率怎么样',plan:'备货计划到哪一步了'};
export const ambiguousBusiness=q=>/经营|业绩|生意|备货|货够|库存|投放|广告|生产|排产|回款|贡献|盈利|赚|亏|卖货/.test(q)&&!/怎么(?:填|录入|导入|操作)|按钮|手册|密码|账号/.test(q);
export async function chooseBusinessTool(question,{apiKey,request=fetch,signal,model='gpt-5.4-mini'}){
 const ctl=AbortSignal.timeout(8000);
 const response=await request('https://api.openai.com/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+apiKey,'Content-Type':'application/json'},signal:signal?AbortSignal.any([signal,ctl]):ctl,body:JSON.stringify({model,store:false,max_output_tokens:100,reasoning:{effort:'none'},instructions:'只选择最符合用户明确问题的只读业务查询。不要回答数字，不执行操作，不推断缺失的站点或日期。询问操作步骤、回款、库存金额、模糊范围或无法对应工具时选 unknown。production=补货生产建议；priority=经营行动优先级；profit=已核贡献利润；sales=销售额；ad_efficiency=广告效率；plan=月度备货履约进度。',input:question,text:{format:{type:'json_schema',name:'business_tool',strict:true,schema:{type:'object',properties:{tool:{type:'string',enum:[...Object.keys(labels),'unknown']}},required:['tool'],additionalProperties:false}}}})});
 if(!response.ok)throw Error('business_router_unavailable');
 const data=await response.json(),text=data.output?.flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('')||data.output_text;
 const selected=JSON.parse(text||'{}');return Object.hasOwn(labels,selected.tool)?selected.tool:null;
}
export async function dispatchBusinessTool(tool,db,actor,input,now){
 if(!Object.hasOwn(labels,tool))return null;
 // Preserve the full original question, dates and scopes. Every reader rechecks role/scope.
 const question=input.question+'；'+prompts[tool];
 const result=tool==='plan'?await answerPlanProgress(db,actor,question,now,input.planContext):tool==='production'?await answerProduction(db,actor,question,now,input.previous,input.productionContext):tool==='priority'?await answerPriority(db,actor,question,now,input.decisionContext):await answerDecision(db,actor,question,now,input.decisionContext);
 return result?{...result,notice:'我按“'+labels[tool]+'”核对了当前台账；范围和依据在下方。'}:null;
}
export async function answerForecastChanges(db,actor,question,now){
 if(!/生产|备货|补货/.test(question)||!/每天.{0,5}变|天天.{0,5}变|建议.{0,8}变|变化.{0,5}(?:原因|依据)|比昨天/.test(question))return null;
 if(!navigationForRole(actor.role).includes('suggestions'))return {source:'ledger',intent:'live',guide:null,notice:'',answer:'当前账号不能查看生产测算，请供应链同事核对。'};
 const aliases={'马来西亚':/马来|大马/,'印尼':/印尼|印度尼西亚/,'泰国':/泰国/,'越南':/越南/,'菲律宾':/菲律宾/};
 const sites=Object.keys(aliases).filter(s=>aliases[s].test(question));
 const channels=['TikTok','Shopee'].filter(c=>(c==='TikTok'?/TikTok|\bTK\b/i:/Shopee|虾皮/i).test(question));
 if(actor.role==='运营'&&(sites.some(s=>s!==actor.site)||channels.some(c=>c!==actor.channel)))return {source:'ledger',intent:'live',guide:null,notice:'',answer:'你可以核对自己站点和平台的生产建议，跨站信息请运营主管查看。'};
 const match=question.match(/\bSKU\s*[:：]?\s*([a-z0-9][a-z0-9_-]{0,79})\b|\b([a-z][a-z0-9]*(?:[-_][a-z0-9]+)+)\b/i);
 const sku=match?.[1]||match?.[2];
 const scopeSites=actor.role==='运营'?[actor.site]:sites.length?sites:Object.keys(aliases),dates=[...new Set(scopeSites.map(s=>localDay(new Date(now),s)))];
 const suggestions=[];for(const day of dates){const part=await loadForecast(db,actor,day);suggestions.push(...part.suggestions.filter(r=>localDay(new Date(now),r.site)===day));}
 const rows=suggestions.filter(r=>(!sites.length||sites.includes(r.site))&&(!channels.length||channels.includes(r.channel))&&(!sku||r.sku.toLowerCase()===sku.toLowerCase()));
 const change=await forecastChanges(db,actor,rows),qty=rows.reduce((s,r)=>s+(r.suggestedProduction??0),0),pending=rows.filter(r=>r.recommendationReady===false).length;
 const differences=change.items.filter(r=>r.delta!=null&&r.delta!==0).sort((a,b)=>Math.abs(b.delta)-Math.abs(a.delta));
 return {source:'ledger',intent:'live',guide:null,notice:'',answer:!rows.length?'这个范围暂时没有可核对的生产测算。':`核对范围：${sites.join('、')||(actor.role==='运营'?actor.site:'全部可见站点')} / ${channels.join('、')||(actor.role==='运营'?actor.channel:'全部平台')}${sku?' / '+sku:''}。\n当前可计算部分建议新增生产 ${qty} 件，${pending} 项资料待补。\n`+(change.delta==null?'昨日还没有同口径快照，不能准确说增减多少。':`可比的 ${change.comparable} 项比昨日${change.delta>=0?'增加':'减少'} ${Math.abs(change.delta)} 件；另 ${change.pending} 项不可直接比较。`)+ '\n销量窗口每天滚动，库存、活动和交期也会更新。建议变化不会改动已批准订单。',brief:{period:now.slice(0,10),details:differences.slice(0,5).map(r=>`${r.site} / ${r.channel} / ${r.sku}：${r.delta>0?'+':''}${r.delta} 件；${r.reasons.join('；')}`)},ledger:{page:'suggestions',label:'查看每日测算依据'}};
}
