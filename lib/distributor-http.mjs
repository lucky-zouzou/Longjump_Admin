import {authenticateDistributor,distributorSession,sessionCookie,cookieToken,distHash,DistributorError} from './distributor-accounts.mjs';
import {distributorPayments,submitDistributorPayment} from './distributor-payments.mjs';
import {distributorServiceDesk,submitDistributorService,serviceForm} from './distributor-service.mjs';
import {distributorIdentity,distributorImage,distributorWorkspace,submitDistributorOrder} from './distributor-ordering.mjs';
import {WholesaleError} from './wholesale.mjs';
import {ConflictError} from './atomic.mjs';

const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'};
const json=(value,status=200)=>Response.json(value,{headers,status});
const page=`<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pesanan grosir · LOONG JUMP</title><link rel="stylesheet" href="/distributor-assets/ordering.css?v=5"><script defer src="/distributor-assets/ordering.js?v=5"></script><script defer src="/distributor-assets/service.js?v=2"></script><script defer src="/distributor-assets/payment.js?v=2"></script></head>
<body><header><b>LOONG JUMP · MITRA</b><button id="logout" type="button" hidden>Keluar</button><a class="apply-link" href="/distributor/apply">Daftar jadi mitra</a></header><main><h1>Ruang usaha Anda</h1><p>Katalog, stok, pesanan, bukti pembayaran, dan layanan purnajual dalam satu tempat.</p>
<p id="notice" role="status" aria-live="polite">Memuat data pelanggan…</p><noscript>Aktifkan JavaScript untuk memesan.</noscript>
<section id="portal-access" hidden><h2>Masuk ke toko Anda</h2><form id="store-login"><label>Akun toko<input name="username" required autocomplete="username" maxlength="60"></label><label>Kata sandi<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="current-password"></label><button type="submit">Masuk</button></form><p id="activation-note">Belum punya akun? <a href="/distributor/apply">Daftar menjadi mitra</a>. Lupa kata sandi? Hubungi tim LOONG JUMP untuk tautan aktivasi baru.</p></section>
<div id="workspace" hidden><section class="identity"><div><h2 id="customer"></h2><p id="sales"></p></div><div><small>Kirim ke</small><p id="address"></p></div></section>
<details id="service-desk"><summary>Retur, tukar barang &amp; status pengajuan</summary>
<p>Pilih barang yang sudah dikirim. Anda dapat mengajukan pengembalian dana atau penukaran dengan SKU yang sama.</p>
<button type="button" id="service-refresh">Perbarui status</button><p id="service-message" role="status" aria-live="polite"></p>
<form id="service-form" hidden><fieldset><label>Pesanan dan barang<select name="item" required></select></label>
<label>Jenis pengajuan<select name="kind"><option value="return">Retur dan pengembalian dana</option><option value="exchange">Tukar dengan SKU yang sama</option></select></label>
<label>Jumlah unit<input name="qty" type="number" min="1" step="1" required value="1"></label>
<label>Alasan<select name="reason"><option value="quality">Masalah kualitas produk</option><option value="wrong">Salah kirim</option><option value="description">Tidak sesuai deskripsi</option><option value="unwanted">Tidak jadi digunakan</option><option value="other">Lainnya</option></select></label>
<label>Jelaskan masalah<textarea name="description" required minlength="4" maxlength="2000" rows="3"></textarea></label>
<label>Foto atau video produk<input name="evidence" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" multiple required></label>
<small>1–3 berkas JPG, PNG, WebP, MP4, MOV atau WebM. Maks. 18 MB per berkas, total 20 MB termasuk formulir.</small>
<button type="submit">Kirim pengajuan</button></fieldset></form><h3>Riwayat pengajuan</h3><div id="service-history"></div></details>
<details id="payment-desk"><summary>Pembayaran &amp; unggah bukti transfer</summary><p>Bukti yang Anda unggah akan diperiksa oleh tim keuangan. Unggahan bukan konfirmasi dana diterima.</p><p id="payment-message" role="status"></p><form id="payment-form"><label>Pesanan<select name="orderNo" required></select></label><label>Jumlah transfer (IDR)<input name="amount" type="number" min="1" step="1" required></label><label>Nomor referensi bank<input name="reference" maxlength="160" required></label><label>Tanggal transfer<input name="businessDate" type="date" required></label><label>Foto atau PDF bukti transfer (maks. 10 MB)<input name="evidence" type="file" accept="image/jpeg,image/png,image/webp,application/pdf" required></label><button>Kirim bukti untuk diperiksa</button></form><div id="payment-history"></div></details>
<div class="columns"><section><h2>Katalog produk</h2><label for="search">Cari SKU, nama, atau bahan</label><input id="search" type="search" autocomplete="off"><div id="products"></div>
<nav id="catalog-pages" aria-label="Halaman katalog" hidden><button type="button" id="prev">Sebelumnya</button><span id="page-number"></span><button type="button" id="next">Berikutnya</button></nav></section>
<section class="cart"><h2>Pesanan Anda</h2><div id="selection"></div><div class="total"><strong>Total</strong><strong id="total">Rp0</strong></div>
<p>Pembayaran sebelum pengiriman. Tim keuangan akan memeriksa pesanan dan mengonfirmasi ketersediaan stok.</p>
<button id="submit" disabled>Kirim pesanan</button></section></div>
<section><div class="history-title"><h2>Pesanan terakhir</h2><button id="refresh">Muat ulang</button></div><div id="history"></div></section></div>
<dialog id="product-dialog" aria-labelledby="detail-title"><div class="detail-head"><div><small id="detail-sku"></small><h2 id="detail-title"></h2></div><button type="button" id="close-detail" aria-label="Tutup detail produk">Tutup</button></div>
<div class="detail-layout"><div><div id="detail-photo" class="photo-frame"></div><div id="photo-nav" hidden><button type="button" id="prev-photo" aria-label="Foto sebelumnya">‹</button><span id="photo-count"></span><button type="button" id="next-photo" aria-label="Foto berikutnya">›</button></div></div>
<div><div id="detail-price"></div><button type="button" id="download-photo">Unduh foto produk</button><dl id="detail-specs"></dl><p id="detail-points"></p></div></div></dialog>
</main></body></html>`;

async function smallJson(request){
  const max=96*1024;
  if(Number(request.headers.get('content-length')||0)>max)throw new WholesaleError(413,'Pesanan terlalu besar.');
  const reader=request.body?.getReader();
  if(!reader)throw new WholesaleError(400,'Data pesanan kosong.');
  const decoder=new TextDecoder();let size=0,body='';
  for(;;){
    const {done,value}=await reader.read();if(done)break;
    size+=value.byteLength;
    if(size>max){await reader.cancel();throw new WholesaleError(413,'Pesanan terlalu besar.');}
    body+=decoder.decode(value,{stream:true});
  }
  try{return JSON.parse(body+decoder.decode());}catch{throw new WholesaleError(400,'Format pesanan tidak valid.');}
}

/** @param {Request} request @param {D1Database} db
 * @param {{get(key:string):Promise<{body:ReadableStream}|null>}} [bucket] */
export async function handleDistributor(request,db,bucket){
  const url=new URL(request.url);
  if(url.pathname==='/distributor'&&['GET','HEAD'].includes(request.method)){
    return new Response(request.method==='HEAD'?null:page,{headers:{...headers,'Content-Type':'text/html; charset=utf-8',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"}});
  }
  if(url.pathname!=='/api/distributor'||!['GET','POST'].includes(request.method))return json({error:'Metode tidak tersedia.'},405);
  try{
    if(request.method==='POST'&&(request.headers.get('origin')!==url.origin||request.headers.get('content-type')?.split(';')[0]!== ((url.searchParams.has('service')||url.searchParams.has('payment'))?'multipart/form-data':'application/json')))return json({error:'Permintaan tidak valid.'},403);
    if(request.method==='POST'&&url.searchParams.get('auth')==='login'){
      const auth=await authenticateDistributor(db,await smallJson(request));
      return Response.json({store:auth.store,username:auth.username},{headers:{...headers,'Set-Cookie':sessionCookie(request,auth.token)}});
    }
    if(request.method==='POST'&&url.searchParams.get('auth')==='logout'){
      const token=cookieToken(request);if(token)await db.prepare('DELETE FROM distributor_sessions WHERE token_hash=?').bind(await distHash(token)).run();
      return Response.json({ok:true},{headers:{...headers,'Set-Cookie':sessionCookie(request)}});
    }
    const identity=request.headers.get('authorization')?await distributorIdentity(db,request.headers.get('authorization')):await distributorSession(db,request);
    if(url.searchParams.has('payment'))return json(request.method==='GET'?await distributorPayments(db,identity):await submitDistributorPayment(db,bucket,identity,await serviceForm(request)));
    if(url.searchParams.has('service'))return json(request.method==='GET'?await distributorServiceDesk(db,identity):await submitDistributorService(db,bucket,identity,await serviceForm(request)));
    if(request.method==='GET'&&url.searchParams.has('photo')){
      const image=await distributorImage(db,bucket,url.searchParams.get('photo'));
      return new Response(image.body,{headers:{...headers,'Content-Type':image.type,'Content-Security-Policy':"default-src 'none'; sandbox"}});
    }
    if(request.method==='GET')return json(await distributorWorkspace(db,identity));
    return json(await submitDistributorOrder(db,identity,await smallJson(request)));
  }catch(error){
    if(error instanceof WholesaleError||error instanceof DistributorError){
      const message=/[\u3400-\u9fff]/u.test(error.message)?(error.status===400?'Periksa jumlah pesanan dan nilai total.':'Data berubah. Muat ulang dan periksa pesanan.'):error.message;
      return json({error:message},error.status);
    }
    if(error instanceof ConflictError && url.searchParams.has('service'))return json({error:'Data berubah atau layanan sedang sibuk. Muat ulang dan coba lagi.'},409);
    if(error instanceof ConflictError)return json({error:'Sistem sedang dalam pemeliharaan. Coba lagi nanti.'},503);
    console.error('Distributor request failed',error.name);
    return json({error:'Layanan belum tersedia. Coba lagi dengan pesanan yang sama.'},500);
  }
}
