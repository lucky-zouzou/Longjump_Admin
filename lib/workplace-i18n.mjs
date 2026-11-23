export function workplaceMessage(language,message){
 if(language!=='id')return message;
 const rules=[
 [/关账|期间|结算月份/,'Periode akuntansi sudah ditutup atau berubah. Minta keuangan meninjau periode; data belum disimpan.'],
 [/无权|权限|仅.*可|仅主管|独立|另一名|不能自审|自审/,'Akun ini tidak berwenang untuk tindakan tersebut. Persetujuan dan verifikasi harus dilakukan petugas berwenang yang berbeda.'],
 [/组织.*配置|未配置|尚未配置|请先由管理员/,'Profil, atasan, sif, atau cakupan belum diatur. Hubungi administrator.'],
 [/原组织/,'Sif ini berasal dari organisasi sebelumnya. Hubungi HR untuk pemeriksaan; catatan tidak dipindahkan ke organisasi baru.'],
 [/休息日/,'Ini hari libur dalam jadwal Anda. Hubungi HR jika perlu perubahan sif.'],
 [/先签到/,'Catat masuk dahulu sebelum pulang.'],
 [/上一班/,'Sif sebelumnya belum ditutup. Selesaikan catatan pulang terlebih dahulu.'],
 [/已完成该次打卡/,'Absensi ini sudah tercatat. Muat ulang untuk memeriksanya.'],
 [/打卡窗口/,'Di luar jendela absensi sif. Hubungi HR untuk verifikasi; jangan mengubah waktu.'],
 [/重叠/,'Sudah ada permohonan izin pada bagian sif yang sama.'],
 [/应付|余额|超过已批|分笔付款/,'Jumlah atau sumber utang belum sesuai. Periksa entitas, kanal, mata uang, dan saldo yang telah disetujui.'],
 [/银行流水或凭证|该文件已登记|同一凭据/,'Bukti atau referensi bank sudah tercatat. Gunakan catatan asli agar tidak membayar dua kali.'],
 [/私有.*存储|凭证存储/,'Penyimpanan bukti privat belum tersedia. Hubungi administrator.'],
 [/文件.*类型|文件内容|10MB|文件过大/,'Unggah PDF, PNG, atau JPEG yang valid, maksimal 10MB.'],
 [/广告申请/,'Permohonan iklan masih berupa usulan anggaran; belum dapat diproses sebagai utang atau pembayaran.'],
 [/海运负责人/,'Biaya pengiriman, gudang, dan langganan harus diajukan penanggung jawab logistik.'],
 [/薪资|税款/,'Detail gaji dan pajak belum dibuka pada tahap ini.'],
 [/版本|已变化|已经提交|已提交/,'Catatan berubah atau sudah dikirim. Muat ulang dan periksa sebelum mengirim lagi.'],
 [/来源.*法人|主体|组织.*不一致|来源归属/,'Cakupan entitas atau organisasi belum sesuai. Minta administrator memverifikasi sumber.'],
 [/日期|银行日/,'Periksa tanggal bisnis, penyelesaian, atau bank. Tanggal harus valid dan sesuai sumber.'],
 [/金额/,'Masukkan jumlah positif dengan maksimal dua angka desimal.'],
 [/备份|迁移/,'Sistem sedang melakukan pencadangan atau migrasi. Coba lagi nanti.']
 ];return rules.find(([re])=>re.test(message))?.[1]||'Tindakan belum selesai. Periksa isian wajib dan muat ulang; jangan kirim berulang. Hubungi administrator bila tetap gagal.';
}
