/** The movement's NOT NULL balance is the transactional assertion. If the
 * expected balance/request changed, the whole D1 batch aborts before overwrite. */
export function countStatements(db,input){
  const {site,channel,sku,name,from,to,reference,actorId,reason,timestamp,requestId=null}=input;
  return [
    db.prepare(`INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at)
      VALUES (?,?,?,?,?,?,?,CASE WHEN COALESCE((SELECT qty FROM inventory_balances WHERE site=? AND channel=? AND sku=?),0)=?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM inventory_count_requests WHERE id=? AND status='pending')) THEN ? ELSE NULL END,?,?,?,?,?)`)
      .bind(`move_${crypto.randomUUID()}`,site,channel,sku,name,requestId?"盘点复核":"盘点调整",to-from,site,channel,sku,from,requestId,requestId,to,requestId?"盘点差异单":"盘点单",reference,reason,actorId,timestamp),
    db.prepare("INSERT INTO inventory_balances (site,channel,sku,name,qty,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET qty=excluded.qty,updated_at=excluded.updated_at")
      .bind(site,channel,sku,name,to,timestamp),
  ];
}

export function reversalStatements(db,{source,records,reason,actorId,timestamp}){
  const statements=[];
  for(const row of records)statements.push(
    db.prepare(`INSERT INTO inventory_movements (id,site,channel,sku,name,movement_type,qty_delta,balance_after,reference_type,reference_id,note,actor_id,created_at)
      VALUES (?,?,?,?,?,'销售冲销',?,CASE WHEN EXISTS (SELECT 1 FROM sales_imports WHERE id=? AND reversed_at IS NULL)
      THEN COALESCE((SELECT qty FROM inventory_balances WHERE site=? AND channel=? AND sku=?),0)+? ELSE NULL END,'销售冲销',?,?,?,?)`)
      .bind(`move_${crypto.randomUUID()}`,source.site,source.channel,row.sku,row.name,Number(row.qty),source.id,source.site,source.channel,row.sku,Number(row.qty),source.id,reason,actorId,timestamp),
    db.prepare("INSERT INTO inventory_balances (site,channel,sku,name,qty,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(site,channel,sku) DO UPDATE SET qty=inventory_balances.qty+excluded.qty,updated_at=excluded.updated_at")
      .bind(source.site,source.channel,row.sku,row.name,Number(row.qty),timestamp),
  );
  return statements;
}
