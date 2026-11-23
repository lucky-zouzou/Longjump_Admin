"use client";
import {useState} from 'react';
type R=Record<string,any>;
export default function PerformanceSummary(){
 const [data,setData]=useState<R|null>(null),[error,setError]=useState('');
 async function load(){setError('');try{const r=await fetch('/api/system-performance',{cache:'no-store'});if(!r.ok)throw Error('当前预览环境未启用服务器性能采样');setData(await r.json());}catch(e){setError((e as Error).message);}}
 return <details className="overview-card" onToggle={e=>{if(e.currentTarget.open&&!data)void load();}}><summary>管理员 · 读取速度诊断</summary><p>最近30分钟，每个接口／页面分组最多300次请求。P95 是95%的服务端请求完成时间上限；不含浏览器渲染和用户网络时间。此页面不会读取业务明细。</p><button className="btn" onClick={()=>void load()}>刷新采样</button>{error&&<p role="status">{error}</p>}<div className="table-wrap"><table><thead><tr><th>接口</th><th>样本</th><th>中位数 / P95</th><th>超过1秒 / 服务错误</th></tr></thead><tbody>{data?.rows.map((r:R)=><tr key={[r.path,r.module,r.navigation].join('|')}><td>{r.path}{r.module&&<small>{r.module} · {({page:'页面首屏',tasks:'导航待办',shell:'身份与导航'} as R)[r.navigation]||'完整读取'}</small>}</td><td>{r.count}</td><td>{r.p50} / {r.p95} ms</td><td>{r.slow} / {r.errors}</td></tr>)}</tbody></table></div>{data&&!data.rows.length&&<p>暂未采集到接口请求。</p>}</details>;
}
