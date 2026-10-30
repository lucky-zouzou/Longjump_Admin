import {productCostAccess} from './product-costs.mjs';
import {atomicBatch,assertWritable,guardStatement} from './atomic.mjs';
import {localDay,shiftDay,validDay} from './promotion-model.mjs';
const rows=async(db,sql,args=[])=>(await db.prepare(sql).bind(...args).all()).results||[];
const fail=(m,status=400)=>{throw Object.assign(new Error(m),{status});};
const key=r=>JSON.stringify([r.site,r.channel,r.sku]);
const hash=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))),n=>n.toString(16).padStart(2,'0')).join('');
const clock=async db=>(await db.prepare("SELECT version FROM business_action_source_clock WHERE id='global'").first())?.version||0;
export async function readProductEvidence(db,a,now=new Date()){
 await productCostAccess(db,a);const version=await clock(db),f=a.role==='运营'?' AND site=? AND channel=?':'',args=a.role==='运营'?[a.site,a.channel]:[];
 const [stocks,sales,shelf,observations,verified]=await Promise.all([
 rows(db,"SELECT * FROM inventory_balances WHERE site IN ('印尼','马来西亚','菲律宾','泰国','越南') AND channel IN ('TikTok','Shopee')"+f,args),
 rows(db,'SELECT site,channel,sku,MIN(business_date) first_sale,COUNT(*) records FROM sales_records WHERE reversed_at IS NULL AND qty>0'+f+' GROUP BY site,channel,sku',args),
 rows(db,'SELECT l.site,l.channel,i.sku,c.id,c.confirmed_at,c.listing_ref,c.shelved_qty FROM transport_shelf_confirmations c JOIN transport_leg_items i ON i.id=c.leg_item_id JOIN transport_legs l ON l.id=i.leg_id'+(a.role==='运营'?' WHERE l.site=? AND l.channel=?':''),args),
 rows(db,'SELECT * FROM promotion_stock_days WHERE 1=1'+f+' ORDER BY day',args),rows(db,'SELECT * FROM promotion_availability WHERE 1=1'+f,args)]);
 const items=await Promise.all(stocks.map(async s=>{const sale=sales.find(r=>key(r)===key(s)),confirmations=shelf.filter(r=>key(r)===key(s)),days=observations.filter(r=>key(r)===key(s)),existing=verified.find(r=>key(r)===key(s)),cutoff=shiftDay(localDay(now,s.site),-1);
  const dates=[sale?.first_sale,...confirmations.map(c=>localDay(new Date(c.confirmed_at),s.site))].filter(Boolean).sort();
  const sources={sale:sale||null,shelf:confirmations,stockDays:days.filter(d=>d.day>=shiftDay(cutoff,-27)).map(d=>({day:d.day,minAvailable:d.min_available})),verified:existing||null,available:s.qty-s.reserved_qty,stockUpdatedAt:s.updated_at};
  return {site:s.site,channel:s.channel,sku:s.sku,available:s.qty-s.reserved_qty,cutoff,suggestedListedSince:existing?.listed_since||dates[0]||'',sources,basisHash:await hash(sources)};
 }));
 if(await clock(db)!==version)fail('商品证据变化，请刷新候选',409);
 return {items,version,canVerify:['管理员','运营'].includes(a.role),method:'系统首销和真实上架记录仅为待核验候选；首销不等于连续上架或连续有货。由管理员或本站运营逐项确认，未确认费用和有货日期不补零。'};
}
export async function verifyProductEvidence(db,a,p,now=new Date()){
 await productCostAccess(db,a);if(!['管理员','运营'].includes(a.role))fail('仅管理员或本站运营可核验在售事实',403);await assertWritable(db);
 if(!Array.isArray(p.items)||!p.items.length||p.items.length>100||new Set(p.items.map(key)).size!==p.items.length)fail('每次选择1至100个不重复的站点平台SKU');
 if(p.confirmed!==true||String(p.reference||'').trim().length<4||String(p.note||'').trim().length<4)fail('请提供核验凭据、说明，并确认已逐项核对平台状态');
 const candidates=await readProductEvidence(db,a,now);if(candidates.version!==p.version)fail('候选已变化，请重新核对',409);const statements=[];
 for(const item of p.items){const row=candidates.items.find(r=>key(r)===key(item));if(!row||row.basisHash!==item.basisHash)fail('无权核验此范围或候选证据已变化',409);
  const listed=item.listedSince;if(!validDay(listed)||listed>row.cutoff)fail(`${row.sku} 需要有效的上架日期，不能根据入库直接认定`);
  const old=row.sources.verified;let available=old?.available_since||'',through=old?.verified_through||'';
  if(item.confirmAvailability===true){available=item.availableSince;through=row.cutoff;if(!validDay(available)||available<listed||available>through||row.available<=0)fail(`${row.sku} 连续有货日期或当前库存无效`);
   if(await db.prepare('SELECT 1 FROM promotion_stock_days WHERE site=? AND channel=? AND sku=? AND day BETWEEN ? AND ? AND min_available<=0').bind(row.site,row.channel,row.sku,available,through).first())fail(`${row.sku} 存在无可售库存记录，不得覆盖断货事实`);
  }else if(available&&available<listed){available='';through='';}
  statements.push(db.prepare('INSERT INTO promotion_availability VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET listed_since=excluded.listed_since,available_since=excluded.available_since,verified_through=excluded.verified_through,reference=excluded.reference,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at').bind(row.site,row.channel,row.sku,listed,available,through,String(p.reference).trim().slice(0,600),String(p.note).trim().slice(0,2000),a.id,now.toISOString()),db.prepare('INSERT INTO audit_logs(id,action,entity_type,entity_id,detail_json,actor_id,actor_name,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),'product.evidence.verify','promotion_availability',key(row),JSON.stringify({before:old||null,listed,available,through,sources:row.sources,reference:p.reference,note:p.note}),a.id,a.name,now.toISOString()));
 }
 await atomicBatch(db,[guardStatement(db,a,'product.evidence.batch',"COALESCE((SELECT version FROM business_action_source_clock WHERE id='global'),0)=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND active=1 AND role=? AND (?<>'运营' OR (site=? AND channel=?)))",[candidates.version,a.id,a.role,a.role,a.site||'',a.channel||'']),...statements]);return {ok:true,count:p.items.length};
}
