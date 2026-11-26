'use client';
import './distribution-flow-summary.css';
type Step={label:string;done:boolean;current?:boolean};
export default function DistributionFlowSummary({title,subtitle,steps,tracks,children}:{title:string;subtitle:string;steps:Step[];tracks:{label:string;value:string;note?:string;warning?:boolean}[];children?:React.ReactNode}){
 return <section className="distribution-flow-summary" aria-label={title}>
  <div className="dfs-heading"><div><h4>{title}</h4><p>{subtitle}</p></div>{children}</div>
  <ol className="dfs-steps">{steps.map((s,i)=><li key={s.label} className={s.done?'done':s.current?'current':''} aria-current={s.current?'step':undefined}><span aria-hidden="true">{s.done?'✓':String(i+1).padStart(2,'0')}</span><strong>{s.label}</strong></li>)}</ol>
  <div className="dfs-tracks">{tracks.map(t=><div key={t.label} className={t.warning?'warning':''}><span>{t.label}</span><strong>{t.value}</strong>{t.note&&<p>{t.note}</p>}</div>)}</div>
 </section>;
}
