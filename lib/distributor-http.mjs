import {distributorServiceDesk,submitDistributorService,serviceForm} from './distributor-service.mjs';
import {distributorIdentity,distributorImage,distributorWorkspace,submitDistributorOrder} from './distributor-ordering.mjs';
import {WholesaleError} from './wholesale.mjs';
import {ConflictError} from './atomic.mjs';

const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'};
const json=(value,status=200)=>Response.json(value,{headers,status});
const page=`<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pesanan grosir · LOONG JUMP</title><link rel="stylesheet" href="/distributor-assets/ordering.css?v=3"><script defer src="/distributor-assets/ordering.js?v=4"></script><script defer src="/distributor-assets/service.js?v=1"></script></head>
<body><header><b>LOONG JUMP</b><a class="apply-link" href="/distributor/apply">Daftar jadi mitra</a></header><main><h1>Pesanan grosir</h1>
<p id="notice" role="status" aria-live="polite">Memuat data pelanggan…</p><noscript>Aktifkan JavaScript untuk memesan.</noscript>
<section id="portal-access" hidden><h2>Masuk dengan tautan pribadi</h2>
<form id="open-private-link"><label for="private-link">Tautan dari sales Anda</label><input id="private-link" type="url" required autocomplete="off" spellcheck="false">
<button type="submit">Buka katalog &amp; pesanan saya</button></form></section>
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
<div class="columns"><section><h2>Katalog produk</h2><label for="search">Cari SKU, nama, atau bahan</label><input id="search" type="search" autocomplete="off"><div id="products"></div>
<nav id="catalog-pages" aria-label="Halaman katalog" hidden><button type="button" id="prev">Sebelumnya</button><span id="page-number"></span><button type="button" id="next">Berikutnya</button></nav></section>
<section class="cart"><h2>Pesanan Anda</h2><div id="selection"></div><div class="total"><strong>Total</strong><strong id="total">Rp0</strong></div>
<p>Pembayaran sebelum pengiriman. Tim keuangan akan memeriksa pesanan dan mengonfirmasi ketersediaan stok.</p>
<button id="submit" disabled>Kirim pesanan</button></section></div>
<section><div class="history-title"><h2>Pesanan terakhir</h2><button id="refresh">Muat ulang</button></div><div id="history"></div></section></div>
<dialog id="product-dialog" aria-labelledby="detail-title"><div class="detail-head"><div><small id="detail-sku"></small><h2 id="detail-title"></h2></div><button type="button" id="close-detail" aria-label="Tutup detail produk">Tutup</button></div>
<div class="detail-layout"><div><div id="detail-photo" class="photo-frame"></div><div id="photo-nav" hidden><button type="button" id="prev-photo" aria-label="Foto sebelumnya">‹</button><span id="photo-count"></span><button type="button" id="next-photo" aria-label="Foto berikutnya">›</button></div></div>
<div><div id="detail-price"></div><dl id="detail-specs"></dl><p id="detail-points"></p></div></div></dialog>
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
    if(request.method==='POST'&&(request.headers.get('origin')!==url.origin||request.headers.get('content-type')?.split(';')[0]!== (url.searchParams.has('service')?'multipart/form-data':'application/json')))return json({error:'Permintaan tidak valid.'},403);
    const identity=await distributorIdentity(db,request.headers.get('authorization'));
    if(url.searchParams.has('service'))return json(request.method==='GET'?await distributorServiceDesk(db,identity):await submitDistributorService(db,bucket,identity,await serviceForm(request)));
    if(request.method==='GET'&&url.searchParams.has('photo')){
      const image=await distributorImage(db,bucket,url.searchParams.get('photo'));
      return new Response(image.body,{headers:{...headers,'Content-Type':image.type,'Content-Security-Policy':"default-src 'none'; sandbox"}});
    }
    if(request.method==='GET')return json(await distributorWorkspace(db,identity));
    return json(await submitDistributorOrder(db,identity,await smallJson(request)));
  }catch(error){
    if(error instanceof WholesaleError){
      const message=/[\u3400-\u9fff]/u.test(error.message)?(error.status===400?'Periksa jumlah pesanan dan nilai total.':'Data berubah. Muat ulang dan periksa pesanan.'):error.message;
      return json({error:message},error.status);
    }
    if(error instanceof ConflictError && url.searchParams.has('service'))return json({error:'Data berubah atau layanan sedang sibuk. Muat ulang dan coba lagi.'},409);
    if(error instanceof ConflictError)return json({error:'Sistem sedang dalam pemeliharaan. Coba lagi nanti.'},503);
    console.error('Distributor request failed',error.name);
    return json({error:'Layanan belum tersedia. Coba lagi dengan pesanan yang sama.'},500);
  }
}
