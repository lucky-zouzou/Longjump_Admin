import { WHOLESALE_ID } from "./wholesale-id.mjs";
export const wholesaleLanguage=value=>value==="id"?"id":"zh";
export const wholesalePreferenceKey=actorId=>`loongjump.wholesale.language.${actorId}`;
// Only known UI/error templates are matched; captured SKU/customer text stays verbatim.
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const patterns=Object.entries(WHOLESALE_ID).filter(([key])=>/\{\d+\}/.test(key)).map(([key,template])=>[new RegExp("^"+key.split(/\{\d+\}/).map(escapeRegex).join("(.*?)")+"$"),template]);
export function translateWholesale(language,key,values=[]){
  if(typeof key!=="string")return key;
  const source=key.trim();
  let translated=source;
  if(language==="id"){
    translated=WHOLESALE_ID[source]??source;
    if(translated===source&&!Object.hasOwn(WHOLESALE_ID,source))for(const [expression,template] of patterns){const found=source.match(expression);if(found){translated=template.replace(/\{(\d+)\}/g,(_,index)=>found[Number(index)+1]??"");break;}}
  }
  return translated.replace(/\{(\d+)\}/g,(_,index)=>String(values[Number(index)]??`{${index}}`));
}
export const wholesaleNumber=(language,value)=>Number(value||0).toLocaleString(language==="id"?"id-ID":"zh-CN");
export const wholesaleMoney=(language,value)=>`IDR ${wholesaleNumber(language,value)}`;
export const wholesaleStamp=(language,value)=>value?new Intl.DateTimeFormat(language==="id"?"id-ID":"zh-CN",{timeZone:"Asia/Jakarta",dateStyle:"short",timeStyle:"short",hour12:false}).format(new Date(value)):"—";
export function wholesaleDownloadName(language,mode,date){
  if(language==="id")return mode==="all"?`Semua-Pesanan-Grosir-dan-Rekonsiliasi_${date}.xlsx`:`Rekonsiliasi-Bulanan-Grosir_${date}.xlsx`;
  return mode==="all"?`印尼批发全部订单及财务对账_${date}.xlsx`:`印尼批发财务月度对账_${date}.xlsx`;
}
export function wholesaleValidationMessage(language,validity,limits={}){
  if(validity.valueMissing)return language==="id"?"Lengkapi kolom wajib ini.":"请填写此必填项。";
  if(validity.badInput||validity.typeMismatch)return language==="id"?"Masukkan nilai dengan format yang benar.":"请输入格式正确的内容。";
  if(validity.rangeUnderflow)return language==="id"?`Nilai minimal ${limits.min}.`:`数值不能小于 ${limits.min}。`;
  if(validity.rangeOverflow)return language==="id"?`Nilai maksimal ${limits.max}.`:`数值不能大于 ${limits.max}。`;
  if(validity.stepMismatch)return language==="id"?"Masukkan bilangan bulat yang valid.":"请输入有效的整数。";
  if(validity.tooShort)return language==="id"?`Masukkan minimal ${limits.minLength} karakter.`:`请至少填写 ${limits.minLength} 个字符。`;
  return language==="id"?"Periksa isian ini.":"请检查此项填写内容。";
}
