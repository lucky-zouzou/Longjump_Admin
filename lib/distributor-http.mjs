import {partnerHeader,partnerBenefits,partnerFooter,chatIcon} from './distributor-brand.mjs';
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
<title>Ruang Mitra · LOONG JUMP</title><link rel="stylesheet" href="/distributor-assets/brand.css?v=3"><link rel="stylesheet" href="/distributor-assets/ordering.css?v=8"><script defer src="/distributor-assets/ordering.js?v=6"></script><script defer src="/distributor-assets/service.js?v=2"></script><script defer src="/distributor-assets/payment.js?v=2"></script></head>
<body class="portal-guest">${partnerHeader()}<main>
<div class="entry-layout" id="welcome-entry"><div class="brand-story"><p class="eyebrow"><span></span> SELAMAT DATANG, PARTNER!</p>
<h1>Bisnis Anda.<br>Langkah besar <em>bersama.</em></h1><p class="story-copy">Senang menyambut Anda di keluarga LOONG JUMP. Dari koleksi pertama hingga pesanan berikutnya, kami siap tumbuh bersama Anda.</p>
<div class="brand-gallery" aria-label="Koleksi tas LOONG JUMP"><figure class="hero-bag hero-bag-green"><img src="/distributor-assets/partner-green.webp" alt="Tas LOONG JUMP warna hijau" width="560" height="560"><figcaption>Dirancang untuk keseharian.</figcaption></figure><figure class="hero-bag hero-bag-pink"><img src="/distributor-assets/partner-pink.webp" alt="Tas LOONG JUMP warna merah muda" width="560" height="560"><figcaption>Siap jadi pilihan pelanggan.</figcaption></figure><span class="gallery-note">Mulai dari <b>1 pcs</b><small>harga grosir</small></span></div></div>
<section id="portal-access" hidden><span class="access-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M20 9c0 5-8 10-8 10S4 14 4 9a4 4 0 0 1 8-1 4 4 0 0 1 8 1Z"/></svg></span><p class="eyebrow">RUANG PARTNER ANDA</p><h2>Selamat datang!</h2><p class="access-copy">Masuk dan siapkan langkah berikutnya untuk toko Anda.</p>
<p id="login-notice" class="login-notice" role="status" aria-live="polite"></p><form id="store-login"><label>Akun toko<input name="username" placeholder="Akun toko Anda" required autocomplete="username" maxlength="60"></label><label>Kata sandi<input name="password" placeholder="Masukkan kata sandi" type="password" required minlength="12" maxlength="128" autocomplete="current-password"></label><button type="submit">Masuk ke toko <span aria-hidden="true">→</span></button></form>
<p id="activation-note">Lupa kata sandi? Hubungi sales yang mengirim undangan Anda untuk tautan aktivasi baru.</p><div class="join-note"><span>Belum bergabung?</span><a href="/distributor/apply">Daftar jadi partner <span aria-hidden="true">↗</span></a><small>Isi profil usaha. Tim kami akan meninjau pendaftaran Anda.</small></div></section></div>
<p id="notice" role="status" aria-live="polite">Menyiapkan ruang mitra Anda…</p><noscript>Aktifkan JavaScript untuk masuk dan memesan.</noscript>
${partnerBenefits}
<div id="workspace" hidden><div class="workspace-welcome"><div><p class="eyebrow">PARTNER SPACE / TOKO ANDA</p><h1>Senang bertemu Anda lagi<span>!</span></h1><p>Pilih produk, kelola pesanan, dan tumbuhkan toko Anda bersama kami.</p></div><a href="#catalog" class="text-action">Lihat koleksi <span aria-hidden="true">↓</span></a></div>
<div class="partner-overview"><section class="identity"><div><small>MITRA LOONG JUMP</small><h2 id="customer"></h2><p id="sales"></p></div><div class="delivery-address"><small>Alamat pengiriman</small><p id="address"></p></div></section>
<aside class="sales-card" aria-labelledby="sales-card-title"><span class="sales-avatar" aria-hidden="true">${chatIcon}</span><div><small>ADA YANG BISA KAMI BANTU?</small><h2 id="sales-card-title">Sales partner Anda</h2><p id="sales-contact-note">Hubungi sales untuk bantuan produk dan pesanan.</p></div><a id="sales-whatsapp" class="whatsapp-button" hidden target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${chatIcon} Chat via WhatsApp <span aria-hidden="true">↗</span></a><p id="sales-unavailable" class="sales-unavailable" hidden>Kontak WhatsApp sedang dilengkapi. Silakan gunakan kontak sales yang mengirim undangan Anda.</p></aside></div>
<nav class="workspace-shortcuts" aria-label="Akses cepat"><a href="#catalog"><span aria-hidden="true">▦</span>Katalog &amp; stok</a><button type="button" data-desk="payment-desk"><span aria-hidden="true">↗</span>Bukti pembayaran</button><button type="button" data-desk="service-desk"><span aria-hidden="true">♡</span>Retur &amp; bantuan</button><a href="#order-history"><span aria-hidden="true">◷</span>Pesanan saya</a></nav>
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
<div class="columns"><section id="catalog"><div class="section-heading"><div><p class="eyebrow">PILIHAN UNTUK TOKO ANDA</p><h2>Katalog produk</h2></div><span class="catalog-tag">Harga grosir mulai 1 pcs</span></div><label for="search">Cari SKU, nama, atau bahan</label><input id="search" type="search" autocomplete="off"><div id="products"></div>
<nav id="catalog-pages" aria-label="Halaman katalog" hidden><button type="button" id="prev">Sebelumnya</button><span id="page-number"></span><button type="button" id="next">Berikutnya</button></nav></section>
<section class="cart"><h2>Pesanan Anda</h2><div id="selection"></div><div class="total"><strong>Total</strong><strong id="total">Rp0</strong></div>
<p>Pembayaran sebelum pengiriman. Tim keuangan akan memeriksa pesanan dan mengonfirmasi ketersediaan stok.</p>
<button id="submit" disabled>Kirim pesanan</button></section></div>
<section id="order-history"><div class="history-title"><h2>Pesanan terakhir</h2><button id="refresh">Muat ulang</button></div><div id="history"></div></section></div>
<dialog id="product-dialog" aria-labelledby="detail-title"><div class="detail-head"><div><small id="detail-sku"></small><h2 id="detail-title"></h2></div><button type="button" id="close-detail" aria-label="Tutup detail produk">Tutup</button></div>
<div class="detail-layout"><div><div id="detail-photo" class="photo-frame"></div><div id="photo-nav" hidden><button type="button" id="prev-photo" aria-label="Foto sebelumnya">‹</button><span id="photo-count"></span><button type="button" id="next-photo" aria-label="Foto berikutnya">›</button></div></div>
<div><div id="detail-price"></div><button type="button" id="download-photo">Unduh foto produk</button><dl id="detail-specs"></dl><p id="detail-points"></p></div></div></dialog>
</main>${partnerFooter}<a id="floating-sales" class="floating-sales" hidden target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${chatIcon}<span>Tanya sales Anda</span><span aria-hidden="true">↗</span></a></body></html>`;

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
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'"}});
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
