import {salesMoney,salesFinancials} from './sales-data.mjs';
// Shared by the spreadsheet preview and the server. Quantities are never rounded.
export const IMPORT_MAX_ROWS=200;
export const IMPORT_MAX_BYTES=10*1024*1024;
const col=(key,label,aliases=[],required=true,type='text',max=240)=>({key,label,aliases:[key,label,...aliases],required,type,max});
const sku=col('sku','SKU',['商品编码','货号','商品编号','款号','Seller SKU','SKU ID','SKU Induk'],true,'sku',120);
const name=col('name','商品名称',['品名','Product name','Nama produk'],false,'text',120);
const qty=col('qty','数量',['销量','销售量','件数','实收数量','Quantity','Units','Units confirmed','Jumlah'],true,'positive');
const site=col('site','站点',['国家','Site']);
const channel=col('channel','渠道',['平台','Channel']);
const itemId=col('itemId','明细编号',['明细ID','Item ID','ID rincian'],false,'text',120);
export const IMPORT_SCHEMAS={
  sales:{title:'销售数据',columns:[sku,name,{...qty,type:'nonnegative'},col('unitPrice','成交单价',['单价','销售价格','Unit price','Sale price','Harga satuan'],false,'money'),col('amount','销售额',['成交金额','实付金额','Sales amount','Revenue','GMV','Total revenue'],false,'money'),col('adCost','投放成本',['广告费','广告成本','广告消耗','Ad spend','Ad cost','Advertising cost','Spend','Biaya iklan'],false,'money'),col('currency','币种',['Currency','Mata uang'],false)],maxRows:5000},
  inventory:{title:'库存盘点',columns:[site,channel,sku,name,col('countedQty','盘点实数',['库存','库存数量','实盘数量','期初库存'],true,'nonnegative'),col('reason','调整原因',['原因'],true,'reason')]},
  inbound:{title:'历史到仓',columns:[col('receiptNo','到仓单号',['入库单号'],true,'text',80),sku,name,site,channel,qty,col('sourceBatch','关联历史生产批次',['生产批次','批次ID'],false,'text',80),col('proofRef','到仓凭证',['凭证','文件编号'],true,'text',240)]},
  order:{title:'批发订单明细',maxRows:20,columns:[sku,qty,col('unitPrice','成交单价IDR',['成交单价','单价','Unit price','Harga satuan','Harga satuan IDR','Harga satuan transaksi IDR'],true,'positive')]},
  shipment:{title:'发货明细',columns:[itemId,sku,qty]},
  receipt:{title:'到仓实收明细',columns:[itemId,sku,qty,col('quarantineQty','隔离数量',['破损数量'],false,'nonnegative')]},
  returns:{title:'退货验收单',maxRows:1,columns:[sku,qty,col('businessDate','收回日期',['日期','Tanggal penerimaan retur'],true,'date'),col('proofRef','验收单号',['凭证','Nomor bukti penerimaan'],true,'text',240),col('reason','退货原因',['原因','Alasan retur'],true,'reason')]},
};
const headerKey=value=>String(value??'').replace(/^\uFEFF/,'').trim().toLowerCase().replace(/[\s_（）()]/g,'');
const blank=value=>value===undefined||value===null||String(value).trim()==='';
function integer(value,label,min){
  if(blank(value)||typeof value==='boolean'||typeof value==='object')throw Error(`${label}必须是${min?'正':'非负'}整数`);
  const text=String(value).trim();
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text))throw Error(`${label}必须是整数，不能包含小数、负数或其他文字`);
  const n=Number(text.replaceAll(',',''));
  if(!Number.isSafeInteger(n)||n<min||n>1_000_000_000)throw Error(`${label}须在${min}—1,000,000,000之间`);
  return n;
}
export function validateImportRows(kind,input,defaults={}){
  const schema=IMPORT_SCHEMAS[kind];
  if(!schema)throw Error('不支持的导入类型');
  if(!Array.isArray(input)||!input.length)throw Error('文件中没有可导入的数据');
  if(input.length>(schema.maxRows||IMPORT_MAX_ROWS))throw Error(`每次最多导入${schema.maxRows||IMPORT_MAX_ROWS}行，请拆分文件`);
  const errors=[],rows=[],seen=new Set();
  input.forEach((raw,index)=>{
    const rowNumber=Number.isSafeInteger(raw?._row)&&raw._row>=2?raw._row:index+2;
    try{
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('明细格式无效');
      const row={_row:rowNumber};
      for(const c of schema.columns){
        const value=blank(raw[c.key])?defaults[c.key]??'':raw[c.key];
        if(blank(value)){if(c.required)throw Error(`缺少${c.label}`);row[c.key]=c.type==='nonnegative'?0:'';continue;}
        if(c.type==='money'){row[c.key]=salesMoney(value,c.label);continue;}
        if(c.type==='positive'||c.type==='nonnegative'){row[c.key]=integer(value,c.label,c.type==='positive'?1:0);continue;}
        if(!['string','number'].includes(typeof value))throw Error(`${c.label}格式无效`);
        const text=String(value).trim();
        if(text.length>c.max)throw Error(`${c.label}超过${c.max}个字符`);
        if(c.type==='reason'&&text.length<4)throw Error(`${c.label}至少填写4个字符`);
        if(c.type==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(text)||!Number.isFinite(Date.parse(text))||new Date(text).toISOString().slice(0,10)!==text))throw Error(`${c.label}须为有效日期 YYYY-MM-DD`);
        row[c.key]=c.type==='sku'?text.toUpperCase():text;
      }
      if(row.site&&!['马来西亚','印尼','泰国','越南','菲律宾'].includes(row.site))throw Error('站点必须为马来西亚、印尼、泰国、越南或菲律宾');
      if(row.channel&&!['TikTok','Shopee','线下分销'].includes(row.channel))throw Error('渠道必须为 TikTok、Shopee 或线下分销');
      if(kind==='sales')salesFinancials(row,defaults.currency||'');
      if(kind==='receipt'&&row.quarantineQty>row.qty)throw Error('隔离数量不能超过实收数量');
      const key=kind==='inventory'?`${row.site}|${row.channel}|${row.sku}`:kind==='inbound'?`${row.receiptNo}|${row.sku}|${row.site}|${row.channel}`:kind==='sales'?null:row.itemId||row.sku;
      if(key&&seen.has(key))throw Error('与文件中的其他行重复，请合并明细后导入');
      if(key)seen.add(key);
      rows.push(row);
    }catch(error){errors.push({row:rowNumber,message:error.message});}
  });
  return {rows,errors};
}
export function parseImportGrid(kind,grid,defaults={}){
  const schema=IMPORT_SCHEMAS[kind];
  if(!schema)throw Error('不支持的导入类型');
  const headerIndex=grid.findIndex(row=>row.some(v=>!blank(v)));
  if(headerIndex<0)throw Error('工作表为空');
  const headers=grid[headerIndex].map(headerKey),mapping={};
  for(const c of schema.columns){
    const matches=headers.map((h,i)=>c.aliases.some(a=>headerKey(a)===h)?i:-1).filter(i=>i>=0);
    if(matches.length>1)throw Error(`${c.label}存在多个匹配列，请保留一列`);
    if(!matches.length&&c.required&&blank(defaults[c.key]))throw Error(`未找到“${c.label}”列，请使用模板或修改表头`);
    mapping[c.key]=matches[0];
  }
  const input=grid.slice(headerIndex+1).flatMap((values,index)=>{
    if(values.every(blank))return [];
    return [{...Object.fromEntries(schema.columns.map(c=>[c.key,values[mapping[c.key]]??''])),_row:headerIndex+index+2}];
  });
  return validateImportRows(kind,input,defaults);
}
export function readImportSheet(XLSX,kind,workbook,name,defaults={}){
  const ws=workbook.Sheets[name];
  if(!ws)throw Error('工作表不存在');
  const fullRef=ws['!fullref']||ws['!ref'];
  const range=fullRef?XLSX.utils.decode_range(fullRef):null;
  if(range&&(range.e.r-range.s.r>5000||range.e.c-range.s.c>100))throw Error('工作表范围过大，请仅保留需要导入的明细');
  if(Object.values(ws).some(cell=>cell&&typeof cell==='object'&&'f' in cell))throw Error('导入表中含公式，请先复制并粘贴为数值后重试');
  return parseImportGrid(kind,XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:false,blankrows:true}),defaults);
}
// Match against the current order/batch, never accept an arbitrary item ID.
export function matchImportItems(rows,items,quantityKey='remaining'){
  const used=new Set();
  return rows.map(row=>{
    const matches=items.filter(item=>row.itemId?item.id===row.itemId&&item.sku===row.sku:item.sku===row.sku);
    if(matches.length!==1)throw Error(`第${row._row}行：${row.sku}不存在于当前单据，或存在多条同SKU明细，请填写模板中的明细编号`);
    const item=matches[0];
    if(used.has(item.id))throw Error(`第${row._row}行：明细重复`);
    if(row.qty>Number(item[quantityKey]))throw Error(`第${row._row}行：${row.sku}最多可填写${item[quantityKey]}件`);
    used.add(item.id);return {...row,itemId:item.id};
  });
}
export function groupInboundRows(rows){
  const groups=new Map();
  for(const row of rows){
    let group=groups.get(row.receiptNo);
    if(group&&['sku','name','sourceBatch','proofRef'].some(key=>group[key]!==row[key]))throw Error(`第${row._row}行：同一到仓单号的SKU、商品、批次和凭证必须一致；不同SKU请使用不同单号`);
    if(!group){group={...row,totalQty:0,allocations:[]};groups.set(row.receiptNo,group);}
    group.totalQty+=row.qty;group.allocations.push({site:row.site,channel:row.channel,qty:row.qty});
  }
  const batches=new Set();
  for(const group of groups.values())if(group.sourceBatch){if(batches.has(group.sourceBatch))throw Error('同一历史生产批次只能对应一张到仓单');batches.add(group.sourceBatch);}
  return [...groups.values()];
}
