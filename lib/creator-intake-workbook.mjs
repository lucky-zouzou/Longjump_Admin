// Read cell values, not display text: WPS/Excel may format the same date as
// 11/4/26 and quantities as 50,000. Only the date column uses date conversion.
export function readIntakeWorkbook(X,input){
 const bytes=input instanceof ArrayBuffer?new Uint8Array(input):input,zip=bytes[0]===0x50&&bytes[1]===0x4b;
 let source=bytes;
 if(!zip){try{source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('请使用XLSX文件，或另存为CSV UTF-8后上传');}}
 const book=X.read(source,{type:zip?'array':'string',cellDates:false,raw:true});
 const sheetName=book.SheetNames[0],sheet=book.Sheets[sheetName];
 if(!sheet)throw Error('文件没有可读取的工作表');
 const grid=X.utils.sheet_to_json(sheet,{header:1,raw:true,defval:'',blankrows:true});
 const headers=(grid[0]||[]).map(v=>String(v).replace(/^\uFEFF/,'').trim());
 if(!headers.some(h=>['达人id','达人ID','TikTok ID','达人 TikTok ID'].includes(h)))throw Error('没有找到达人 ID 列，请使用运营移交模板');
 const named=headers.filter(Boolean);if(new Set(named).size!==named.length)throw Error('表头有重复列名，请核对后再导入');
 const date1904=book.Workbook?.WBProps?.date1904===true||book.Workbook?.WBProps?.date1904===1;
 const headerRow=X.utils.decode_range(sheet['!ref']||'A1').s.r;
 const rows=grid.slice(1).map((values,index)=>({values,sourceRow:headerRow+index+2})).filter(r=>r.values.some(v=>v!==''&&v!=null)).map(({values,sourceRow})=>({...Object.fromEntries(headers.flatMap((key,i)=>{
  if(!key)return [];
  let value=values[i]??'';
  if(key==='创建日期'){
   if(value instanceof Date)value=Number.isFinite(+value)?value.toISOString().slice(0,10):'';
   else if(typeof value==='number'){
    const d=X.SSF.parse_date_code(value,{date1904});
    value=d?`${String(d.y).padStart(4,'0')}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`:String(value);
   }
  }
  return [[key,value]];
 })),__sourceRow:sourceRow}));
 if(!rows.length||rows.length>50)throw Error('第一张工作表须包含1至50行数据，请分批上传');
 return {sheetName,rows};
}
