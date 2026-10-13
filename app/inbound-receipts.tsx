"use client";
import {useRef,useState} from 'react';
import {hasPermission} from '../lib/permissions.mjs';
import {parseImportGrid,validateImportRows,groupInboundRows} from '../lib/tabular-import.mjs';
import TableImport from './table-import';
// Receipt rows combine server snapshots, form values and import metadata.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row=Record<string,any>;
type Act=(action:string,payload:Row,success:string,onError?:(message:string)=>void)=>Promise<Row|null>;
const sites=['马来西亚','印尼','泰国','越南','菲律宾'],channels=['TikTok','Shopee','线下分销'];
const labels:Record<string,string>={available:'可售',pending:'待上架',quarantine:'隔离'};
const fmt=(n:unknown)=>Number(n||0).toLocaleString('zh-CN');
const today=()=>new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const emptyLine=()=>({sku:'',channel:'TikTok',warehouseCode:'',qty:'',sourceBatch:'',stockState:'available'});
function MovementTable({lines}:{lines:Row[]}){return <div className="table-wrap inbound-preview-table"><table><thead><tr>{['到仓单 / SKU','目的仓 / 渠道','本次新增','可售账面 · 前 → 后','待上架 · 前 → 后','隔离 · 前 → 后'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{lines.map((r,i)=><tr key={i}><td data-label="到仓单 / SKU">{r.receiptNo}<br/><strong>{r.sku}</strong><div className="cell-note">{r.name}</div></td><td data-label="目的仓 / 渠道">{r.site} · {r.channel}<br/>{r.warehouseName}<div className="cell-note">{r.warehouseCode}</div></td><td data-label="本次新增"><strong>+{fmt(r.qty)}</strong> · {labels[r.stockState]}</td>{['available','pending','quarantine'].map(k=><td key={k} data-label={`${labels[k]} · 前 → 后`}>{fmt(r.before[k])} → <strong>{fmt(r.after[k])}</strong></td>)}</tr>)}</tbody></table></div>;}
function Summary({value}:{value:Row}){return <div className="inbound-summary">{[['到仓单',value.documents,'张'],['商品',value.skuCount,'个SKU'],['实收合计',value.totalQty,'件'],['新增可售',value.available,'件'],['新增待上架',value.pending,'件'],['新增隔离',value.quarantine,'件']].map(([title,n,unit])=><div key={String(title)}><span>{title}</span><strong>{fmt(n)} <small>{unit}</small></strong></div>)}</div>;}

export default function InboundReceipts({data,act,busy}:{data:Row;act:Act;busy:boolean}){
  const [header,setHeader]=useState({receiptNo:'',businessDate:today(),site:sites[0],proofRef:'',note:''});
  const [lines,setLines]=useState<Row[]>([emptyLine()]),[mode,setMode]=useState('manual'),[paste,setPaste]=useState('');
  const [imported,setImported]=useState<Row[]|null>(null),[meta,setMeta]=useState<Row>({}),[importKey,setImportKey]=useState(0);
  const [preview,setPreview]=useState<Row|null>(null),[result,setResult]=useState<Row|null>(null),[confirmed,setConfirmed]=useState(false);
  const [working,setWorking]=useState(false),[error,setError]=useState(''),[errors,setErrors]=useState<Row[]>([]);
  const lock=useRef(false),previewRef=useRef<HTMLElement>(null),resultRef=useRef<HTMLElement>(null);
  const editable=hasPermission(data.actor.role,'inbound.receive');
  const documents=data.inboundDocuments||[];
  const clearFeedback=()=>{setError('');setErrors([]);setPreview(null);setConfirmed(false);};
  const manualRows=()=>lines.map((l,i)=>({...header,...l,name:'',_row:i+2}));
  const updateLine=(i:number,patch:Row)=>{clearFeedback();setLines(lines.map((r,j)=>j===i?{...r,...patch}:r));};
  const loadRows=(rows:Row[],metadata:Row={})=>{clearFeedback();setImported(rows);setMeta(metadata);};
  const parsePaste=()=>{
    clearFeedback();setImported(null);
    try{const parsed=parseImportGrid('inbound',paste.split(/\r?\n/).map(r=>r.split('\t')),header);if(parsed.errors.length){setErrors(parsed.errors);return;}groupInboundRows(parsed.rows);loadRows(parsed.rows,{fileName:'表格粘贴'});}catch(e){setError(e instanceof Error?e.message:'请粘贴包含表头的表格');}
  };
  const prepare=async()=>{
    if(lock.current)return;lock.current=true;setWorking(true);clearFeedback();setResult(null);
    try{
      const rows=mode==='manual'?manualRows():imported;
      if(!rows?.length)throw Error('请先导入或粘贴商品明细');
      const parsed=validateImportRows('inbound',rows);
      if(parsed.errors.length){setErrors(parsed.errors);return;}groupInboundRows(parsed.rows);
      const response=await fetch('/api/system',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'previewInbound',rows:parsed.rows}),signal:AbortSignal.timeout(20000)});
      const body=await response.json();if(!response.ok){setErrors(body.errors||[]);throw Error(body.error||'预览失败');}
      setPreview(body);requestAnimationFrame(()=>previewRef.current?.scrollIntoView({behavior:'smooth',block:'start'}));
    }catch(e){setError(e instanceof Error&&e.name==='TimeoutError'?'预览超时，尚未写入库存，请重试':e instanceof Error?e.message:'预览失败');}
    finally{setWorking(false);lock.current=false;}
  };
  const submit=async()=>{
    if(lock.current||!preview||!confirmed)return;lock.current=true;setWorking(true);setError('');
    try{const saved=await act('receiveInbound',{rows:preview.rows,previewToken:preview.token,confirmed,...meta},'到仓入库成功，库存和流水已更新',setError);
      if(saved){setResult(saved);setPreview(null);setConfirmed(false);setImported(null);setPaste('');setMeta({});setLines([emptyLine()]);setHeader(h=>({...h,receiptNo:'',proofRef:'',note:''}));setImportKey(k=>k+1);requestAnimationFrame(()=>resultRef.current?.scrollIntoView({behavior:'smooth',block:'start'}));}
    }finally{setWorking(false);lock.current=false;}
  };
  return <div className="inbound-workspace">
    <div className="page-head"><div><h3>到仓入库</h3><p>一张到仓单可包含多个 SKU；先预览，确认后整单入库并生成回执。</p></div></div>
    {result&&<section className="panel inbound-result" ref={resultRef} tabIndex={-1} aria-label="入库回执"><div className="panel-head"><div><h4>✓ 入库成功</h4><p>单号：{result.receiptNos.join('、')} · 库存与流水已写入</p></div></div><Summary value={result.summary}/><p>可售部分已增加库存；待上架部分由站点运营确认上架；隔离部分请在“库存流水”验收放行或报损。以下为本次入库时的账面变化，未扣预留数量。</p><MovementTable lines={result.lines}/></section>}
    {editable&&<section className="panel"><div className="panel-head"><div><h4>新建到仓单</h4><p>单据资料填一次，商品明细可手工添加、Excel 导入或从表格粘贴。</p></div></div>
      <fieldset disabled={busy||working||Boolean(preview)} className="inbound-fieldset">
        <div className="inbound-header-grid">
          <label>到仓单号<input value={header.receiptNo} onChange={e=>{clearFeedback();setImported(null);setMeta({});setHeader({...header,receiptNo:e.target.value});}} placeholder="仓库签收单号，多SKU可共用"/></label>
          <label>实际到仓日期<input type="date" max={today()} value={header.businessDate} onChange={e=>{clearFeedback();setImported(null);setMeta({});setHeader({...header,businessDate:e.target.value});}}/></label>
          <label>站点<select value={header.site} onChange={e=>{clearFeedback();setImported(null);setMeta({});setHeader({...header,site:e.target.value});setLines(lines.map(r=>({...r,warehouseCode:''})));}}>{sites.map(s=><option key={s}>{s}</option>)}</select></label>
          <label>到仓凭证 / 文件编号<input value={header.proofRef} onChange={e=>{clearFeedback();setImported(null);setMeta({});setHeader({...header,proofRef:e.target.value});}} placeholder="真实签收单或共享文件编号，请勿填日期"/></label>
          <label className="inbound-note">入库说明 / 例外原因<input value={header.note} onChange={e=>{clearFeedback();setImported(null);setMeta({});setHeader({...header,note:e.target.value});}} placeholder="至少4个字，例如历史在途货物实际签收入库"/></label>
        </div>
        <div className="inbound-modes" role="group" aria-label="商品录入方式">{[['manual','手工添加商品'],['file','Excel / CSV 导入'],['paste','粘贴表格']].map(([value,label])=><button type="button" key={value} className={`btn ${mode===value?'primary':''}`} onClick={()=>{setMode(value);clearFeedback();setImported(null);setMeta({});setImportKey(k=>k+1);}}>{label}</button>)}</div>
        <p className="inbound-help">目的仓从主数据匹配，每个站点渠道使用一个启用的主目的仓。同一批实物分配给 TK / Shopee 时，填写各自份额，合计为本次实收；系统不会自动翻倍或覆盖原库存。</p>
        {mode==='manual'&&<><div className="table-wrap inbound-entry-table"><table><thead><tr><th>SKU / 商品</th><th>渠道 / 目的仓</th><th>本次实收</th><th>关联批次 / 入库状态</th><th>操作</th></tr></thead><tbody>{lines.map((r,i)=>{
          const warehouses=data.warehouses.filter((w:Row)=>w.site===header.site&&w.channel===r.channel&&w.active===1);
          return <tr key={i}><td data-label="SKU / 商品"><select aria-label={`第${i+1}行SKU`} value={r.sku} onChange={e=>updateLine(i,{sku:e.target.value,sourceBatch:'',stockState:'available'})}><option value="">选择 SKU</option>{data.skuSettings.map((s:Row)=><option key={s.sku} value={s.sku}>{s.sku} · {s.name}</option>)}</select></td><td data-label="渠道 / 目的仓"><select aria-label={`第${i+1}行渠道`} value={r.channel} onChange={e=>updateLine(i,{channel:e.target.value,warehouseCode:''})}>{channels.map(c=><option key={c}>{c}</option>)}</select><select aria-label={`第${i+1}行目的仓`} value={r.warehouseCode} onChange={e=>updateLine(i,{warehouseCode:e.target.value})}><option value="">{warehouses.length===1?`自动匹配：${warehouses[0].name}`:'请选择目的仓'}</option>{warehouses.map((w:Row)=><option value={w.code} key={w.id}>{w.code} · {w.name}</option>)}</select>{!warehouses.length&&<small className="inbound-error">请先在主数据配置目的仓</small>}</td><td data-label="本次实收"><input aria-label={`第${i+1}行实收数量`} type="number" min="1" step="1" value={r.qty} onChange={e=>updateLine(i,{qty:e.target.value})}/></td><td data-label="批次 / 入库状态"><select aria-label={`第${i+1}行关联批次`} value={r.sourceBatch} onChange={e=>updateLine(i,{sourceBatch:e.target.value,stockState:e.target.value?'pending':'available'})}><option value="">{data.actor.role==='管理员'?'管理员例外入库':'请选择历史生产批次'}</option>{data.batches.filter((b:Row)=>b.stage==='awaiting_receipt'&&b.sku===r.sku).map((b:Row)=><option value={b.id} key={b.id}>{b.id}</option>)}</select><select aria-label={`第${i+1}行入库状态`} value={r.stockState} disabled={Boolean(r.sourceBatch)} onChange={e=>updateLine(i,{stockState:e.target.value})}>{r.sourceBatch?<option value="pending">待上架</option>:<><option value="available">已验收合格 → 可售</option><option value="quarantine">未验收 / 破损 → 隔离</option></>}</select></td><td data-label="操作"><button type="button" className="btn danger" disabled={lines.length===1} onClick={()=>{clearFeedback();setLines(lines.filter((_,j)=>j!==i));}}>移除</button></td></tr>;
        })}</tbody></table></div><div className="form-actions"><button type="button" className="btn" disabled={lines.length>=200} onClick={()=>{clearFeedback();setLines([...lines,emptyLine()]);}}>＋ 增加商品 / 渠道分配</button><span>{lines.length} 行 · 同 SKU 不同渠道各填一行</span></div></>}
        {mode==='file'&&<TableImport key={importKey} kind="inbound" busy={busy||working} defaults={header} contextKey={JSON.stringify(header)} description="支持同一单号多个SKU，也可导入多张单据。同一单号的站点、日期、凭证和说明须一致；文件未填写的单据资料使用上方资料。目的仓编码留空时自动匹配唯一启用主仓。每次最多200行；数量为本次新增。入库状态填写可售、隔离或待上架，供应链须关联历史生产批次。" confirmLabel="载入明细，下一步预览库存" validate={rows=>{groupInboundRows(rows);}} successMessage="明细已载入，尚未入库。请点击下方“校验并预览库存变动”。" onApply={(rows,m)=>{loadRows(rows,m);return true;}}/>}
        {mode==='paste'&&<div className="inbound-paste"><label>从 Excel 复制表头和商品行<textarea value={paste} onChange={e=>{clearFeedback();setImported(null);setPaste(e.target.value);}} rows={6} placeholder={'SKU\t渠道\t数量\nH001-2-BLACK-M\tTikTok\t400\nH001-2-BLACK-M\tShopee\t440'}/></label><p>可只粘贴 SKU、渠道、数量三列，其他资料沿用上方填写内容；也支持完整模板列。</p><button type="button" className="btn" onClick={parsePaste}>解析粘贴内容</button></div>}
      </fieldset>
      {imported&&mode!=='manual'&&<p className="notice info">已载入 {imported.length} 行，尚未入库。以校验预览中的单号、日期和目的仓为准。</p>}
      {error&&<p className="notice warn" role="alert">{error}</p>}
      {errors.length>0&&<div className="notice warn" role="alert"><strong>发现 {errors.length} 项问题，整批未入库：</strong><ul>{errors.map((e,i)=><li key={i}>第{e.row}行：{e.message}</li>)}</ul></div>}
      {!preview&&<div className="form-actions"><button type="button" className="btn primary" disabled={busy||working||(mode!=='manual'&&!imported)} onClick={prepare}>{working?'正在校验…':'校验并预览库存变动'}</button><span>此步骤不会增加库存</span></div>}
    </section>}
    {preview&&<section className="panel inbound-preview" ref={previewRef} tabIndex={-1} aria-label="确认入库预览"><div className="panel-head"><div><h4>核对本次入库</h4><p>数量为本次新增。库存若在确认前变化，系统会要求重新预览。</p></div></div><Summary value={preview.summary}/><p>{Array.from(new Set(preview.lines.map((r:Row)=>`${r.receiptNo} · 实际到仓 ${r.businessDate} · 凭证 ${r.proofRef}`))).join('；')}</p><MovementTable lines={preview.lines}/><label className="inbound-confirm"><input type="checkbox" checked={confirmed} disabled={busy||working} onChange={e=>setConfirmed(e.target.checked)}/><span>已核对本次新增数量未包含在期初库存或其他入库单中，且可售部分已验收合格。渠道份额合计等于实收，不重复计算同批实物。</span></label>{error&&<p className="notice warn" role="alert">{error}</p>}<div className="form-actions"><button type="button" className="btn" disabled={busy||working} onClick={clearFeedback}>返回修改</button><button type="button" className="btn primary" disabled={busy||working||!confirmed} onClick={submit}>{working?'正在入库…':'确认整批入库'}</button></div></section>}
    <section className="panel"><div className="panel-head"><div><h4>最近到仓单与回执</h4><p>实际到仓日期与系统登记时间分别记录；旧单据保留原始记录。</p></div></div>
      {!documents.length&&!data.receipts.length&&<div className="empty">暂无到仓记录</div>}
      {documents.map((d:Row)=><details className="inbound-history" key={d.id}><summary><strong>{d.receipt_no}</strong><span>{d.business_date} · {d.site} · {d.sku_count} 个SKU · {fmt(d.total_qty)} 件</span><span>查看明细与库存回执</span></summary><p>凭证：{d.proof_ref} · {d.note}<br/>登记人：{d.actor_name} · 登记时间：{new Date(d.created_at).toLocaleString('zh-CN')}</p><p>下表为入库当时的库存变化；当前库存请查看“库存流水”。</p><MovementTable lines={d.lines.map((l:Row)=>({...l,receiptNo:d.receipt_no,warehouseName:l.warehouse_name,warehouseCode:l.warehouse_code,stockState:l.stock_state}))}/></details>)}
      {data.receipts.length>0&&<details className="inbound-history"><summary>查看旧版单 SKU 到仓记录（{data.receipts.length}）</summary><div className="table-wrap"><table><thead><tr>{['登记时间','单号 / SKU','实收','凭证','渠道分配'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{data.receipts.map((r:Row)=><tr key={r.id}><td>{new Date(r.received_at).toLocaleString('zh-CN')}</td><td>{r.receipt_no}<br/>{r.sku}</td><td>{fmt(r.total_qty)}</td><td>{r.proof_ref}</td><td>{String(r.allocations||'').split(';;').join('；')}</td></tr>)}</tbody></table></div></details>}
    </section>
  </div>;
}
