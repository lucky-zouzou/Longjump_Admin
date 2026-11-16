import {costAccess} from './cost-profit.mjs';
import {navigationForRole} from './permissions.mjs';

const sites=[['印尼','印度尼西亚','印尼'],['马来西亚','马来西亚','大马'],['泰国','泰国'],['越南','越南'],['菲律宾','菲律宾']];
const channels=[['TikTok',/tiktok|抖音|\btk\b/i],['Shopee',/shopee|虾皮/i]];
export function ledgerQuestion(question){
 return /(库存|在途|销售额|利润|销量|销售数量|回款|广告费|广告消耗)/.test(question)&&/(多少|几[件笔个]|查一下|查一查|查查|还有几|剩几)/.test(question);
}
export async function answerLedger(db,actor,q,at){
 const nav=navigationForRole(actor.role);
 const time=new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
 const make=(answer,page='',label='',questions=[],view='')=>({answer,intent:'live',source:'ledger',guide:null,notice:'',ledger:nav.includes(page)?{page,label,view}:null,questions});
 const ops=actor.role==='运营',askedSites=sites.filter(([, ...names])=>names.some(name=>q.includes(name))).map(([name])=>name);
 const askedChannels=channels.filter(([,re])=>re.test(q)).map(([name])=>name);
 if(ops&&(askedSites.some(site=>site!==actor.site)||askedChannels.some(ch=>ch!==actor.channel)))return make('你的账号可以查'+actor.site+' · '+actor.channel+'。可以换成本站点和渠道再问我。');
 if(!/库存|在途/.test(q)){
   if(/利润/.test(q)){
     try{await costAccess(db,actor);}catch(e){if(e.status!==403)throw e;return make('你的账号暂时没有利润账册读取权限，请由负责财务核对或请管理员配置。');}
     return make('到成本利润工作区选月份和站点，核对已确认的贡献利润和仍待补齐的费用。','cost-profit','看成本与利润',[],'evidence');
   }
   if(/回款/.test(q)){
     if(['管理员','财务'].includes(actor.role))return /线下|批发|分销/.test(q)?make('线下回款按银行凭证和核销记录查看。','wholesale','看线下回款',[],'finance'):make('平台到账按资金账册核对；查印尼线下客户时，可以问“线下回款有几笔”。','cost-profit','看资金与月结',[],'finance');
     return actor.role==='销售'?make('在本人负责的线下客户订单中看已确认的回款。','wholesale','看客户订单'):make('你当前的岗位没有回款账册权限，可请财务按到账日期核对。');
   }
   if(nav.includes('sales'))return make(/广告/.test(q)?'在销售日报中按站点、日期核对广告费；缺填金额仍需补凭据。':'到销售台账选日期、站点和渠道，查看已导入的销量及完整日报天数。','sales','看销售台账');
   if(actor.role==='财务'){
     try{await costAccess(db,actor);}catch(e){if(e.status!==403)throw e;return make('此账号没有销售明细或结算证据的读取权限，请联系管理员核对授权。');}
     return make('选定站点和期间，按结算收入或实际费用口径核对；平台销售额与实际到账分开查看。','cost-profit','看结算证据',[],'evidence');
   }
   return make('当前岗位没有这份销售台账的访问权限。');
 }
 const inventory=nav.includes('inventory')?'inventory':actor.role==='财务'?'cost-profit':'';
 if(!inventory)return make('当前岗位没有可售库存明细权限，可请本站运营或供应链核对。');
 const site=askedSites.length===1?askedSites[0]:(ops?actor.site:''),channel=askedChannels.length===1?askedChannels[0]:(ops?actor.channel:'');
 const scope=[site||'五站',channel||'TikTok + Shopee'].join(' · ');
 if(/在途|海运/.test(q))return nav.includes('batches')?make('在途按运输分批的实际发出及到仓情况查看。','batches','查海运批次'):make('运输批次请由有权限的供应链同事核对。');
 if(askedSites.length>1||askedChannels.length>1||/昨天|昨日|上周|上月|月末|过去|去年|截至|\d{4}[-年]/.test(q))return make('要查某天或对比多个范围，可以在台账中核对对应记录。',inventory,'打开库存来源');
 const skuMatch=q.match(/(?:\bSKU\s*[:：]?\s*)?\b([A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+)\b/i)||q.match(/\bSKU\s*[:：]?\s*([A-Za-z0-9]+)/i);
 let rest=skuMatch?q.replace(skuMatch[0],''):q;
 for(const [, ...names] of sites)for(const name of names)rest=rest.replaceAll(name,'');
 rest=rest.replace(/TikTok|Shopee|\bTK\b|虾皮|抖音|现在|当前|全部|全站|五站|所有|两个平台|站点|站|平台|渠道|请问|请|帮我|我想|查一下|查一查|查查|还有|还剩|有|剩|可售|可卖|能卖|账面|库存|数量|一共|总共|合计|多少|几件|件|是|的|货|呢|吗|呀|[\s，。！、？?,.：:]/gi,'');
 if(rest||!site&&!/五站|全部|全站|所有/.test(q))return make('想查哪个站点或 SKU？可以这样问：“印尼现在可售库存有多少件？”',inventory,'打开库存台账');
 const prefix=(site||'五站')+(channel?' '+channel:'')+(skuMatch?' SKU '+skuMatch[1]:'');
 if(!/可售|可卖|能卖|账面/.test(q))return make('你想看能卖多少件，还是账面共多少件？可售库存已经扣除预留。',inventory,'查库存来源',[prefix+'可售库存有多少件？',prefix+'账面库存有多少件？']);
 const predicates=["site IN ('印尼','马来西亚','泰国','越南','菲律宾')","channel IN ('TikTok','Shopee')"],args=[];
 if(site){predicates.push('site=?');args.push(site);}if(channel){predicates.push('channel=?');args.push(channel);}
 if(skuMatch){predicates.push('sku=? COLLATE NOCASE');args.push(skuMatch[1]);}
 const book=q.includes('账面'),valid=book?'qty>=0':'qty>=0 AND reserved_qty>=0 AND qty>=reserved_qty';
 const result=await db.prepare('SELECT COUNT(*) n, SUM(CASE WHEN '+valid+' THEN '+(book?'qty':'qty-reserved_qty')+' END) units, SUM(CASE WHEN '+valid+' THEN 0 ELSE 1 END) unknown,MAX(updated_at) latest FROM inventory_balances WHERE '+predicates.join(' AND ')).bind(...args).first();
 const name=scope+(skuMatch?' · '+skuMatch[1]:'')+'的'+(book?'账面库存（扣预留前）':'可售库存');
 if(!result?.n||result.units==null)return make(name+'目前没有可核对的数量。请到来源台账补查。',inventory,'查库存来源');
 const stamp=time+'（北京时间）';
 return make(name+'：已记录'+Number(result.units).toLocaleString('zh-CN')+' 件。'+(result.unknown?result.unknown+' 条库存异常，已排除。':'')+'查询时间 '+stamp+'；最近一笔库存更新 '+String(result.latest)+'。',inventory,'看库存来源');
}
