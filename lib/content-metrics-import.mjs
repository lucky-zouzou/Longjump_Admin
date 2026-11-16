export const metricColumns=[
  ['url','视频链接'],['days','观察窗口（天）'],['observedAt','取数时间（本机时区）'],
  ['views','播放量'],['clicks','商品点击数'],['cartAdds','加购次数'],['orders','归属订单数'],
  ['retention','前3秒留存率（%）'],['evidence','数据出处'],['note','统计口径或缺失原因']
];

function observedTime(value){
  if(value instanceof Date && Number.isFinite(value.getTime()))return value.toISOString();
  const text=String(value??'').trim();
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d\d:\d\d)$/.test(text)&&Number.isFinite(Date.parse(text)))return new Date(text).toISOString();
  const m=/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if(m){
    const [,year,month,day,hour,minute,second]=m.map(Number);
    const date=new Date(year,month-1,day,hour,minute,second||0);
    if(date.getFullYear()===year&&date.getMonth()===month-1&&date.getDate()===day&&date.getHours()===hour&&date.getMinutes()===minute&&date.getSeconds()===(second||0))return date.toISOString();
  }
  throw Error('请填写完整取数日期和时间，例如 2026-11-16 09:00');
}

function videoKey(value){
  const url=new URL(String(value));
  if(url.protocol!=='https:'||!['www.tiktok.com','tiktok.com','m.tiktok.com'].includes(url.hostname)||url.username||url.password)return '';
  return /^\/@[\w.-]+\/video\/\d+\/?$/.test(url.pathname)?url.pathname.replace(/\/$/,''):'';
}

// Preserve the percentage shown by Excel (a stored 0.35 may display as 35%).
export function metricSheetRows(x,sheet){
  const matrix=x.utils.sheet_to_json(sheet,{header:1,raw:true,defval:'',blankrows:true,range:0});
  const index=(matrix[0]||[]).indexOf(metricColumns[7][1]);
  if(index>=0){
    for(let i=1;i<matrix.length;i++){
      const cell=sheet[x.utils.encode_cell({r:i,c:index})];
      if(cell?.t==='n'&&typeof cell.w==='string'&&cell.w.trim().endsWith('%'))matrix[i][index]=cell.v*100;
    }
  }
  return matrix;
}

export function parseMetricSheet(matrix,posts){
  const headers=(matrix[0]||[]).map(v=>String(v??'').trim());
  const indices=Object.fromEntries(metricColumns.map(([key,title])=>[key,headers.indexOf(title)]));
  for(const [key,title] of metricColumns){
    if(indices[key]<0||headers.lastIndexOf(title)!==indices[key])throw Error('请使用效果数据模板并检查列「'+title+'」');
  }
  const published=new Map(posts.map(post=>[videoKey(post.url),post])),seen=new Set(),rows=[];
  for(let i=1;i<matrix.length;i++){
    const cells=matrix[i]||[];
    if(!cells.some(v=>v!==null&&v!==undefined&&v!==''))continue;
    const input=Object.fromEntries(metricColumns.map(([key])=>[key,cells[indices[key]]??'']));
    try{
      let key;try{key=videoKey(input.url);}catch{key='';}
      const post=published.get(key);if(!key||!post)throw Error('请先在本站登记该视频的完整发布链接');
      input.days=Number(input.days);if(![1,7].includes(input.days)||post.original&&input.days===7)throw Error('请核对观察窗口；达人原片的7天数据由达人模块维护');
      const unique=key+'/'+input.days;if(seen.has(unique))throw Error('同一视频及观察窗口重复');seen.add(unique);
      input.observedAt=observedTime(input.observedAt);input.version=post.version;
      if(Date.parse(input.observedAt)>Date.now()||Date.parse(input.observedAt)<Date.parse(post.published_at)+input.days*86400000)throw Error('观察窗口未到期或取数时间在未来');
      for(const [key,title] of metricColumns.slice(3,8)){
        if(input[key]==='')continue;
        const value=key==='retention'&&typeof input[key]==='string'?input[key].trim().replace(/%$/,''):input[key];
        const n=Number(value);
        if(!['number','string'].includes(typeof input[key])||!String(value).trim()||!Number.isFinite(n)||n<0||(key==='retention'?n>100:!Number.isSafeInteger(n)))throw Error('请核对'+title);
        input[key]=n;
      }
      if(!String(input.evidence).trim()||!String(input.note).trim())throw Error('请填写数据出处和统计口径或缺失原因');
      rows.push({...input,line:i+1});
    }catch(error){throw Error('第 '+(i+1)+' 行：'+error.message);}
  }
  if(!rows.length||rows.length>100)throw Error('每个文件需包含 1 至 100 行效果数据');
  return rows;
}
