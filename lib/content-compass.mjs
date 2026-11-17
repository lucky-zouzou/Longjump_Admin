import {creatorSites} from './creator-model.mjs';
import {hasPermission} from './permissions.mjs';

const periods=new Set(['month','previous','week','thirty','all']);
const dayMs=86400000;
const offsets={'马来西亚':8,'印尼':7,'泰国':7,'越南':7,'菲律宾':8};

// Calendar boundaries use each site's reporting clock (WIB for Indonesia).
function interval(site,period,now){
  const offset=offsets[site]*3600000,local=new Date(now+offset);
  const year=local.getUTCFullYear(),month=local.getUTCMonth(),today=Date.UTC(year,month,local.getUTCDate());
  const start=period==='all'?0:period==='previous'?Date.UTC(year,month-1,1):
    period==='month'?Date.UTC(year,month,1):today-(period==='week'?6:29)*dayMs;
  const end=period==='previous'?Date.UTC(year,month,1)-offset:now+1;
  return [site,new Date(start-offset).toISOString(),new Date(end).toISOString(),'+'+offsets[site]+' hours'];
}

// Platform exports describe a reporting interval, independent of the publication date.
export function reportDayBounds(site,period,now){
  if(!periods.has(period))throw Object.assign(Error('请选择有效的统计期间'),{status:400});
  const [,start,end]=interval(site,period,now),offset=offsets[site]*3600000;
  const localDate=instant=>new Date(instant+offset).toISOString().slice(0,10);
  return [localDate(Date.parse(start)),localDate(Date.parse(end)-1)];
}

const ratedAmounts=`rated AS (
      SELECT a.*,CASE WHEN a.currency='CNY' THEN 1
        WHEN e.status='closed' THEN json_extract(e.snapshot_json,'$.rates.'||a.currency||'.rate')
        ELSE (SELECT rate FROM finance_rates WHERE month=a.month AND currency=a.currency ORDER BY revision DESC LIMIT 1) END rate
      FROM amounts a LEFT JOIN finance_period_events e ON e.month=a.month AND e.revision=(SELECT MAX(revision) FROM finance_period_events WHERE month=a.month)
    )`;
const metricTotals=`SUM(views) views,SUM(viewCount) viewCount,SUM(orders) orders,SUM(orderCount) orderCount,
      SUM(CASE WHEN rate>0 THEN ROUND(amount*rate) END) gmvMinor,
      SUM(CASE WHEN rate>0 THEN amountCount ELSE 0 END) gmvCount,
      SUM(CASE WHEN rate IS NULL THEN amountCount ELSE 0 END) missingRate`;

export async function readContentCompass(db,actor,period='month',now=Date.now()){
  if(!hasPermission(actor.role,'content.read'))throw Object.assign(Error('当前岗位不可查看内容罗盘'),{status:403});
  if(!periods.has(period))throw Object.assign(Error('请选择有效的统计期间'),{status:400});
  const ranges=creatorSites.map(site=>interval(site,period,now));
  // Each published video contributes exactly one cumulative observation. Revisions
  // replace that window. Missing fields in the winning observation remain unknown.
  const sql=`WITH ranges(site,start_at,end_at,offset) AS (VALUES ${ranges.map(()=>'(?,?,?,?)').join(',')}),
    observations AS (
      SELECT p.id,p.site,strftime('%Y-%m',p.published_at,r.offset) month,
        (SELECT m.id FROM content_metrics m WHERE m.post_id=p.id
           ORDER BY m.days DESC,m.revision DESC LIMIT 1) metric_id,
        CASE WHEN p.original=1 THEN (SELECT o.id FROM creator_observations o
           WHERE o.content_id=s.source_content_id AND o.window_days IN (7,30)
           ORDER BY o.window_days DESC,o.revision DESC LIMIT 1) END creator_observation
      FROM ranges r JOIN content_posts p ON p.site=r.site AND p.published_at>=r.start_at AND p.published_at<r.end_at
      JOIN content_versions v ON v.id=p.version_id JOIN content_scripts s ON s.id=v.script_id
    ), selected AS (
      SELECT a.site,a.month,
        CASE WHEN o.id IS NULL THEN m.views ELSE json_extract(o.data_json,'$.views') END views,
        CASE WHEN o.id IS NULL THEN m.orders ELSE json_extract(o.data_json,'$.orders') END orders,
        CASE WHEN o.id IS NULL THEN m.gmv_minor ELSE json_extract(o.data_json,'$.revenueMinor') END amount,
        CASE WHEN o.id IS NULL THEN m.currency ELSE json_extract(o.data_json,'$.currency') END currency
      FROM observations a LEFT JOIN content_metrics m ON m.id=a.metric_id LEFT JOIN creator_observations o ON o.id=a.creator_observation
    ), amounts AS (
      SELECT site,month,currency,COUNT(*) videos,COUNT(views) viewCount,SUM(views) views,
        COUNT(orders) orderCount,SUM(orders) orders,COUNT(amount) amountCount,SUM(amount*1.0) amount
      FROM selected GROUP BY site,month,currency
    ), ${ratedAmounts}
    SELECT site,SUM(videos) videos,${metricTotals}
    FROM rated GROUP BY site`;
  const rows=(await db.prepare(sql).bind(...ranges.flat()).all()).results;
  return {period,rows:creatorSites.map(site=>rows.find(row=>row.site===site)||
    {site,videos:0,views:null,viewCount:0,orders:null,orderCount:0,gmvMinor:null,gmvCount:0,missingRate:0})};
}

// Detail and totals use the same revision, date boundary and selected report interval.
export function platformReportSelection(sites,period,range,now){
  if(range && !/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(range))
    throw Object.assign(Error('请选择有效的报表期间'),{status:400});
  const bounds=sites.map(site=>[site,...reportDayBounds(site,period,now)]);
  const boundsSql=`bounds(site,first_day,last_day) AS (VALUES ${bounds.map(()=>'(?,?,?)').join(',')})`;
  const fromSql=`FROM content_platform_reports r JOIN bounds b ON b.site=r.site AND r.end_day BETWEEN b.first_day AND b.last_day`;
  const latestSql=`${fromSql} WHERE NOT EXISTS (SELECT 1 FROM content_platform_reports n
    WHERE n.site=r.site AND n.video_id=r.video_id AND n.start_day=r.start_day AND n.end_day=r.end_day AND n.revision>r.revision)
    ${range?'AND r.start_day=? AND r.end_day=?':''}`;
  return {boundsSql,fromSql,latestSql,boundsArgs:bounds.flat(),args:[...bounds.flat(),...(range?range.split('~'):[])]};
}

export async function summarizePlatformReports(db,sites,period,range,now){
  if(!sites.length)return {rows:[],ranges:[]};
  const {boundsSql,fromSql,latestSql,boundsArgs,args}=platformReportSelection(sites,period,range,now);
  // Disjoint intervals add. A covering report replaces its nested intervals. A
  // crossing pair has no recoverable sum without daily data, so expose the conflict.
  const sql=`WITH ${boundsSql}, current AS (
    SELECT r.site,r.video_id,r.start_day,r.end_day,r.currency,r.metrics_json,
      MAX(r.end_day) OVER (PARTITION BY r.site,r.video_id ORDER BY r.start_day,r.end_day
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) prior_end ${latestSql}
  ), numbered AS (
    SELECT *,SUM(CASE WHEN prior_end>=start_day THEN 0 ELSE 1 END) OVER
      (PARTITION BY site,video_id ORDER BY start_day,end_day) grp FROM current
  ), covered AS (
    SELECT *,MIN(start_day) OVER series first_day,MAX(end_day) OVER series last_day
    FROM numbered WINDOW series AS (PARTITION BY site,video_id,grp)
  ), samples AS (
    SELECT site,video_id,grp,currency,substr(MAX(end_day),1,7) month,
      MAX(CASE WHEN start_day=first_day AND end_day=last_day THEN metrics_json END) metrics
    FROM covered GROUP BY site,video_id,grp,currency
  ), amounts AS (
    SELECT site,month,currency,COUNT(metrics) entries,COUNT(*)-COUNT(metrics) overlaps,
      COUNT(json_extract(metrics,'$.views')) viewCount,SUM(json_extract(metrics,'$.views')) views,
      COUNT(json_extract(metrics,'$.orders')) orderCount,SUM(json_extract(metrics,'$.orders')) orders,
      COUNT(json_extract(metrics,'$.attributedGmv')) amountCount,SUM(ROUND(json_extract(metrics,'$.attributedGmv')*100)) amount
    FROM samples GROUP BY site,month,currency
  ), ${ratedAmounts}
  SELECT site,SUM(entries) entries,SUM(overlaps) overlaps,${metricTotals} FROM rated GROUP BY site`;
  const [summary,periods]=await Promise.all([
    db.prepare(sql).bind(...args).all(),
    db.prepare(`WITH ${boundsSql} SELECT DISTINCT r.site,r.start_day AS start,r.end_day AS end ${fromSql}
      ORDER BY end DESC,start DESC`).bind(...boundsArgs).all()
  ]);
  return {rows:sites.map(site=>summary.results.find(row=>row.site===site)||
    {site,entries:0,overlaps:0,views:null,viewCount:0,orders:null,orderCount:0,gmvMinor:null,gmvCount:0,missingRate:0}),ranges:periods.results};
}
