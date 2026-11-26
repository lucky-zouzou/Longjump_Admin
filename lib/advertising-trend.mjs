import {salesFactStatements} from './sales-facts.mjs';
import {advertisingTrendFilters,buildAdvertisingTrend} from './advertising-trend-model.mjs';

export async function readAdvertisingTrend(db,actor,input={},now=new Date()){
 const filters=advertisingTrendFilters(actor,input,now);
 const [sales,spend,coverage]=(await db.batch(salesFactStatements(db,filters.from,filters.to,{sql:' AND site=? AND channel=?',args:[filters.site,filters.channel]}))).map(r=>r.results||[]);
 return {...buildAdvertisingTrend({sales,spend,coverage},filters),permissions:{canView:true,canChooseScope:actor.role!=='运营',scopeLocked:actor.role==='运营'}};
}
