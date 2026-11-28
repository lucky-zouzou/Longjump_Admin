// Contract reminders are distinct from already shipped/sold receivables.
export function domesticOverdue({status,mode,dueDate,remaining,receivable,unsold,today=new Date(Date.now()+8*3600000).toISOString().slice(0,10)}){
 const overdue=status==='approved'&&dueDate&&dueDate<today&&(remaining>0||unsold>0);
 const kind=!overdue?'':receivable>0?'receivable':mode==='consignment'&&unsold>0?'consignment':'payment';
 return {overdueKind:kind,overdueReceivableMinor:overdue?receivable:0,overdueLabel:({receivable:'已发 / 已售应收逾期',consignment:'寄售到期待对账',payment:'约定付款逾期 · 未形成已发应收'})[kind]||'',overdueDays:overdue?Math.floor((Date.parse(today)-Date.parse(dueDate))/86400000):0};
}
