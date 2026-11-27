'use client';
import TableImport from './table-import';
import {useWholesaleLanguage} from './wholesale-language';
import {sampleImportItems} from '../lib/marketing-sample-import.mjs';
type Row=Record<string,any>;
export default function SampleItemsImport({skus,items,busy,contextKey,onApply}:{skus:Row[];items:Row[];busy:boolean;contextKey:string;onApply:(items:Row[])=>void}){
 const {t}=useWholesaleLanguage();
 const parse=(rows:Row[])=>{try{return sampleImportItems(rows,skus);}catch(e){const message=(e as Error).message,m=message.match(/^第(\d+)行：(.*)$/);throw Error(m?t('第{0}行：{1}',[m[1],t(m[2])]):t(message));}};
 return <TableImport kind="marketingSample" busy={busy} contextKey={contextKey}
  description="一次导入一份申请的 SKU 和数量，最多100项。先预览校验，确认后替换下方明细；提交申请才会保存，导入不会锁库或扣库存。"
  successMessage="样品明细已填入，请核对数量、协议和收件信息后提交申请。"
  templateRows={items.filter(i=>i.sku).map(i=>({sku:i.sku,name:skus.find(s=>s.sku===i.sku)?.name||'',qty:i.sampleQty}))}
  validate={rows=>{parse(rows);}}
  onApply={rows=>{onApply(parse(rows));return true;}}/>;
}
