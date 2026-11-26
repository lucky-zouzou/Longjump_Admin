'use client';
import DistributionFlowSummary from './distribution-flow-summary';
import {domesticStage,wholesaleFollowup} from '../lib/distribution-workflow-view.mjs';
import {marketingSampleStatus} from '../lib/marketing-samples-i18n.mjs';
type Row=Record<string,any>;
type Tr=(zh:string,id:string)=>string;
const quantity=(items:Row[],key:string)=>items.reduce((n,i)=>n+Number(i[key]||0),0);
const domesticNext:Record<string,[string,string,string,string]>={
 quote:['确认客户报价','Konfirmasi penawaran pelanggan','供应链','Rantai pasok'],contract:['补齐合同与结算条款','Lengkapi kontrak dan termin','供应链','Rantai pasok'],review:['审核签约与放货约定','Tinjau kontrak dan syarat pengiriman','管理员 / 财务','Admin / keuangan'],pack:['按合同备货打包','Siapkan barang sesuai kontrak','工厂','Pabrik'],release:['核对到账及放货条件','Verifikasi dana dan izin pengiriman','财务','Keuangan'],ship:['登记本批实际发货','Catat pengiriman aktual','工厂 / 供应链','Pabrik / rantai pasok'],receive:['跟进客户签收','Tindak lanjuti penerimaan pelanggan','供应链','Rantai pasok'],collection:['已交付，继续跟进回款','Terkirim, lanjutkan penagihan','供应链跟进 · 财务核销','Rantai pasok menindaklanjuti · keuangan merekonsiliasi'],consignment:['核对客户余货与实际售出','Rekonsiliasi sisa barang dan penjualan','供应链跟进 · 财务核销','Rantai pasok menindaklanjuti · keuangan merekonsiliasi'],refund:['核对待退款余额','Periksa saldo pengembalian','财务','Keuangan'],delivered:['已完成实物交付','Pengiriman barang selesai','保留单据追溯','Simpan riwayat dokumen'],cancelled:['订单已取消','Pesanan dibatalkan','核对退款及原始记录','Periksa pengembalian dan riwayat'],
};
export function DomesticProgress({o,data,tr}:{o:Row;data:Row;tr:Tr}){
 const stage=domesticStage(o),next=domesticNext[stage],f=o.fulfillment,financial=o.financial,factory=data.actor.role==='工厂',approved=o.status==='approved',cancelled=o.status==='cancelled',total=f.total;
 const money=(v:number)=>'¥'+(v/100).toLocaleString('zh-CN',{minimumFractionDigits:2});
 const unapproved=['draft','quoted','contract_pending','rejected'].includes(o.status);
 const financeStatus=unapproved?tr('合同未生效','Kontrak belum berlaku'):financial?.refundDueMinor>0?tr('待退款','Menunggu pengembalian'):financial?.unsettledConsignmentQty>0?tr('寄卖待对账','Konsinyasi menunggu rekonsiliasi'):financial?.contractOutstandingMinor>0?tr('待回款','Menunggu pembayaran'):tr('当前待收已核销','Tagihan saat ini telah dilunasi');
 return <DistributionFlowSummary title={tr(next[0],next[1])} subtitle={tr('接棒岗位：','Penanggung jawab berikutnya: ')+tr(next[2],next[3])} steps={[
  {label:tr('客户报价','Penawaran'),done:!cancelled&&['quoted','contract_pending','approved'].includes(o.status),current:stage==='quote'},
  {label:tr('合同确认','Kontrak'),done:!cancelled&&['contract_pending','approved'].includes(o.status),current:stage==='contract'},
  {label:tr('独立审核','Persetujuan'),done:approved,current:stage==='review'},
  {label:tr('工厂打包','Pengemasan'),done:approved&&f.packed===total,current:stage==='pack'},
  {label:tr('实际发货','Pengiriman'),done:approved&&f.shipped===total,current:stage==='ship'||stage==='release'},
  {label:tr('客户签收','Penerimaan'),done:approved&&f.received===total,current:stage==='receive'},
 ]} tracks={[
  {label:tr('实物进度','Barang'),value:`${f.shipped} / ${total} `+tr('件已发','unit terkirim'),note:`${f.received} `+tr('件已签收；分批发货逐批确认','unit diterima; konfirmasi setiap kiriman')},
  {label:tr('放货条件','Syarat pengiriman'),value:approved&&f.shipped===total?tr('已无待发余量','Tidak ada sisa pengiriman'):o.canShip?tr('已满足，可按实物发货','Terpenuhi, siap kirim'):tr('尚未满足','Belum terpenuhi'),note:tr('打包可先准备，实际出库前再次核验','Barang boleh disiapkan; periksa izin lagi sebelum kirim')},
  factory?{label:tr('岗位职责','Tanggung jawab'),value:tr('备货 · 打包 · 实发','Persiapan · kemas · kirim'),note:tr('收款由财务核实，工厂不代确认','Penerimaan dana diverifikasi oleh keuangan')}:{label:tr('资金进度','Pembayaran'),value:financial?.overdue?tr('已逾期 · ','Terlambat · ')+financeStatus:financeStatus,warning:financial?.overdue,note:unapproved?tr('报价参考 ','Referensi penawaran ')+money(o.total_minor||0)+(financial?.paidMinor>0?tr(' · 实际净回款 ',' · Penerimaan aktual ')+money(financial.paidMinor):''):financial?.unsettledConsignmentQty>0?`${financial.unsettledConsignmentQty} `+tr('件已发未结算','unit terkirim belum diselesaikan'):tr('待回款 ','Belum diterima ')+money(financial?.contractOutstandingMinor||0)},
 ]}/>;
}
export function WholesaleProgress({o,data,tr}:{o:Row;data:Row;tr:Tr}){
 const w=o.workflow,f=wholesaleFollowup(o),items=o.items||[],shipped=quantity(items,'shipped_qty'),remaining=items.reduce((n:number,i:Row)=>n+Math.max(0,i.qty-(i.cancelled_qty||0)-i.shipped_qty),0),phase=w.phase;
 const steps=[['supply_review','供应链审核','Pemeriksaan'],['customer_confirm','客户确认','Konfirmasi'],['release_pending','正式放货','Izin kirim'],['warehouse_assign','物流派仓','Penugasan'],['packing','打包与发货','Kemas & kirim'],['receipt','客户签收','Penerimaan']];
 const unconfirmed=!o.approved_at||!w.customerConfirmedAt, money=(v:number)=>Number(v||0).toLocaleString(tr('zh-CN','id-ID'));
 const names=(id:string,fallback:string)=>(data.users||[]).find((u:Row)=>u.id===id)?.name||fallback;
 const owner=phase==='supply_review'?tr('供应链','Rantai pasok'):phase==='customer_confirm'?names(o.service_user_id||o.sales_user_id,tr('责任销售','Sales')):phase==='release_pending'?tr('财务 / 获授权放货人员','Keuangan / petugas izin kirim'):phase==='warehouse_assign'?names(w.logisticsUserId,tr('物流负责人','Logistik')):['packing','shipping'].includes(phase)?names(w.warehouseUserId,tr('仓库执行人','Gudang')):names(o.service_user_id||o.sales_user_id,tr('责任销售','Sales'));
 const label=steps.find(s=>s[0]===phase);
 const title=phase==='shipping'?tr('核对照片与运单，登记实际出库','Periksa foto dan resi, catat pengiriman'):phase==='rejected'?tr('已退回销售，修改后重新送审','Dikembalikan ke sales untuk revisi'):phase==='cancelled'?tr('订单已取消，保留原记录','Pesanan dibatalkan; riwayat disimpan'):['completed','closed'].includes(phase)?f.receiptPending?tr('已发货，等待销售确认签收','Terkirim, menunggu konfirmasi sales'):f.unsold?tr('物流已收尾，寄卖继续对账','Pengiriman selesai, lanjutkan rekonsiliasi konsinyasi'):o.outstanding>0?tr('已交付、待回款','Diterima, pembayaran belum lunas'):o.refundDue>0?tr('核对待退款余额','Periksa saldo pengembalian'):shipped>0?tr('实物与当前结算已完成','Pengiriman dan penyelesaian saat ini selesai'):tr('订单已关闭，未实际发货','Pesanan ditutup tanpa pengiriman'):label?tr(label[1],label[2]):tr('订单进度','Status pesanan');
 return <DistributionFlowSummary title={title} subtitle={tr('接棒负责人：','Penanggung jawab berikutnya: ')+owner} steps={steps.map(([key,z,i],index)=>({label:tr(z,i),current:phase===key||phase==='shipping'&&key==='packing'||key==='receipt'&&f.receiptPending>0,done:!['rejected','cancelled'].includes(phase)&&[Boolean(o.approved_at),Boolean(w.customerConfirmedAt),w.releaseValid===true||shipped>0&&Boolean(w.releaseInstruction),Boolean(w.warehouseUserId),shipped>0&&remaining===0,shipped>0&&remaining===0&&f.receiptPending===0][index]}))} tracks={[
  {label:tr('实物履约','Barang'),value:`${shipped} `+tr('件已发','unit terkirim'),note:`${remaining} `+tr('件待发','unit belum dikirim')+` · ${f.receiptPending} `+tr('批待确认签收','kiriman menunggu konfirmasi')},
  {label:tr('财务结算','Pembayaran'),value:unconfirmed?tr('待确认结算约定','Syarat pembayaran belum dikonfirmasi'):f.overdue?tr('已逾期，待跟进','Terlambat, perlu tindak lanjut'):f.unsold?tr('寄卖仍待对账','Konsinyasi belum direkonsiliasi'):o.outstanding>0?tr('尚有待回款','Masih ada tagihan'):o.refundDue>0?tr('待退款','Menunggu pengembalian'):tr('当前无待收款','Tidak ada tagihan saat ini'),warning:f.overdue,note:unconfirmed?tr('审核与客户确认后按约定跟进，不代表已出库应收','Tindak lanjuti setelah persetujuan dan konfirmasi; bukan piutang pengiriman'):f.unsold?`${f.unsold} `+tr('件客户余货待核对','unit sisa pelanggan perlu diperiksa'):tr('待回款 IDR ','Tagihan IDR ')+money(o.outstanding)},
  {label:tr('出库依据','Dasar pengiriman'),value:shipped>0&&remaining===0?tr('本单发货已完成','Pengiriman pesanan selesai'):w.releaseValid?tr('正式指令有效','Instruksi resmi berlaku'):tr('尚不可凭单放货','Belum boleh melepas barang'),note:w.releaseInstruction&&(w.releaseValid||shipped>0&&remaining===0)?w.releaseInstruction.no:tr('付款截图不等于到账；按结算约定核验','Bukti transfer bukan penerimaan bank; verifikasi syarat pembayaran')},
 ]}/>;
}
export function SampleProgress({o,data,language,tr}:{o:Row;data:Row;language:string;tr:Tr}){
 const shipped=quantity(o.items,'shipped_qty'),remaining=quantity(o.items,'qty')-shipped-quantity(o.items,'released_qty'),received=(o.shipments||[]).filter((s:Row)=>s.receipt).length,pending=(o.shipments||[]).length-received,work=o.workKinds||[];
 const next:Record<string,[string,string]>={review:['核对 SKU、数量与库存','Periksa SKU, jumlah dan stok'],assign:['指定仓库与执行账号','Tugaskan gudang dan pelaksana'],ship:['打包拍照，登记实发','Foto kemasan, catat pengiriman'],receipt:['核实达人实际签收','Verifikasi penerimaan kreator'],cost:['分列核对样品成本与运费','Verifikasi biaya sampel dan ongkos kirim'],content:['继续跟进视频 / 直播交付','Lanjutkan tindak lanjut video / siaran']};
 const active=work.find((k:string)=>next[k]),terminal=['rejected','cancelled'].includes(o.status);
 return <DistributionFlowSummary title={active?tr(...next[active]):tr('样品进度，一眼看清','Status sampel dalam satu tampilan')} subtitle={active?tr('这是当前需要你处理的事项','Ini tindakan yang perlu Anda tangani sekarang'):tr('物流、内容和费用独立跟进，不用互相等结单','Pengiriman, konten dan biaya ditindaklanjuti secara terpisah')} steps={[
  {label:tr('协议 / 申请','Perjanjian'),done:true},
  {label:tr('审核锁库','Reservasi stok'),done:!terminal&&o.status!=='pending',current:o.status==='pending'},
  {label:tr('物流派仓','Penugasan gudang'),done:!terminal&&Boolean(o.warehouse_user_id),current:o.status==='approved'},
  {label:tr('实际寄出','Dikirim'),done:shipped>0&&remaining===0,current:!terminal&&remaining>0&&Boolean(o.warehouse_user_id)},
  {label:tr('BD 确认签收','Penerimaan BD'),done:shipped>0&&remaining===0&&pending===0,current:pending>0},
 ]} tracks={[
  {label:tr('样品物流','Pengiriman sampel'),value:`${shipped} `+tr('件已发','unit terkirim'),note:`${remaining} `+tr('件待发','unit tersisa')+` · ${pending} `+tr('批待签收','kiriman belum diterima')},
  {label:tr('合作内容','Konten'),value:marketingSampleStatus(language,o.contentStatus||'unknown','content'),note:tr('样品签收不会自动完成视频 / 直播承诺','Penerimaan sampel tidak menyelesaikan janji konten')},
  data.canFinance?{label:tr('成本与运费','Biaya dan ongkos kirim'),value:o.costStatus==='confirmed'?tr('两类费用已核对','Kedua biaya diverifikasi'):tr('费用待核实','Biaya belum diverifikasi'),note:tr('按实际出库数量，不计销售收入或应收','Berdasarkan pengiriman aktual, tanpa penjualan atau piutang')}:{label:tr('费用归属','Pusat biaya'),value:tr('印尼 TikTok 运营','Operasional TikTok Indonesia'),note:tr('样品成本、运费由财务分列核对','Keuangan memverifikasi biaya sampel dan ongkos kirim terpisah')},
 ]}>{work.includes('content')&&<a className="btn" href={`/?page=creators&entity=${encodeURIComponent(o.creator_id)}`}>{tr('去跟进内容','Tindak lanjuti konten')} ↗</a>}</DistributionFlowSummary>;
}
