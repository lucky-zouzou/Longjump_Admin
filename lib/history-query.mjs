import {canReadDomain,hasPermission} from './permissions.mjs';
export class HistoryError extends Error{constructor(status,message){super(message);this.status=status;}}
const configs={
  movements:{table:'inventory_movements',date:'created_at',domain:'inventory',columns:['id','created_at','movement_type','site','channel','sku','qty_delta','balance_after','reference_type','reference_id','note'],search:['sku','reference_id','reference_type','note']},
  sales:{table:'sales_records',date:'business_date',domain:'sales',columns:['id','business_date','site','channel','sku','qty','unit_price','reported_amount','ad_cost','currency','import_id'],search:['sku','import_id','source_ref'],active:'reversed_at IS NULL'},
  imports:{table:'sales_imports',date:'business_date',domain:'sales',columns:['id','business_date','site','channel','file_name','total_qty','row_count','report_kind','source_batch_ref','import_key','reversed_at','reversal_reason'],search:['id','file_name','source_batch_ref']},
  audit:{table:'audit_logs',date:'created_at',domain:'audit',columns:['id','created_at','action','entity_type','entity_id','actor_name','detail_json'],search:['action','entity_type','entity_id','actor_name']},
};
const validDate=s=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s;
export async function readHistory(db,actor,input){
  const kind=input.history,c=configs[kind];
  if(!c)throw new HistoryError(400,'查询类型无效');
  if(!canReadDomain(actor.role,c.domain)||kind==='audit'&&!hasPermission(actor.role,'audit.view'))throw new HistoryError(403,'当前账号无权查询此记录');
  const from=input.from||'',to=input.to||'',search=String(input.search||'').trim().slice(0,160);
  if(from&&!validDate(from)||to&&!validDate(to)||from&&to&&from>to)throw new HistoryError(400,'请选择有效的起止日期');
  let site=input.site||'',channel=input.channel||'';
  if(actor.role==='运营'){
    if(!actor.site||!actor.channel||site&&site!==actor.site||channel&&channel!==actor.channel)throw new HistoryError(403,'只能查询本人站点及渠道');
    site=actor.site;channel=actor.channel;
  }
  const clauses=[],args=[];
  if(c.active)clauses.push(c.active);
  // Dates are business dates for sales; event timestamps use Beijing calendar days.
  const date=c.date==='created_at'?`date(${c.date},'+8 hours')`:c.date;
  for(const [op,value]of [['>=',from],['<=',to]])if(value){clauses.push(`${date}${op}?`);args.push(value);}
  if(kind!=='audit')for(const [key,value]of [['site',site],['channel',channel]])if(value){clauses.push(`${key}=?`);args.push(value);}
  if(search){clauses.push('('+c.search.map(key=>`${key} LIKE ? ESCAPE '\\'`).join(' OR ')+')');args.push(...c.search.map(()=>'%'+search.replace(/[\\%_]/g,'\\$&')+'%'));}
  const where=clauses.length?' WHERE '+clauses.join(' AND '):'';
  const integer=(value,fallback)=>Number.isFinite(Number(value))?Math.floor(Number(value))||fallback:fallback;
  const pageSize=Math.min(100,Math.max(10,integer(input.pageSize,50))),total=Number((await db.prepare(`SELECT COUNT(*) n FROM ${c.table}${where}`).bind(...args).first()).n);
  const pages=Math.max(1,Math.ceil(total/pageSize)),page=Math.min(pages,Math.max(1,integer(input.page,1)));
  const exporting=input.export==='1';
  if(exporting&&total>50000)throw new HistoryError(400,'该范围超过50000条，请缩小日期范围后导出');
  const columns=c.columns.filter(key=>actor.role!=='工厂'||!['unit_price','reported_amount','ad_cost'].includes(key));
  const sql=`SELECT ${columns.join(',')} FROM ${c.table}${where} ORDER BY ${c.date} DESC,id DESC${exporting?'':' LIMIT ? OFFSET ?'}`;
  const rows=(await db.prepare(sql).bind(...args,...(exporting?[]:[pageSize,(page-1)*pageSize])).all()).results;
  return {kind,rows,total,page,pageSize,pages,filters:{from,to,site,channel,search},columns,generatedAt:new Date().toISOString()};
}
const labels={id:'记录ID',created_at:'操作时间（北京时间）',business_date:'业务日期',movement_type:'变动类型',site:'站点',channel:'渠道',sku:'SKU',qty_delta:'变动数量',balance_after:'变动后数量',reference_type:'凭证类型',reference_id:'凭证编号',note:'说明',qty:'销量',unit_price:'单价',reported_amount:'销售金额',ad_cost:'广告成本',currency:'币种',import_id:'导入批次',file_name:'文件名称',total_qty:'总件数',row_count:'明细行数',report_kind:'日报类型',source_batch_ref:'平台批次号',reversed_at:'冲销时间（北京时间）',action:'操作',entity_type:'对象类型',entity_id:'对象编号',actor_name:'操作人',detail_json:'操作详情'};
export const historyColumn=key=>labels[key]||key;
export function historyValue(key,value){
  if(!['created_at','reversed_at'].includes(key)||!value)return value;
  const date=new Date(value);return Number.isFinite(date.valueOf())?new Date(date.valueOf()+8*3600000).toISOString().slice(0,19).replace('T',' '):value;
}
export function historyCsv(result){const cell=value=>'"'+String(value??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';return '\uFEFF'+[result.columns.map(historyColumn),...result.rows.map(row=>result.columns.map(key=>historyValue(key,row[key])))].map(row=>row.map(cell).join(',')).join('\r\n');}
