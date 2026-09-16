import {forecastPlan} from './forecast-model.mjs';
import {prorateAllocations} from './rules.mjs';
type AnyRow=Record<string,any>;
const parseJson=<T=any>(v:unknown,f:T):T=>{try{return JSON.parse(String(v))}catch{return f}};
const cleanText=(v:unknown,n:number)=>String(v||'').slice(0,n);
export async function loadForecast(db:any,actor:any,asOf=new Date(Date.now()+8*3600000).toISOString().slice(0,10)){
 const all=async(sql:string,args:unknown[]=[]):Promise<AnyRow[]> => (await db.prepare(sql).bind(...args).all()).results||[];
 const chinaDate=(offset=0)=>new Date(Date.parse(asOf)+offset*86400000).toISOString().slice(0,10);
 const daysFromToday=(v:unknown)=>/^\d{4}-\d{2}-\d{2}$/.test(String(v))?Math.ceil((Date.parse(String(v))-Date.parse(asOf))/86400000):null;
 const scope=actor.role==='运营'?{clause:' WHERE site=? AND channel=?',args:[actor.site,actor.channel]}:{clause:'',args:[]};
 const [inventory,skuSettings,batches,productionOrderRows,productionItemRows,purchaseItems,shipmentRows,shipmentItemRows,transportLegRows,transportItemRows,transportLegItemRows,policies,corrections]=await Promise.all([
 all(`SELECT * FROM inventory_balances${scope.clause}`,scope.args),all('SELECT * FROM sku_settings'),all('SELECT * FROM production_batches'),all('SELECT * FROM series_production_orders'),all('SELECT * FROM series_production_order_items'),all('SELECT * FROM series_purchase_order_items'),all('SELECT * FROM shipment_batches'),all('SELECT * FROM shipment_batch_items'),all('SELECT * FROM transport_legs'),all('SELECT * FROM transport_batch_items'),all('SELECT * FROM transport_leg_items'),all(`SELECT * FROM supply_policies${scope.clause}`,scope.args),all(`SELECT * FROM sales_demand_corrections${scope.clause}`,scope.args)]);
 const purchaseItemById=new Map<string,AnyRow>(purchaseItems.map((r:AnyRow)=>[r.id,r]));
 const shippedByProductionItem=new Map<string,number>();for(const r of shipmentItemRows)shippedByProductionItem.set(r.production_order_item_id,(shippedByProductionItem.get(r.production_order_item_id)||0)+Number(r.shipped_qty));for(const r of transportItemRows)shippedByProductionItem.set(r.production_order_item_id,(shippedByProductionItem.get(r.production_order_item_id)||0)+Number(r.shipped_qty));
    const cutoff28 = chinaDate(-55);
    const [salesDaily, importCoverage] = await Promise.all([
      all(`SELECT business_date,site,channel,sku,SUM(qty) qty FROM sales_records${scope.clause ? scope.clause + " AND " : " WHERE "}reversed_at IS NULL AND business_date>=? AND business_date<=? GROUP BY business_date,site,channel,sku`, [...scope.args,cutoff28,chinaDate()]),
      all(`SELECT site,channel,COUNT(DISTINCT business_date) data_days,MAX(business_date) last_sale_date,GROUP_CONCAT(DISTINCT business_date) imported_dates FROM sales_imports${scope.clause ? scope.clause + " AND " : " WHERE "}reversed_at IS NULL AND business_date>=? AND business_date<=? GROUP BY site,channel`, [...scope.args,cutoff28,chinaDate()]),
    ]);
    const dayKeys = Array.from({length:56},(_,index)=>chinaDate(index-55));
    const dayIndex = new Map(dayKeys.map((date,index)=>[date,index]));
    const dailySales = new Map<string,number[]>();
    for (const row of salesDaily) {
      const key = `${row.site}|${row.channel}|${row.sku}`;
      const values = dailySales.get(key) ?? Array(56).fill(0);
      const index = dayIndex.get(String(row.business_date));
      if (index !== undefined) values[index] += Number(row.qty || 0);
      dailySales.set(key,values);
    }
    const coverage = new Map<string,AnyRow>(importCoverage.map((row:AnyRow)=>[`${row.site}|${row.channel}`,row]));
    const settings = new Map<string, AnyRow>(skuSettings.map((r:AnyRow) => [r.sku, r]));
    const seaTransit = new Map<string,number>();
    const productionPipeline = new Map<string,number>();
    const warehousePending = new Map<string,number>();
    const seaArrivals = new Map<string,Array<{qty:number;etaDate:string;days:number|null}>>();
    for (const batch of batches.filter((row) => !["arrived","completed","shelf_pending","on_shelf"].includes(row.stage))) {
      for (const allocation of parseJson<Array<{site:string;channel:string;qty:number}>>(batch.allocations_json, [])) {
        const key = `${allocation.site}|${allocation.channel}|${batch.sku}`;
        const qty = Number(allocation.qty || 0);
        if (["sea_freight","port_arrived","last_mile_delivery","awaiting_receipt"].includes(batch.stage)) {
          seaTransit.set(key,(seaTransit.get(key)??0)+qty);
          const lots=seaArrivals.get(key)??[];
          lots.push({qty,etaDate:cleanText(batch.estimated_arrival_date,10),days:daysFromToday(batch.estimated_arrival_date)});
          seaArrivals.set(key,lots);
        } else if (["supply_confirm","factory_production","channel_allocation"].includes(batch.stage)) {
          productionPipeline.set(key,(productionPipeline.get(key)??0)+qty);
        }
      }
    }
    for(const item of productionItemRows){
      if(productionOrderRows.find((o:AnyRow)=>o.id===item.production_order_id)?.status==="cancelled")continue;
      const purchaseItem=purchaseItemById.get(item.purchase_order_item_id);
      if(!purchaseItem) continue;
      const baseQty=Number(item.produced_qty||0)>0?Number(item.produced_qty):Number(item.planned_qty||0);
      const remaining=Math.max(0,baseQty-(shippedByProductionItem.get(item.id)??0));
      for(const allocation of prorateAllocations(parseJson(purchaseItem.allocations_json,[]),remaining)){
        const key=`${allocation.site}|${allocation.channel}|${item.sku}`;
        productionPipeline.set(key,(productionPipeline.get(key)??0)+allocation.qty);
      }
    }
    const shipmentById=new Map<string,AnyRow>(shipmentRows.map((row)=>[row.id,row]));
    for(const item of shipmentItemRows){
      const shipment=shipmentById.get(item.batch_id);
      if(!shipment||["shelf_pending","on_shelf"].includes(shipment.stage)) continue;
      const remaining=Math.max(0,Number(item.shipped_qty||0)-Number(item.received_qty||0));
      for(const allocation of prorateAllocations(parseJson(item.allocations_json,[]),remaining)){
        const key=`${allocation.site}|${allocation.channel}|${item.sku}`;
        if(shipment.stage==="channel_allocation") productionPipeline.set(key,(productionPipeline.get(key)??0)+allocation.qty);
        else if(["sea_freight","port_arrived","last_mile_delivery","awaiting_receipt"].includes(shipment.stage)){
          seaTransit.set(key,(seaTransit.get(key)??0)+allocation.qty);
          const lots=seaArrivals.get(key)??[];
          lots.push({qty:allocation.qty,etaDate:cleanText(shipment.estimated_arrival_date,10),days:daysFromToday(shipment.estimated_arrival_date)});
          seaArrivals.set(key,lots);
        }
      }
    }
    const transportLegById=new Map<string,AnyRow>(transportLegRows.map((row)=>[row.id,row]));
    const transportBatchItemSourceById=new Map<string,AnyRow>(transportItemRows.map((row)=>[row.id,row]));
    for(const item of transportLegItemRows){
      const leg=transportLegById.get(item.leg_id),source=transportBatchItemSourceById.get(item.batch_item_id);
      if(!leg||!source||leg.stage==="on_shelf") continue;
      const key=`${leg.site}|${leg.channel}|${item.sku}`;
      const remainingTransit=Math.max(0,Number(item.qty||0)-Number(item.received_qty||0));
      if(leg.stage==="booking") productionPipeline.set(key,(productionPipeline.get(key)??0)+remainingTransit);
      else if(["sea_freight","port_arrived","customs_clearance","last_mile_delivery","awaiting_receipt"].includes(leg.stage)){
        seaTransit.set(key,(seaTransit.get(key)??0)+remainingTransit);
        const lots=seaArrivals.get(key)??[];
        lots.push({qty:remainingTransit,etaDate:cleanText(leg.eta,10),days:daysFromToday(leg.eta)});
        seaArrivals.set(key,lots);
      }
      const pending=Number(item.pending_shelf_qty||0);
      if(pending>0) warehousePending.set(key,(warehousePending.get(key)??0)+pending);
    }
    const visibleKey=(key:string)=>{
      if(actor.role!=="运营") return true;
      const [site,channel]=key.split("|");
      return site===actor.site&&channel===actor.channel;
    };
    const inventoryByKey=new Map<string,AnyRow>(inventory.map((row)=>[`${row.site}|${row.channel}|${row.sku}`,row]));
    const suggestionKeys=new Set<string>([...inventoryByKey.keys(),...dailySales.keys(),...seaTransit.keys(),...productionPipeline.keys(),...warehousePending.keys()].filter(visibleKey));
    const suggestions:AnyRow[] = [...suggestionKeys].map((key) => {
      const [site,channel,sku]=key.split("|");
      const setting = settings.get(sku) ?? {};
      const row:AnyRow=inventoryByKey.get(key)??{site,channel,sku,name:setting.name??"",qty:0,updated_at:""};
      const arrivals=(seaArrivals.get(key)??[]).filter((lot)=>lot.days!==null).sort((a,b)=>Number(a.days)-Number(b.days));
      const scopeCoverage=coverage.get(`${site}|${channel}`)??{};
      const importedDates=new Set(String(scopeCoverage.imported_dates||"").split(",").filter(Boolean));
      const policy=policies.find((p:AnyRow)=>p.sku===sku&&p.site===site&&p.channel===channel)||{};
      const plan:AnyRow=forecastPlan({
        dailySales:dailySales.get(key)??Array(56).fill(0),
        dailyCoverage:dayKeys.map((date)=>importedDates.has(date)),
        currentQty:Number(row.qty)-Number(row.reserved_qty||0),
        pendingShelf:warehousePending.get(key)??Number(row.pending_shelf_qty||0),
        seaInTransit:seaTransit.get(key)??0,
        productionInProgress:productionPipeline.get(key)??0,
        productionLeadDays:Number(setting.production_lead_days??21),
        seaLeadDays:Number(setting.sea_lead_days??35),
        reviewCycleDays:Number(setting.review_cycle_days??7),
        serviceLevel:Number(setting.service_level??0.95),
        minOrderQty:Number(setting.min_order_qty??1),
        orderMultiple:Number(setting.order_multiple??1),
        daysToNextSea:arrivals[0]?.days??null,
        dataDays:Number(scopeCoverage.data_days??0),
        daysSinceLastImport:scopeCoverage.last_sale_date ? Math.max(0,-Number(daysFromToday(scopeCoverage.last_sale_date))) : null,
      },policy,corrections.filter((c:AnyRow)=>c.sku===sku&&c.site===site&&c.channel===channel),dayKeys,chinaDate());
      return {
        ...row,...plan,bookQty:Number(row.qty),qty:Number(row.qty)-Number(row.reserved_qty||0),
        seaInTransit:seaTransit.get(key)??0,
        productionInProgress:productionPipeline.get(key)??0,
        pendingShelfQty:warehousePending.get(key)??Number(row.pending_shelf_qty||0),
        nextSeaEta:arrivals[0]?.etaDate||"",
        lastSaleDate:scopeCoverage.last_sale_date||"",
        dailySeries:dayKeys.map((date,index)=>({date,qty:Number(plan.dailySales[index]||0)})),
        suggestedQty:plan.suggestedProduction,
      } as AnyRow;
    }).sort((a,b) => {
      const order:Record<string,number>={critical:0,data:1,eta:2,warning:3,watch:4,healthy:5};
      return (order[String(a.alertLevel)]??9)-(order[String(b.alertLevel)]??9)||Number(b.suggestedProduction)-Number(a.suggestedProduction);
    });

return {suggestions,salesDaily,policies};
}
