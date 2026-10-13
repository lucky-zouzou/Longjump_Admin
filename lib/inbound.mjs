import {validateImportRows,groupInboundRows} from './tabular-import.mjs';
import {hasPermission,canReadDomain} from './permissions.mjs';
import {guardStatement,atomicBatch,assertWritable} from './atomic.mjs';

export class InboundError extends Error{constructor(status,message,errors=[]){super(message);this.status=status;this.errors=errors;}}
const all=async(db,sql,args=[])=>{const result=await db.prepare(sql).bind(...args).all();if(!result.success)throw Error('到仓数据读取失败');return result.results||[];};
const id=prefix=>`${prefix}_${crypto.randomUUID()}`;
const today=()=>new Date(Date.now()+8*3600_000).toISOString().slice(0,10);
const fingerprint=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
const balance=row=>({available:Number(row?.qty||0),pending:Number(row?.pending_shelf_qty||0),quarantine:Number(row?.quarantine_qty||0)});
const key=row=>JSON.stringify([row.site,row.channel,row.sku]);

// A preview reads authoritative catalog, warehouses and balances, but never writes.
async function planInbound(db,actor,payload){
  if(!hasPermission(actor.role,'inbound.receive'))throw new InboundError(403,'没有登记到仓权限');
  let parsed,documents;
  try{parsed=validateImportRows('inbound',payload.rows);documents=groupInboundRows(parsed.rows);}catch(e){throw new InboundError(400,e.message);}
  const errors=[...parsed.errors];
  const [skus,warehouses,stocks,oldReceipts,newReceipts,batches]=await Promise.all([
    all(db,'SELECT sku,name FROM sku_settings ORDER BY sku'),all(db,'SELECT * FROM warehouses ORDER BY id'),
    all(db,'SELECT * FROM inventory_balances'),all(db,'SELECT receipt_no FROM inbound_receipts'),
    all(db,'SELECT receipt_no FROM inbound_documents'),all(db,'SELECT * FROM production_batches'),
  ]);
  const catalog=new Map(skus.map(r=>[r.sku,r])),stockMap=new Map(stocks.map(r=>[key(r),r]));
  const receiptNos=new Set([...oldReceipts,...newReceipts].map(r=>r.receipt_no)),lines=[],usedStocks=new Map(),usedBatches=new Map();
  // Legacy batches may span countries. Import their separate receipt documents
  // together and verify the whole batch before advancing its single stage.
  const linkedRows=new Map();
  for(const row of parsed.rows)if(row.sourceBatch)linkedRows.set(row.sourceBatch,[...(linkedRows.get(row.sourceBatch)||[]),row]);
  for(const [batchId,rows] of linkedRows){
    const batch=batches.find(b=>b.id===batchId);let planned=[];
    try{planned=JSON.parse(batch?.allocations_json||'[]');}catch{/* Reject malformed legacy allocations below. */}
    const actual=new Map();for(const row of rows)actual.set(key(row),(actual.get(key(row))||0)+row.qty);
    const matches=Array.isArray(planned)&&planned.length===actual.size&&new Set(planned.map(p=>key({...p,sku:batch?.sku}))).size===planned.length&&planned.every(p=>actual.get(key({...p,sku:batch?.sku}))===Number(p.qty));
    if(!batch||batch.stage!=='awaiting_receipt'||rows.some(r=>r.sku!==batch.sku)||Number(batch.qty)!==rows.reduce((n,r)=>n+r.qty,0)||!matches)errors.push({row:rows[0]._row,message:'关联批次必须处于等待到仓，且SKU、总数和渠道分配与批次一致；跨站点批次请将各站点到仓单一并导入'});
    else usedBatches.set(batch.id,batch);
  }
  for(const document of documents){
    if(receiptNos.has(document.receiptNo))throw new InboundError(409,`第${document._row}行：到仓单 ${document.receiptNo} 已经入库，整份文件未写入`);
    if(document.businessDate>today())errors.push({row:document._row,message:'实际到仓日期不能晚于今天'});
    for(const item of document.items){
      if(!item.sourceBatch&&actor.role!=='管理员')throw new InboundError(403,`第${item.allocations[0]._row}行：供应链到仓必须关联系统批次；只有管理员可处理例外入库`);
      for(const row of item.allocations){
        const product=catalog.get(row.sku);
        if(!product){errors.push({row:row._row,message:`SKU ${row.sku} 不在主数据中，请先核对或维护SKU`});continue;}
        const candidates=warehouses.filter(w=>w.active===1&&w.site===row.site&&w.channel===row.channel);
        const warehouse=row.warehouseCode?candidates.find(w=>w.code===row.warehouseCode):candidates.length===1?candidates[0]:null;
        if(!warehouse){errors.push({row:row._row,message:row.warehouseCode?`目的仓 ${row.warehouseCode} 不属于该站点渠道或已停用`:'目的仓不明确，请在主数据维护唯一启用的主目的仓，或填写目的仓编码'});continue;}
        const stock=stockMap.get(key(row))||null;
        const previous=usedStocks.get(key(row));
        const before=previous?{...previous.after}:balance(stock),after={...before};after[row.stockState]+=row.qty;
        if(Object.values(after).some(n=>!Number.isSafeInteger(n)||Math.abs(n)>1_000_000_000)){errors.push({row:row._row,message:'累加入库后数量超出允许范围'});continue;}
        const line={...row,name:product.name||row.name||row.sku,warehouseId:warehouse.id,warehouseCode:warehouse.code,warehouseName:warehouse.name,before,after};
        lines.push(line);usedStocks.set(key(row),{stock,after});
      }
    }
  }
  if(errors.length)throw new InboundError(400,'请修正全部错误后再预览；本次未写入库存',errors);
  const normalized=lines.map(({before,after,warehouseId,warehouseName,...row})=>row);
  const token=await fingerprint({actor:actor.id,rows:normalized,stocks:[...usedStocks].map(([scope,r])=>[scope,r.stock]),batches:[...usedBatches.values()].map(b=>[b.id,b.stage,b.sku,b.qty,b.allocations_json,b.evidence_json]),warehouses:lines.map(l=>[l.warehouseId,l.warehouseCode,l.warehouseName])});
  const summary={documents:documents.length,skuCount:new Set(lines.map(r=>r.sku)).size,rows:lines.length,totalQty:lines.reduce((n,r)=>n+r.qty,0),available:0,pending:0,quarantine:0};
  for(const line of lines)summary[line.stockState]+=line.qty;
  return {documents,lines,normalized,token,summary,usedStocks,usedBatches};
}
export async function previewInbound(db,actor,payload){
  const plan=await planInbound(db,actor,payload);
  return {ok:true,token:plan.token,rows:plan.normalized,lines:plan.lines,summary:plan.summary};
}
export async function submitInbound(db,actor,payload){
  await assertWritable(db);
  const plan=await planInbound(db,actor,payload);
  if(payload.confirmed!==true)throw new InboundError(400,'请确认本次新增数量未包含在期初库存或其他入库单中，且可售部分已验收合格');
  if(!payload.previewToken||plan.token!==payload.previewToken)throw new InboundError(409,'数据或库存已变化，请重新预览入库前后数量再确认');
  const now=new Date().toISOString(),statements=[],documentIds=new Map();
  // Stock/catalog/warehouse guards run inside the same transaction as every line.
  for(const line of plan.lines){
    const original=plan.usedStocks.get(key(line)).stock;
    const balanceGuard=original?'EXISTS(SELECT 1 FROM inventory_balances WHERE site=? AND channel=? AND sku=? AND qty=? AND pending_shelf_qty=? AND quarantine_qty=? AND reserved_qty=?)':'NOT EXISTS(SELECT 1 FROM inventory_balances WHERE site=? AND channel=? AND sku=?)';
    const args=[line.site,line.channel,line.sku,...(original?[original.qty,original.pending_shelf_qty,original.quarantine_qty,original.reserved_qty]:[])];
    statements.push(guardStatement(db,actor,'到仓明细校验',`${balanceGuard} AND EXISTS(SELECT 1 FROM sku_settings WHERE sku=?) AND EXISTS(SELECT 1 FROM warehouses WHERE id=? AND site=? AND channel=? AND code=? AND name=? AND active=1)`,[...args,line.sku,line.warehouseId,line.site,line.channel,line.warehouseCode,line.warehouseName]));
  }
  for(const batch of plan.usedBatches.values()){
    statements.push(guardStatement(db,actor,'到仓批次校验',"EXISTS(SELECT 1 FROM production_batches WHERE id=? AND stage='awaiting_receipt' AND sku=? AND qty=? AND allocations_json=? AND evidence_json=?)",[batch.id,batch.sku,batch.qty,batch.allocations_json,batch.evidence_json]));
    const sources=plan.lines.filter(l=>l.sourceBatch===batch.id),evidence=JSON.parse(batch.evidence_json||'[]');evidence.push({stage:'warehouse_received',reference:[...new Set(sources.map(l=>l.receiptNo))].join('、'),proofRef:[...new Set(sources.map(l=>l.proofRef))].join('；'),at:now,by:actor.name,role:actor.role});
    statements.push(db.prepare("UPDATE production_batches SET stage='shelf_pending',stage_owner='运营',evidence_json=?,updated_at=? WHERE id=?").bind(JSON.stringify(evidence),now,batch.id));
  }
  for(const document of plan.documents){
    const documentId=id('inbound');documentIds.set(document.receiptNo,documentId);
    statements.push(guardStatement(db,actor,'到仓单号校验','NOT EXISTS(SELECT 1 FROM inbound_receipts WHERE receipt_no=?) AND NOT EXISTS(SELECT 1 FROM inbound_documents WHERE receipt_no=?)',[document.receiptNo,document.receiptNo]));
    statements.push(db.prepare('INSERT INTO inbound_documents(id,receipt_no,business_date,site,proof_ref,note,total_qty,sku_count,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(documentId,document.receiptNo,document.businessDate,document.site,document.proofRef,document.note,document.totalQty,document.items.length,actor.id,actor.name,now));
  }
  for(const line of plan.lines){
    const available=line.stockState==='available'?line.qty:0,pending=line.stockState==='pending'?line.qty:0,quarantine=line.stockState==='quarantine'?line.qty:0;
    statements.push(db.prepare('INSERT INTO inbound_document_lines(id,document_id,sku,name,site,channel,warehouse_id,warehouse_code,warehouse_name,source_batch,qty,stock_state,quarantine_remaining,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id('inbound_line'),documentIds.get(line.receiptNo),line.sku,line.name,line.site,line.channel,line.warehouseId,line.warehouseCode,line.warehouseName,line.sourceBatch,line.qty,line.stockState,quarantine,JSON.stringify(line.before),JSON.stringify(line.after),now));
    statements.push(db.prepare(`INSERT INTO inventory_balances(site,channel,sku,name,qty,pending_shelf_qty,quarantine_qty,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET qty=inventory_balances.qty+excluded.qty,pending_shelf_qty=inventory_balances.pending_shelf_qty+excluded.pending_shelf_qty,quarantine_qty=inventory_balances.quarantine_qty+excluded.quarantine_qty,name=excluded.name,updated_at=excluded.updated_at`).bind(line.site,line.channel,line.sku,line.name,available,pending,quarantine,now));
    statements.push(db.prepare("INSERT INTO inventory_movements(id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at) SELECT ?,site,channel,sku,name,?,?,qty,'多SKU到仓单',?,?,?,? FROM inventory_balances WHERE site=? AND channel=? AND sku=?").bind(id('move'),available?'管理员例外入库':pending?'到仓待上架':'到仓隔离',available,line.receiptNo,JSON.stringify({businessDate:line.businessDate,proofRef:line.proofRef,warehouseCode:line.warehouseCode,warehouseName:line.warehouseName,qty:line.qty,stockState:line.stockState,note:line.note}),actor.id,now,line.site,line.channel,line.sku));
  }
  for(const document of plan.documents)statements.push(db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(id('audit'),'多SKU到仓入库','inbound_document',documentIds.get(document.receiptNo),JSON.stringify({receiptNo:document.receiptNo,businessDate:document.businessDate,proofRef:document.proofRef,note:document.note,totalQty:document.totalQty,confirmed:true,fileName:String(payload.fileName||''),fileHash:String(payload.fileHash||'')}),actor.id,actor.name,now));
  if(statements.length>950)throw new InboundError(400,'本次单据数量过多，请拆分后重试；整份文件未写入');
  try{await atomicBatch(db,statements);}catch(e){if(/UNIQUE/.test(String(e)))throw new InboundError(409,'到仓单号或明细已存在，本次整批未重复入库');throw e;}
  return {ok:true,imported:plan.documents.length,summary:plan.summary,lines:plan.lines,receiptNos:plan.documents.map(d=>d.receiptNo),recordedAt:now};
}
export async function readInboundDocuments(db,actor){
  if(!canReadDomain(actor.role,'inventory'))return [];
  const scoped=actor.role==='运营',args=scoped?[actor.site,actor.channel]:[],scope=scoped?' AND l.site=? AND l.channel=?':'';
  const documents=await all(db,`SELECT d.* FROM inbound_documents d WHERE EXISTS(SELECT 1 FROM inbound_document_lines l WHERE l.document_id=d.id${scope}) ORDER BY d.created_at DESC LIMIT 200`,args);
  const lines=await all(db,`SELECT l.* FROM inbound_document_lines l WHERE l.document_id IN(SELECT d.id FROM inbound_documents d WHERE EXISTS(SELECT 1 FROM inbound_document_lines l WHERE l.document_id=d.id${scope}) ORDER BY d.created_at DESC LIMIT 200)${scope} ORDER BY l.sku,l.channel`,[...args,...args]);
  return documents.map(d=>{const items=lines.filter(l=>l.document_id===d.id).map(({before_json,after_json,...l})=>({...l,before:JSON.parse(before_json),after:JSON.parse(after_json)}));return {...d,total_qty:items.reduce((n,l)=>n+l.qty,0),sku_count:new Set(items.map(l=>l.sku)).size,lines:items};});
}
