import {SITE_CURRENCIES} from './sales-data.mjs';

export const templatePath='/templates/operations-video-feedback.xlsx';
const units={MYR:'RM',THB:'฿',VND:'₫',PHP:'₱'};

// Preserve the supplied workbook, including its styles, date line and original sheet.
export async function siteTemplate(bytes,site){
  const currency=SITE_CURRENCIES[site];
  if(currency==='IDR')return bytes;
  if(!Object.hasOwn(units,currency))throw Error('请选择模板所属站点');
  const {unzipSync,zipSync,strFromU8,strToU8}=await import('fflate');
  const entries=unzipSync(bytes),path='xl/sharedStrings.xml';
  let count=0;
  const strings=strFromU8(entries[path]).replace(/(<t>(?:Video-attributed GMV|Video GMV|Video indirect GMV|GPM)) \(Rp\)(<\/t>)/g,(_,title,end)=>{
    count++;return title+' ('+units[currency]+')'+end;
  });
  if(count!==4)throw Error('运营模板的金额表头需要核对');
  entries[path]=strToU8(strings);
  return zipSync(entries);
}
