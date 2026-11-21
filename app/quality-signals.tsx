"use client";
import {qualitySignals} from '../lib/business-insights.mjs';
type R=Record<string,any>;
export default function QualitySignals({records,onSelect}:{records:R[];onSelect:(id:string)=>void}){
 const groups=qualitySignals(records);
 return <section className="panel"><h3>重复反馈与整改提醒</h3><p>按本月、站点、SKU 和反馈原因归组，展示优先关注的前 15 组。条数是反馈记录，不当作不良率；同一问题沿原单跟进。</p><div className="table-wrap"><table><thead><tr><th>商品 / 现象</th><th>反馈记录 / 件数</th><th>整改逾期 / 复查未通过</th><th>每周反馈条数</th><th>追溯</th></tr></thead><tbody>{groups.slice(0,15).map((g:R)=><tr key={g.key}><td>{g.site} · {g.sku}<small>{g.reason}</small></td><td>{g.count} / {g.qty}</td><td>{g.overdue} / {g.failed}</td><td>{Object.entries(g.weekly).sort().map(([week,count])=><small key={week}>{week} 起：{String(count)} 条</small>)}</td><td><button className="btn" onClick={()=>onSelect(g.caseIds[0])}>查看原记录</button></td></tr>)}</tbody></table></div>{!groups.length&&<p>当前月份暂无已提交反馈。</p>}</section>;
}
