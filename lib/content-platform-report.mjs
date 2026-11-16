import {salesMoney, SITE_CURRENCIES} from './sales-data.mjs';

const currencyNames={Rp:'IDR',IDR:'IDR',RM:'MYR',MYR:'MYR','฿':'THB',THB:'THB','₫':'VND','đ':'VND',VND:'VND','₱':'PHP',PHP:'PHP'};
const currencySymbols={IDR:'Rp',MYR:'RM',THB:'฿',VND:'₫',PHP:'₱'};
export const reportFields=[
  ['views','Video views','Views'],['likes','Likes'],['comments','Comments'],['shares','Shares'],
  ['followers','New followers'],['liveClicks','V-to-L clicks'],['impressions','Product impressions'],
  ['clicks','Product clicks'],['customers','Unique customers'],['orders','Attributed SKU orders','Video-attributed SKU orders'],
  ['videoOrders','Video SKU orders'],['indirectOrders','Video indirect SKU orders'],
  ['units','Video-attributed items sold'],['videoUnits','Video items sold'],['indirectUnits','Video indirect items sold'],
  ['attributedGmv','Video-attributed GMV'],['videoGmv','Video GMV'],['indirectGmv','Video indirect GMV'],['gpm','GPM'],
  ['gmv','GMV'],['ctr','Click-through rate','Product click-through rate'],['liveRate','V-to-L rate']
];
const money=new Set(['attributedGmv','videoGmv','indirectGmv','gpm','gmv']),rates=new Set(['ctr','liveRate']);
const idNames=['video id','video number','content id','视频编号','视频id'];
const linkNames=['video link','video url','video','video name','video title','视频链接'];
const norm=v=>String(v??'').normalize('NFKC').toLowerCase().replace(/[‐‑–—]/g,'-').replace(/\s+/g,' ').trim();
const fields=new Map(reportFields.flatMap(([key,...names])=>names.map(name=>[norm(name),key])));
function header(text){
  const match=String(text??'').normalize('NFKC').trim().match(/^(.*?)\s*\(([^()]*)\)\s*$/);
  return {name:norm(match?match[1]:text),unit:match?.[2].trim()};
}
export function reportHeaders(site){
  return ['Video ID',...reportFields.filter(([k])=>k!=='gmv').map(([k,title])=>money.has(k)?title+' ('+currencySymbols[SITE_CURRENCIES[site]]+')':title)];
}
export function findReportHeader(matrix){
  return matrix.slice(0,30).findIndex(row=>row.some(v=>[...idNames,...linkNames].includes(norm(v)))&&row.some(v=>fields.has(header(v).name)));
}
function videoId(v,strict){
  if(typeof v==='number'){
    if(!Number.isSafeInteger(v))throw Error('Excel 已舍入视频编号，请从平台复制原编号并按文本保存，或使用原始 CSV');
    return String(v);
  }
  const s=String(v??'').trim();
  if(/^\d{5,22}$/.test(s))return s;
  const m=s.match(/^https:\/\/(?:www\.|m\.)?tiktok\.com\/@[\w.-]+\/video\/(\d{5,22})(?:[/?#].*)?$/i);
  if(m)return m[1];
  if(strict&&s)throw Error('视频编号须为文本格式的完整数字，或填写 TikTok 视频完整链接');
  return '';
}
export function reportValues(row){
  const result={};
  for(const [key,label] of reportFields){
    let v=row[key];
    if(v===null||v===undefined||typeof v==='string'&&['','-','—','n/a'].includes(v.trim().toLowerCase()))continue;
    if(money.has(key))result[key]=salesMoney(v,label);
    else if(rates.has(key)){
      const s=String(v).trim().replace(/%$/,'');
      if(!/^\d+(?:\.\d+)?$/.test(s)||Number(s)>100)throw Error('请核对 '+label+' 的百分数');
      result[key]=Number(s);
    }else{
      const s=String(v).trim();
      if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(s)||!Number.isSafeInteger(Number(s.replaceAll(',',''))))throw Error('请核对 '+label+' 的件数或次数');
      result[key]=Number(s.replaceAll(',',''));
    }
  }
  if(!Object.keys(result).length)throw Error('缺少可导入指标');
  return result;
}
export function parseReport(matrix,site){
  const pos=findReportHeader(matrix);
  if(pos<0)throw Error('找不到视频编号或完整视频链接以及平台指标表头');
  const columns=[],identifiers=[],currency=SITE_CURRENCIES[site];
  if(!currency)throw Error('请选择报表所属站点');
  const seenFields=new Set();
  for(const [index,value] of matrix[pos].entries()){
    const {name,unit}=header(value),key=fields.get(name);
    if(idNames.includes(name)||linkNames.includes(name))identifiers.push({index,strict:idNames.includes(name)});
    if(!key)continue;
    if(seenFields.has(key))throw Error('重复指标列：'+value);seenFields.add(key);
    if(money.has(key)&&unit&&currencyNames[unit]!==currency&&currencyNames[unit.toUpperCase()]!==currency)throw Error(value+' 币种与'+site+'的 '+currency+' 不一致');
    columns.push([index,key]);
  }
  const seen=new Set(),rows=[];
  for(let i=pos+1;i<matrix.length;i++){
    const row=matrix[i];if(!row?.some(v=>v!=null&&v!==''))continue;
    try{
      const ids=new Set(identifiers.map(({index,strict})=>videoId(row[index],strict)).filter(Boolean));
      if(ids.size!==1)throw Error(ids.size?'同一行的编号与链接不一致':'缺少视频编号或完整视频链接');
      const [video]=ids;
      if(!/^\d{5,22}$/.test(video)||seen.has(video))throw Error('视频编号无效或在本表重复');
      seen.add(video);
      rows.push({videoId:video,line:i+1,...reportValues(Object.fromEntries(columns.map(([j,k])=>[k,row[j]])))});
    }catch(e){throw Error('第 '+(i+1)+' 行：'+e.message);}
  }
  if(!rows.length||rows.length>500)throw Error('每份平台报表需包含 1 至 500 条视频记录');
  return rows;
}
export function platformSheetRows(x,sheet,matrix,head){
  for(const [c,v] of matrix[head].entries()){
    const name=header(v).name,idColumn=idNames.includes(name)||linkNames.includes(name);
    if(!idColumn&&!rates.has(fields.get(name)))continue;
    for(let r=head+1;r<matrix.length;r++){
      const cell=sheet[x.utils.encode_cell({r,c})];
      if(idColumn&&cell?.l?.Target&&/^https:\/\/(?:www\.|m\.)?tiktok\.com\/@/i.test(cell.l.Target))matrix[r][c]=cell.l.Target;
      else if(!idColumn&&cell?.t==='n'&&cell.w?.trim().endsWith('%'))matrix[r][c]=cell.w;
    }
  }
  return matrix;
}
