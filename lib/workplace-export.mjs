const cell=value=>'"'+String(value??'').replace(/^[=+@-]/,'\t$&').replaceAll('"','""')+'"';
export function workplaceCsv(data,view){
 const rows=view==='finance'?[['法人','站点','币种','已批原币','已付原币','待核销原币','店铺数','已批人民币','缺汇率单数'],...data.summary.map(t=>[t.entity,t.site,t.currency,t.approved/100,t.paid/100,t.unallocated/100,t.shopCount,t.approvedCny==null?'待核定':t.approvedCny/100,t.fxMissing])]:[['员工','班次开始日','班次','时区','签到UTC','签退UTC','核对标记'],...data.days.map(d=>[d.name,d.work_date,d.plan?.name,d.plan?.timezone,d.in,d.out,d.flags.join('|')])];
 return '\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n');
}
