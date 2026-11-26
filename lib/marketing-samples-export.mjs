const cell=v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
export function marketingSampleCostCsv(summary,language='zh'){
 const id=language==='id',headers=id?['Pesanan sampel','Pengiriman','Pusat biaya','Jenis biaya','Tanggal biaya','Mata uang','Biaya asal','Kurs CNY','Biaya CNY','Baris bukti unik','Bukti','Revisi']:['样品单','出库单','归属','费用类型','费用日期','原币种','原币金额','人民币汇率','人民币金额','凭据唯一行号','凭据','修订版本'];
 const data=summary.lines.map(l=>[l.order_no,l.shipment_no,id?'Operasional TikTok Indonesia':l.costCenter,l.kind==='sample'?(id?'Biaya sampel':'样品成本'):(id?'Ongkos kirim sampel':'寄样运费'),l.business_date,l.currency,l.amount_minor/100,l.rate??(id?'Belum diverifikasi':'待核汇率'),l.cnyMinor==null?(id?'Belum diverifikasi':'待核汇率'):l.cnyMinor/100,l.source_ref,l.evidence,l.revision]);
 return '\ufeff'+[headers,...data].map(row=>row.map(cell).join(',')).join('\r\n');
}
