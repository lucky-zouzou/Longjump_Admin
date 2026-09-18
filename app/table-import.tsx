"use client";
import {useWholesaleLanguage} from "./wholesale-language";
import {useEffect,useId,useRef,useState} from 'react';
import {IMPORT_MAX_BYTES,IMPORT_SCHEMAS,readImportSheet} from '../lib/tabular-import.mjs';
// Import rows vary by the selected business document.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ImportRow=Record<string,any>;
type Meta={fileName:string;fileHash:string};
type Props={kind:keyof typeof IMPORT_SCHEMAS;busy?:boolean;defaults?:ImportRow;contextKey?:string;templateRows?:ImportRow[];description?:string;confirmLabel?:string;validate?:(rows:ImportRow[])=>void;onApply:(rows:ImportRow[],meta:Meta)=>Promise<boolean>|boolean};

export default function TableImport({kind,busy=false,defaults={},contextKey='',templateRows=[],description,confirmLabel='确认导入到表单',validate,onApply}:Props){
  const {t}=useWholesaleLanguage();
  const schema=IMPORT_SCHEMAS[kind],inputId=useId(),generation=useRef(0),locked=useRef(false);
  const [loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[rows,setRows]=useState<ImportRow[]>([]),[errors,setErrors]=useState<Array<{row:number;message:string}>>([]),[message,setMessage]=useState(''),[meta,setMeta]=useState<Meta|null>(null),[book,setBook]=useState<import('xlsx').WorkBook|null>(null),[sheet,setSheet]=useState('');
  const reset=()=>{generation.current++;setRows([]);setErrors([]);setMeta(null);setBook(null);setSheet('');setMessage('');setLoading(false);};
  useEffect(()=>{reset();return()=>{generation.current++;};},[kind,contextKey]); // Clear stale previews when the destination changes.
  const parse=async(workbook:import('xlsx').WorkBook,name:string)=>{
    setRows([]);setErrors([]);setMessage('');
    const XLSX=await import('xlsx');
    return readImportSheet(XLSX,kind,workbook,name,defaults);
  };
  const readFile=async(file:File)=>{
    reset();const current=generation.current;setLoading(true);
    try{
      if(!/\.(xlsx|xls|csv)$/i.test(file.name))throw Error('请选择 Excel（.xlsx / .xls）或 CSV 文件');
      if(file.size>IMPORT_MAX_BYTES)throw Error('文件不能超过10MB，请拆分后导入');
      const buffer=await file.arrayBuffer(),XLSX=await import('xlsx');
      let csvText='';
      if(/\.csv$/i.test(file.name)){try{csvText=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch{csvText=new TextDecoder('gb18030').decode(buffer);}}
      const workbook=/\.csv$/i.test(file.name)?XLSX.read(csvText,{type:'string',raw:true,cellFormula:true,sheetRows:5002}):XLSX.read(buffer,{type:'array',raw:true,cellFormula:true,sheetRows:5002});
      const name=workbook.SheetNames[0];if(!name)throw Error('文件没有工作表');
      const digest=await crypto.subtle.digest('SHA-256',buffer);
      if(current!==generation.current)return;
      setBook(workbook);setSheet(name);setMeta({fileName:file.name,fileHash:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('')});
      const result=await parse(workbook,name);
      if(current===generation.current){setRows(result.rows);setErrors(result.errors);}
    }catch(error){if(current===generation.current)setMessage(error instanceof Error?error.message:'文件解析失败');}
    finally{if(current===generation.current)setLoading(false);}
  };
  const changeSheet=async(name:string)=>{if(!book)return;setSheet(name);setLoading(true);const current=++generation.current;try{const result=await parse(book,name);if(current===generation.current){setRows(result.rows);setErrors(result.errors);}}catch(error){if(current===generation.current)setMessage(error instanceof Error?error.message:'工作表解析失败');}finally{if(current===generation.current)setLoading(false);}};
  const download=async()=>{
    try{const XLSX=await import('xlsx'),workbook=XLSX.utils.book_new();
      const values=templateRows.length?templateRows:[defaults];
      const ws=XLSX.utils.aoa_to_sheet([schema.columns.map(c=>t(c.label)),...values.map(row=>schema.columns.map(c=>row[c.key]??''))]);
      ws['!cols']=schema.columns.map(()=>({wch:22}));
      XLSX.utils.book_append_sheet(workbook,ws,'导入数据');
      XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['使用说明'],['请填写“导入数据”工作表，保留表头。只保留本次需要处理的行，删除其余明细。'],[description||'导入后预览并确认，再提交业务单据。'],['数量必须为整数；SKU及单号建议使用文本格式；不接受公式。'],['允许空白行，不会跳过错误行。'],['历史到仓单每个单号对应一个SKU，多渠道可以使用相同单号。']]),'填写说明');
      XLSX.writeFile(workbook,`LOONG-JUMP-${kind}-import-template.xlsx`);
    }catch(error){setMessage(error instanceof Error?error.message:'模板下载失败');}
  };
  const apply=async()=>{
    if(locked.current||busy||loading||!meta||!rows.length||errors.length)return;
    locked.current=true;setSaving(true);setMessage('');
    try{validate?.(rows);if(await onApply(rows,meta)){reset();setMessage('导入完成，请核对下方数据或单据状态。');}else setMessage('尚未确认保存，请查看页面错误提示后重试。');}
    catch(error){setMessage(error instanceof Error?error.message:'导入失败，请核对文件后重试');}
    finally{locked.current=false;setSaving(false);}
  };
  const exportErrors=()=>{
    const csv='\uFEFF行号,错误原因\r\n'+errors.map(e=>`${e.row},"${e.message.replaceAll('"','""')}"`).join('\r\n');
    const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='导入错误明细.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  return <section className="table-import" aria-label={t("{0}导入",[t(schema.title)])}>
    <div className="import-heading"><div><strong>{t(schema.title)} · {t("Excel / CSV 导入")}</strong><p>{t(description||'下载模板填写，选择文件后预览；确认导入会替换当前表单明细，提交后才写入系统。')}</p></div><button className="btn" type="button" disabled={saving||loading} onClick={download}>{t("下载导入模板")}</button></div>
    <div className="import-controls"><label htmlFor={inputId}>{t("选择导入文件")}<input id={inputId} type="file" accept=".xlsx,.xls,.csv" disabled={busy||loading||saving} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void readFile(f);}}/></label>{book&&book.SheetNames.length>1&&<label>{t("工作表")}<select value={sheet} disabled={saving||loading} onChange={e=>void changeSheet(e.target.value)}>{book.SheetNames.map(n=><option key={n}>{n}</option>)}</select></label>}{meta&&<span>{meta.fileName}</span>}</div>
    {loading&&<p role="status">{t("正在解析文件…")}</p>}{message&&<p className="notice info" role="status">{t(message)}</p>}
    {errors.length>0&&<div className="notice warn" role="alert"><strong>{t("发现 {0} 行错误，整份文件暂不导入。",[errors.length])}</strong><ul>{errors.slice(0,10).map((e,i)=><li key={i}>{t("第{0}行：{1}",[e.row,t(e.message)])}</li>)}</ul><button className="btn" type="button" onClick={exportErrors}>{t("下载全部错误")}</button></div>}
    {rows.length>0&&<>{kind==="sales"&&rows.some(r=>r.adCost===''||r.adCost==null||(r.amount===''||r.amount==null)&&(r.unitPrice===''||r.unitPrice==null))&&<p className="notice warn">部分行缺少销售额/成交单价或投放成本。销量仍会导入，相关SKU不会进入完整投产比排名；请先核对预览中的金额列。广告费用不要在多个订单行重复填写。</p>}<p>{t("预览 {0} 行（最多显示20行） · 尚未写入系统",[rows.length])}</p><div className="table-wrap"><table><thead><tr><th>{t("行号")}</th>{schema.columns.map(c=><th key={c.key}>{t(c.label)}</th>)}</tr></thead><tbody>{rows.slice(0,20).map((r,i)=><tr key={i}><td>{r._row}</td>{schema.columns.map(c=><td key={c.key}>{String(r[c.key]??'')}</td>)}</tr>)}</tbody></table></div><div className="form-actions"><button className="btn" type="button" disabled={saving} onClick={reset}>{t("清除文件")}</button><button className="btn primary" type="button" disabled={busy||saving||loading||errors.length>0} onClick={apply}>{t(saving?'正在导入…':confirmLabel)}</button></div></>}
  </section>;
}
