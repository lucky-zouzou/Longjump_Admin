import { ConflictError } from './atomic.mjs';
import { InquiryError, inquiryHash } from './website-inquiry-auth.mjs';
import { distributorApplicationSource, receiveWebsiteInquiry } from './website-leads.mjs';

const path = '/distributor/apply';
const channels = ['TikTok', 'Instagram', 'Shopee', 'YouTube', 'Facebook', 'Lainnya'];
const headers = {
  'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store', 'Referrer-Policy':'same-origin',
  'X-Content-Type-Options':'nosniff', 'X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};
const escape = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function form(values, error) {
  const get = key => escape(values.get(key));
  return `<form method="post" action="${path}">
    <h2>Daftar sebagai mitra</h2>
    ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
    <label>Nama lengkap<input name="name" autocomplete="name" maxlength="100" required value="${get('name')}"></label>
    <div class="pair"><label>WhatsApp<input name="phone" type="tel" autocomplete="tel" placeholder="08… atau +62…" maxlength="30" required value="${get('phone')}"></label>
    <label>Kota di Indonesia<input name="city" autocomplete="address-level2" maxlength="100" required value="${get('city')}"></label></div>
    <div class="pair"><label>Platform utama<select required name="channel"><option value="">Pilih platform</option>${channels.map(c=>`<option${values.get('channel')===c?' selected':''}>${c}</option>`).join('')}</select></label>
    <label>Nama akun atau toko<input name="account" maxlength="100" required placeholder="@akun Anda" value="${get('account')}"></label></div>
    <div hidden aria-hidden="true"><label>Situs Anda<input name="website" tabindex="-1" autocomplete="off"></label></div>
    <label class="consent"><input type="checkbox" name="consent" value="yes" required${values.get('consent')==='yes'?' checked':''}>Saya bersedia dihubungi melalui WhatsApp untuk verifikasi dan tindak lanjut pendaftaran.</label>
    <button type="submit">Kirim pendaftaran <span aria-hidden="true">→</span></button>
  </form>`;
}

function page(request, {values=new URLSearchParams(), error='', received=false, status=200}={}) {
  const content = received
    ? '<section class="received" role="status"><span class="check" aria-hidden="true">✓</span><h2>Pendaftaran diterima</h2><p>Tim LOONG JUMP akan menghubungi Anda melalui WhatsApp untuk memeriksa akun dan melengkapi data pengiriman. Setelah disetujui, sales Anda akan mengirim tautan pemesanan pribadi.</p></section>'
    : form(values,error);
  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Daftar mitra penjualan · LOONG JUMP</title><link rel="stylesheet" href="/distributor-assets/application.css"></head>
    <body><header><img src="/loong-jump-logo-black.png" alt="LOONG JUMP"><span>Indonesia</span></header>
    <main><div class="intro"><h1>Jadi mitra <br>LOONG JUMP<span>.</span></h1>
    <p>Jual koleksi tas LOONG JUMP melalui konten, siaran langsung, atau toko Anda.</p>
    <ol><li><strong>Kirim profil Anda</strong><small>Cantumkan akun jualan dan WhatsApp aktif.</small></li>
    <li><strong>Verifikasi bersama sales</strong><small>Tim kami akan mengonfirmasi profil dan alamat pengiriman.</small></li>
    <li><strong>Pesan dari katalog grosir</strong><small>Gunakan tautan pribadi untuk melihat produk, harga, dan stok.</small></li></ol></div>${content}</main></body></html>`;
  return new Response(request.method==='HEAD'?null:html,{status,headers});
}

async function readForm(request) {
  const limit=8*1024;
  if(Number(request.headers.get('content-length'))>limit) throw new InquiryError(413,'Formulir terlalu besar.');
  const reader=request.body?.getReader(), decoder=new TextDecoder();
  if(!reader) throw new InquiryError(400,'Lengkapi formulir terlebih dahulu.');
  let raw='',size=0;
  for (;;) {
    const {done,value}=await reader.read();
    if(done) break;
    size+=value.byteLength;
    if(size>limit){await reader.cancel();throw new InquiryError(413,'Formulir terlalu besar.');}
    raw+=decoder.decode(value,{stream:true});
  }
  return new URLSearchParams(raw+decoder.decode());
}

function input(values,key,max,label) {
  const v=(values.get(key)||'').trim();
  if(!v || v.length>max || /[\x00-\x1f\x7f]/u.test(v)) throw new InquiryError(400,`Periksa isian ${label}.`);
  return v;
}

async function submit(db,values) {
  const name=input(values,'name',100,'nama lengkap'), city=input(values,'city',100,'kota');
  const rawPhone=input(values,'phone',30,'WhatsApp').replace(/[\s()-]/g,'');
  const phone=rawPhone.replace(/^(?:\+?62|0)/,'+62');
  if(!/^\+628\d{7,11}$/.test(phone)) throw new InquiryError(400,'Masukkan nomor WhatsApp Indonesia yang aktif (08… atau +62…).');
  const channel=values.get('channel'), account=input(values,'account',100,'nama akun atau toko');
  if(!channels.includes(channel)) throw new InquiryError(400,'Pilih platform utama.');
  if(values.get('consent')!=='yes') throw new InquiryError(400,'Konfirmasikan bahwa Anda bersedia dihubungi.');
  const normalizedAccount=account.normalize('NFKC').replace(/^@+/,'').trim().toLowerCase().replace(/\s+/g,' ');
  if(!normalizedAccount) throw new InquiryError(400,'Isi nama akun atau toko.');
  const externalId='MITRA-'+(await inquiryHash(JSON.stringify([phone,channel,normalizedAccount]))).slice(0,32);
  const find=()=>db.prepare('SELECT id FROM website_leads WHERE source=? AND external_id=?').bind(distributorApplicationSource,externalId).first();
  // A public retry may acknowledge the application, but cannot overwrite a profile under review.
  if(await find()) return;
  const now=new Date().toISOString();
  try {
    await receiveWebsiteInquiry(db,{
      schemaVersion:1, source:distributorApplicationSource, externalId, revision:1, createdAt:now, updatedAt:now,
      details:{topic:'Grosir',name,contactType:'WhatsApp',contact:phone,country:'ID',city,buyerType:'Mitra penjualan',
        customFields:{Platform:channel,Akun:account,'Persetujuan WhatsApp':'Ya'}}
    },distributorApplicationSource);
  } catch (err) {
    if(await find()) return;
    if(String(err).includes('distributor_application_limit')) throw new InquiryError(429,'Banyak pendaftaran sedang diproses. Coba lagi nanti.');
    throw err;
  }
}

export async function handleDistributorApplication(request,db) {
  const url=new URL(request.url);
  if(['GET','HEAD'].includes(request.method)) return page(request,{received:url.searchParams.get('received')==='1'});
  if(request.method!=='POST') return new Response(null,{status:405,headers:{...headers,Allow:'GET, HEAD, POST'}});
  if(request.headers.get('origin')!==url.origin) return page(request,{status:403,error:'Buka halaman pendaftaran dan kirim kembali.'});
  if(request.headers.get('content-type')?.split(';')[0]!=='application/x-www-form-urlencoded') return page(request,{status:415,error:'Gunakan formulir pendaftaran.'});
  let values=new URLSearchParams();
  try {
    values=await readForm(request);
    if(!values.get('website')) await submit(db,values);
    return new Response(null,{status:303,headers:{...headers,Location:path+'?received=1'}});
  } catch(err) {
    if(err instanceof InquiryError) return page(request,{values,status:err.status,error:err.message});
    if(!(err instanceof ConflictError)) console.error('Distributor registration failed',err.name);
    return page(request,{values,status:503,error:'Pendaftaran belum tersimpan. Silakan coba lagi nanti.'});
  }
}
