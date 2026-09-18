"use client";
import {useId,useMemo,useState} from 'react';
import {chartDays,chartScale} from '../lib/sales-charts.mjs';
type Row=Record<string,any>;
const fmt=(value:number)=>value.toLocaleString('zh-CN',{maximumFractionDigits:2});
const compact=(value:number)=>new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(value);

export function SalesTrend({rows,from,to,mode,currency}:{rows:Row[];from:string;to:string;mode:'qty'|'money';currency:string}){
  const id=useId().replace(/:/g,''),points=useMemo(()=>chartDays(rows,from,to),[rows,from,to]),[hover,setHover]=useState<number|null>(null);
  const series=mode==='qty'?[{key:'qty',label:'净销量',color:'#3763eb'}]:[{key:'revenue',label:'销售额',color:'#3763eb'},{key:'adCost',label:'投放成本',color:'#e39b23'}];
  const scale=chartScale(points.flatMap(p=>series.map(s=>p[s.key as keyof typeof p] as number|null)));
  const x=(i:number)=>72+i/Math.max(1,points.length-1)*700,y=(v:number)=>230-(v-scale.min)/(scale.max-scale.min)*196;
  const active=points[hover===null?points.length-1:Math.min(hover,points.length-1)],hasData=points.some(p=>series.some(s=>p[s.key as keyof typeof p]!==null));
  const paths=(key:string)=>{const groups:Array<Array<{i:number;v:number}>>=[];let group:Array<{i:number;v:number}>=[];points.forEach((p,i)=>{const v=p[key as keyof typeof p];if(typeof v!=='number'){if(group.length)groups.push(group);group=[];}else group.push({i,v});});if(group.length)groups.push(group);return groups;};
  return <div className="visual-trend">
    <div className="chart-legend">{series.map(s=><span key={s.key}><i style={{background:s.color}}/>{s.label}{mode==='money'?` · ${currency}`:' · 件'}</span>)}<span className="chart-note">空缺日期断开显示</span></div>
    {!hasData?<div className="chart-empty">{mode==='money'?'还没有金额完整的记录，可先查看销量趋势':'所选范围暂无销量记录'}</div>:<div className="chart-plot"><svg viewBox="0 0 800 280" role="img" aria-label={`${from}至${to}${mode==='qty'?'净销量':'销售额与投放成本'}趋势，左右方向键查看日期`} tabIndex={0} onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setHover(i=>Math.max(0,Math.min(points.length-1,(i??points.length-1)+(e.key==='ArrowRight'?1:-1))));}}} onMouseMove={e=>{const box=e.currentTarget.getBoundingClientRect(),px=(e.clientX-box.left)/box.width*800;setHover(Math.max(0,Math.min(points.length-1,Math.round((px-72)/700*(points.length-1)))));}} onMouseLeave={()=>setHover(null)}>
      <title>{mode==='qty'?'每天净销售件数':'同币种销售额和广告成本'}；缺失或不完整金额不补零</title>
      <defs><linearGradient id={`${id}-area`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3763eb" stopOpacity=".22"/><stop offset="100%" stopColor="#3763eb" stopOpacity=".015"/></linearGradient></defs>
      {scale.ticks.map(v=><g key={v}><line x1="72" x2="772" y1={y(v)} y2={y(v)} stroke={v===0?'#aebcd2':'#e7edf5'} strokeDasharray={v===0?'0':'4 5'}/><text x="60" y={y(v)+5} textAnchor="end">{compact(v)}</text></g>)}
      {series.map(s=><g key={s.key}>{paths(s.key).map((group,index)=>{const d=group.map((p,i)=>`${i?'L':'M'}${x(p.i)},${y(p.v)}`).join(' ');return <g key={index}>{mode==='qty'&&group.length>1&&<path d={`${d} L${x(group.at(-1)!.i)},${y(0)} L${x(group[0].i)},${y(0)} Z`} fill={`url(#${id}-area)`}/>}<path d={d} stroke={s.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none"/>{group.map(p=><circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={points.length>65?2:3.5} fill={s.color}><title>{points[p.i].date} {s.label}：{fmt(p.v)}</title></circle>)}</g>;})}</g>)}
      {hover!==null&&<line x1={x(hover)} x2={x(hover)} y1="24" y2="238" stroke="#8191ab" strokeDasharray="4 4"/>}
      {[0,Math.floor((points.length-1)/2),points.length-1].filter((n,i,a)=>a.indexOf(n)===i).map(i=><text key={i} x={x(i)} y="264" textAnchor={i===0?'start':i===points.length-1?'end':'middle'}>{points[i]?.date.slice(5)}</text>)}
    </svg></div>}
    <div className="chart-readout" aria-live="polite"><span>{active?.date||'—'}</span>{series.map(s=><strong key={s.key} style={{color:s.color}}>{s.label} {active&&typeof active[s.key as keyof typeof active]==='number'?`${fmt(active[s.key as keyof typeof active] as number)} ${mode==='qty'?'件':currency}`:'未完整填报'}</strong>)}</div>
  </div>;
}

export function RankingBars({rows,valueKey,labelKey='sku',unit='件',color='blue',limit=10,onSelect}:{rows:Row[];valueKey:string;labelKey?:string;unit?:string;color?:'blue'|'teal'|'mixed';limit?:number;onSelect?:(sku:string)=>void}){
  const items=rows.slice(0,limit),max=Math.max(1,...items.map(r=>Math.abs(Number(r[valueKey])||0))),negative=items.some(r=>r[valueKey]<0);
  if(!items.length)return <div className="chart-empty">暂无可展示数据</div>;
  return <div className={`ranking-bars ${negative?'has-negative':''}`} role="list" aria-label={`${unit==='×'?'投产比':'数量'}排名，显示前${limit}名`}>
    {items.map((r,i)=>{const value=Number(r[valueKey])||0,label=String(r[labelKey]||'—'),width=Math.abs(value)/max*(negative?50:100),start=negative?(value<0?50-width:50):0;
      return <div className="ranking-bar-row" role="listitem" key={`${label}-${i}`}><span className={`ranking-position ${i<3?'leading':''}`}>{r.rank??i+1}</span><div className="ranking-main"><div className="ranking-caption">{onSelect?<button onClick={()=>onSelect(r.sku)} title={r.name||label}>{label}</button>:<span>{label}</span>}<strong>{fmt(value)} <small>{unit}</small></strong></div><div className="ranking-track"><span className={`ranking-fill ${color} ${value<0?'negative':''}`} style={{width:`${width}%`,left:`${start}%`,...(color==='mixed'?{background:['#3763eb','#17a58c','#8a66d9','#e39b23','#56788d'][i%5]}:{})}}/>{negative&&<i className="ranking-zero"/>}</div></div></div>;
    })}
  </div>;
}
