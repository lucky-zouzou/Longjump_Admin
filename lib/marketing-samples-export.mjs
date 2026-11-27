const cell=v=>{let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
export function sampleAllocationCsv(value,language='zh'){
 const id=language==='id',headers=id?['Bulan','Tanggal batas penjualan','Revisi dasar','Toko','Operator','Penjualan CNY','Porsi','Bukti penjualan','Sampel','Pengiriman','Jenis biaya','Mata uang','Alokasi asal','Alokasi CNY','Revisi biaya']:['月份','销售额截止日','销售额依据版本','店铺','负责运营','销售额人民币','占比','销售额凭据','样品单','出库单','费用类型','原币','分摊原币','分摊人民币','成本版本'];
 const data=value.lines.map(l=>{const r=value.rows.find(r=>r.scopeId===l.scopeId);return [value.month,value.throughDate,value.revision,l.shop,l.operatorName,r?.revenueCnyMinor==null?'':r.revenueCnyMinor/100,l.share,r?.evidence,l.orderNo,l.shipmentNo,l.kind==='sample'?(id?'Biaya sampel':'样品成本'):(id?'Ongkos kirim':'寄样运费'),l.currency,l.amountMinor/100,l.cnyMinor==null?(id?'Belum diverifikasi':'待核'):l.cnyMinor/100,l.sourceRevision];});
 return '\ufeff'+[headers,...data].map(row=>row.map(cell).join(',')).join('\r\n');
}
export function marketingSampleCostCsv(summary,language='zh'){
 const id=language==='id',headers=id?['Jenis mitra','Mitra','Pesanan sampel','Pengiriman','Pusat biaya','Jenis biaya','Tanggal biaya','Mata uang','Biaya asal','Kurs CNY','Biaya CNY','Baris bukti unik','Bukti','Revisi']:['合作方类型','合作方','样品单','出库单','归属','费用类型','费用日期','原币种','原币金额','人民币汇率','人民币金额','凭据唯一行号','凭据','修订版本'];
 const data=summary.lines.map(l=>[l.party_type==='mcn'?'MCN':(id?'Kreator':'达人'),l.counterparty||'',l.order_no,l.shipment_no,id?'Operasional TikTok Indonesia':l.costCenter,l.kind==='sample'?(id?'Biaya sampel':'样品成本'):(id?'Ongkos kirim sampel':'寄样运费'),l.business_date,l.currency,l.amount_minor/100,l.rate??(id?'Belum diverifikasi':'待核汇率'),l.cnyMinor==null?(id?'Belum diverifikasi':'待核汇率'):l.cnyMinor/100,l.source_ref,l.evidence,l.revision]);
 return '\ufeff'+[headers,...data].map(row=>row.map(cell).join(',')).join('\r\n');
}
