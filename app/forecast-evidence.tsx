"use client";
type Row=Record<string,any>;
export default function ForecastEvidence({row:r}:{row:Row}){
 const curve=r.projection?.curve||[];
 return <section className="panel"><h3>这款货怎么安排 · {r.sku}</h3>
 <p>{r.recommendationReady===false?'资料还不齐，先核实再确定数量。':`建议净新增生产 ${r.suggestedProduction} 件；覆盖 ${r.horizonDays} 天，目标库存 ${r.targetQty} 件，其中安全库存 ${r.safetyStock} 件。`}</p>
 <p>预计缺货：{r.projection?(r.projection.firstShortageDate||'当前已知范围内未出现'):'资料不足，暂不能判断'}。{r.unknownProductionQty>0&&`另有 ${r.unknownProductionQty} 件在产缺有效交付承诺，已抵扣新增生产量，但未当作按时到仓。`}</p>
 <p>{r.change?.delta==null?'暂无同口径昨日数量可比较':`较昨日${r.change.delta>=0?'增加':'减少'} ${Math.abs(r.change.delta)} 件`} · {(r.change?.reasons||[]).join('；')}</p>
 <div className="table-wrap"><table><thead><tr><th>建议动作</th><th>依据</th></tr></thead><tbody>{(r.actions||[]).map((a:Row)=><tr key={a.kind}><td>{a.label}{a.qty!=null?` · ${a.qty} 件`:''}</td><td>{a.reason}{a.date?' · '+a.date:''}</td></tr>)}</tbody></table></div>
 <details><summary>查看每天需求、到仓与缺口</summary><p>活动只影响登记的起止日期；预计供应不等于仓库实收。缺口为可能损失的需求，不自动转成欠单。</p><div className="table-wrap" style={{maxHeight:360,overflow:'auto'}}><table><thead><tr><th>日期</th><th>预计需求</th><th>预计到仓</th><th>预计结余</th><th>当天缺口</th></tr></thead><tbody>{curve.map((d:Row)=><tr key={d.date}><td>{d.date}</td><td>{d.demand.toFixed(1)}</td><td>{d.arrivalQty}</td><td>{Math.floor(d.closingQty)}</td><td>{Math.ceil(d.unmetDemand)}</td></tr>)}</tbody></table></div>{!curve.length&&<p>请先补齐有效销量和库存。</p>}</details>
 </section>;
}
