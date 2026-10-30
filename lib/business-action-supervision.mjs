// Unassigned evidence gaps are not overdue execution commitments. Once assigned,
// verification deadlines count too; an executed action always keeps its review duty.
export function actionOverdue(record,now=Date.now()){
 if(record.status==='resolved')return false;
 const snapshot=record.snapshot||JSON.parse(record.snapshot_json||'{}');
 if(record.status!=='review_pending'&&record.status!=='in_progress'&&!record.owner_id&&snapshot.condition!=='active')return false;
 const due=Date.parse(record.status==='review_pending'?record.review_at:record.due_at);
 return Number.isFinite(due)&&due<=Number(now);
}
