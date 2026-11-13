/* The capability lives only in the link fragment. Customer data is rendered as text. */
(async function () {
  const byId=id=>document.getElementById(id);
  const token=location.hash.slice(1);
  const notice=message=>{byId('notice').textContent=message;};
  const validToken=value=>/^[0-9a-f]{64}$/.test(value);
  const authHeaders=()=>validToken(token)?{Authorization:'Bearer '+token}:{};
  const store=new URLSearchParams(location.search).get('store');
  let initialWorkspace=null;
  const endpoint='/api/distributor'+(store?'?store='+encodeURIComponent(store):'');
  function loginView(){
    byId('portal-access').hidden=false;
    const activation=new URLSearchParams(location.hash.slice(1)),form=byId('store-login');
    if(activation.has('activate')){
      form.elements.username.value=activation.get('username')||'';
      form.elements.password.autocomplete='new-password';
      byId('activation-note').textContent='Aktifkan akun dengan membuat kata sandi 12–128 karakter. Tautan ini hanya berlaku sekali selama 48 jam.';
      form.querySelector('button').textContent='Aktifkan akun';
    }
    form.onsubmit=async event=>{
      event.preventDefault();form.querySelector('button').disabled=true;
      try{const r=await fetch('/api/distributor?auth=login',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:form.elements.username.value,password:form.elements.password.value,activation:activation.get('activate')||''})});
        const d=await r.json();if(!r.ok)throw Error(d.error);location.replace('/distributor?store='+encodeURIComponent(d.store));
      }catch(e){notice(e.message);}finally{form.querySelector('button').disabled=false;}
    };
  }
  if(!validToken(token)){
    if(location.hash.startsWith('#activate=')){notice('Selamat datang. Buat kata sandi untuk mengaktifkan toko Anda.');loginView();return;}
    const session=await fetch(endpoint,{credentials:'same-origin',cache:'no-store'}).catch(()=>null);
    if(session?.ok)initialWorkspace=await session.json();
    if(!session?.ok){notice(session?.status===403?'Tautan ini bukan milik akun Anda. Masuk dengan akun yang sesuai.':'Masuk untuk melihat stok dan pesanan toko Anda.');loginView();return;}
  }
  byId('logout').hidden=false;
  byId('logout').onclick=async()=>{const r=await fetch('/api/distributor?auth=logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}'});if(r.ok)location.replace('/distributor');else notice('Gagal keluar. Coba lagi.');};
  const format=new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0});
  const money=value=>format.format(value);
  const labels={pending:'Menunggu persetujuan',approved:'Disetujui',packing:'Sedang dikemas',partial:'Dikirim sebagian',completed:'Selesai dikirim',closed:'Ditutup',rejected:'Ditolak',cancelled:'Dibatalkan'};
  const entry=(tag,text)=>{const e=document.createElement(tag);e.textContent=text;return e;};
  const row=()=>{const e=document.createElement('div');e.className='line';return e;};
  const selection=new Map();
  let state,key,pending=null,busy=false;
  async function api(body){
    if(!body&&initialWorkspace){const value=initialWorkspace;initialWorkspace=null;return value;}
    const headers=authHeaders();
    if(body)headers['Content-Type']='application/json';
    const r=await fetch(endpoint,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers,body:body?JSON.stringify(body):undefined});
    const data=await r.json();
    if(!r.ok){const error=new Error(data.error||'Coba lagi nanti.');error.status=r.status;throw error;}
    return data;
  }
  function orderButton(){
    byId('submit').disabled=busy||(!selection.size&&!pending);
    byId('submit').textContent=busy?'Memproses…':pending?'Periksa / kirim kembali':'Kirim pesanan';
  }
  function showCart(){
    const box=byId('selection');box.replaceChildren();
    let total=0;
    for(const p of selection.values()){
      const line=row();line.append(entry('span',p.sku+' × '+p.qty),entry('strong',money(p.price*p.qty)));
      box.append(line);total+=p.price*p.qty;
    }
    if(!selection.size)box.append(entry('p','Pilih jumlah produk di katalog.'));
    byId('total').textContent=money(total);orderButton();
  }
  const words=new Map(Object.entries({
    '人造PU':'PU sintetis','黑色':'Hitam','棕色':'Cokelat','白色':'Putih','卡其':'Khaki','卡其色':'Khaki',
    '粉色':'Merah muda','灰色':'Abu-abu','绿色':'Hijau','酒红色':'Merah anggur','酒红':'Merah anggur',
    '蓝色':'Biru','深蓝色':'Biru tua','黄色':'Kuning','米白':'Putih gading','米白色':'Putih gading',
    '加小':'XS','中号':'M','小号':'S','大号':'L','中号均码':'M / satu ukuran',
    '月亮包':'Tas bulan sabit','龙耀系列布包':'Tas kain seri Long Yao','女士手提包':'Tas tangan wanita','女士斜挎包':'Tas selempang wanita','托特包':'Tas tote','背包':'Ransel'
  }));
  const display=value=>typeof value==='string'?value.split(/[~～]/).map(part=>words.get(part.trim())||(/[\u3400-\u9fff]/.test(part)?'Informasi produk sedang dilengkapi':part.trim())).join(' · '):value;
  const fields=[['dimensions','Dimensi produk','cm'],['material','Bahan'],['color','Warna'],['specification','Ukuran / varian'],
    ['netWeightKg','Berat bersih','kg'],['grossWeightKg','Berat kotor','kg'],['unitVolumeCbm','Volume per unit','m³'],
    ['cartonQty','Isi per karton','unit'],['cartonLengthCm','Panjang karton','cm'],['cartonWidthCm','Lebar karton','cm'],
    ['cartonHeightCm','Tinggi karton','cm'],['cartonVolumeCbm','Volume karton','m³']];
  function valueWithUnit(value,unit){
    if(value==null||value==='')return 'Belum tersedia';
    const text=typeof value==='number'?value.toLocaleString('id-ID',{maximumFractionDigits:10}):display(value);
    if(!unit)return text;
    if(unit==='cm'&&typeof text==='string'){
      const dimensions=text.replace(/(\d)\s*[*xX]\s*(?=\d)/g,'$1 × ');
      return /cm\s*$/i.test(dimensions)?dimensions:dimensions+' cm';
    }
    return text+' '+unit;
  }

  // img cannot send the link credential. Load only visible photos through an authenticated request.
  const thumbnails=new IntersectionObserver(entries=>{
    for(const {target,isIntersecting} of entries)if(isIntersecting){
      thumbnails.unobserve(target);
      loadPhoto(target,target.dataset.photo,target.dataset.alt,listLife.signal);
    }
  });
  let listLife=new AbortController(),photoLife=null,detailProduct=null,photoIndex=0,page=0;
  const pageSize=10;
  async function loadPhoto(host,id,alt,signal){
    host.textContent=id?'Memuat foto…':'Foto belum tersedia';
    if(!id)return;
    try{
      const response=await fetch('/api/distributor?photo='+encodeURIComponent(id),{
        headers:authHeaders(),signal,credentials:'same-origin',cache:'no-store'
      });
      if(!response.ok)throw Object.assign(new Error('Foto tidak tersedia.'),{status:response.status});
      const blob=await response.blob();
      if(signal.aborted)return;
      const url=URL.createObjectURL(blob),img=document.createElement('img');
      signal.addEventListener('abort',()=>URL.revokeObjectURL(url),{once:true});
      img.onerror=()=>{if(!signal.aborted)host.textContent='Foto tidak tersedia.';};
      img.alt=alt;img.src=url;host.replaceChildren(img);
    }catch(error){
      if(signal.aborted)return;
      host.textContent='Foto tidak tersedia.';
      if(error.status===401)showError(error);
    }
  }
  byId('download-photo').onclick=async()=>{
    const id=detailProduct?.images[photoIndex];if(!id){notice('Foto belum tersedia.');return;}
    try{const r=await fetch('/api/distributor?photo='+encodeURIComponent(id),{headers:authHeaders(),credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error('Foto tidak tersedia.');const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=detailProduct.sku+'-'+(photoIndex+1)+'.'+(blob.type==='image/png'?'png':blob.type==='image/webp'?'webp':'jpg');a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}catch(e){notice(e.message);}
  };
  function renderPhoto(){
    if(photoLife)photoLife.abort();
    photoLife=new AbortController();
    const photos=detailProduct.images;
    loadPhoto(byId('detail-photo'),photos[photoIndex],detailProduct.name+' · '+(photoIndex+1),photoLife.signal);
    byId('photo-nav').hidden=photos.length<2;
    byId('photo-count').textContent=(photoIndex+1)+' / '+photos.length;
  }
  function showDetails(product){
    detailProduct=product;photoIndex=0;
    const d=product.details;
    byId('detail-sku').textContent=product.sku;
    byId('detail-title').textContent=display(product.name);
    byId('detail-price').textContent=money(product.price)+' · '+product.available+' unit tersedia';
    const list=byId('detail-specs');list.replaceChildren();
    if(d.sourceName&&d.sourceName!==product.name)list.append(entry('dt','Nama produk'),entry('dd',display(d.sourceName)));
    for(const [key,label,unit] of fields){
      if(d[key]==null&&!['dimensions','material','color','specification'].includes(key))continue;
      list.append(entry('dt',label),entry('dd',valueWithUnit(d[key],unit)));
    }
    byId('detail-points').textContent=d.sellingPoints||'';
    byId('product-dialog').showModal();renderPhoto();
  }
  byId('close-detail').onclick=()=>byId('product-dialog').close();
  byId('product-dialog').onclose=()=>{photoLife?.abort();byId('detail-photo').replaceChildren();detailProduct=null;};
  function changePhoto(offset){
    photoIndex=(photoIndex+offset+detailProduct.images.length)%detailProduct.images.length;
    renderPhoto();
  }
  byId('next-photo').onclick=()=>changePhoto(1);
  byId('prev-photo').onclick=()=>changePhoto(-1);

  function renderCatalog(){
    const list=byId('products');
    thumbnails.disconnect();listLife.abort();listLife=new AbortController();list.replaceChildren();
    const query=byId('search').value.trim().toLowerCase();
    const matches=state.products.filter(p=>[p.sku,p.name,p.details.sourceName,p.details.material,p.details.color]
      .some(v=>v&&[v,display(v)].some(term=>String(term).toLowerCase().includes(query))));
    const pages=Math.max(1,Math.ceil(matches.length/pageSize));
    page=Math.min(page,pages-1);
    byId('catalog-pages').hidden=pages===1;
    byId('page-number').textContent=(page+1)+' / '+pages;
    byId('prev').disabled=page===0;byId('next').disabled=page===pages-1;
    for(const p of matches.slice(page*pageSize,(page+1)*pageSize)){
      const line=document.createElement('article'),info=document.createElement('div'),qty=document.createElement('input');
      line.className='product-row';
      const photo=document.createElement('button');
      photo.type='button';photo.className='product-thumb photo-frame';photo.setAttribute('aria-label','Lihat foto dan detail '+p.sku);
      photo.onclick=()=>showDetails(p);
      photo.textContent=p.images.length?'Memuat foto…':'Foto belum tersedia';
      if(p.images.length){photo.dataset.photo=p.images[0];photo.dataset.alt=p.name;thumbnails.observe(photo);}
      const detailLink=entry('button','Detail produk');detailLink.type='button';detailLink.className='detail-link';detailLink.onclick=()=>showDetails(p);
      const facts=[p.details.dimensions&&valueWithUnit(p.details.dimensions,'cm'),display(p.details.material)].filter(Boolean);
      info.append(entry('small',p.sku),entry('h3',display(p.name)));
      if(facts.length)info.append(entry('p',facts.join(' · ')));
      info.append(detailLink);
      const buy=document.createElement('div');buy.className='product-buy';
      buy.append(entry('strong',money(p.price)),entry('small','Stok '+p.available));
      qty.type='number';qty.min='0';qty.max=String(p.available);qty.step='1';qty.placeholder='0';qty.disabled=Boolean(pending)||busy||p.available<=0;
      qty.setAttribute('aria-label','Jumlah '+p.sku);qty.value=selection.get(p.sku)?.qty||'';
      qty.oninput=()=>{
        if(!qty.validity.valid){selection.delete(p.sku);qty.reportValidity();}
        else if(qty.valueAsNumber>0){selection.set(p.sku,{sku:p.sku,price:p.price,version:p.version,qty:qty.valueAsNumber});}
        else{selection.delete(p.sku);}
        showCart();
      };
      buy.append(qty);line.append(photo,info,buy);list.append(line);
    }
    if(!list.childElementCount)list.append(entry('p',query?'Tidak ada SKU yang cocok.':'Belum ada produk dengan harga dan stok tersedia.'));
  }
  byId('prev').onclick=()=>{page--;renderCatalog();byId('search').focus();};
  byId('next').onclick=()=>{page++;renderCatalog();byId('search').focus();};
  function draw(){
    renderCatalog();
    const history=byId('history');history.replaceChildren();
    for(const o of state.orders){
      const line=row(),info=document.createElement('div');info.append(entry('strong',o.order_no),entry('small',o.business_date+' · '+o.total_qty+' unit'));
      line.append(info,entry('span',labels[o.status]||o.status),entry('strong',money(o.total_amount)));
      const details=document.createElement('details');details.append(entry('summary','Rincian pesanan'));
      if(o.payment)details.append(entry('p','Dana tercatat '+money(o.payment.paid)+' · Sisa pembayaran '+money(o.payment.outstanding)+(o.payment.refundDue?' · Pengembalian dana menunggu '+money(o.payment.refundDue):'')));
      for(const item of o.items)details.append(entry('p',item.sku+' · '+item.qty+' × '+money(item.price)));
      for(const shipment of o.shipments)details.append(entry('p',shipment.date+' · '+shipment.carrier+(shipment.tracking?' · Resi '+shipment.tracking:'')));
      line.append(details);history.append(line);
    }
    if(!state.orders.length)history.append(entry('p','Belum ada pesanan melalui tautan ini.'));
    showCart();
  }
  async function load(){
    state=await api();
    state.products.sort((a,b)=>Number(b.images.length>0)-Number(a.images.length>0));
    const c=state.customer;
    byId('customer').textContent=c.name+' · '+c.code;byId('sales').textContent='Sales Anda: '+c.sales;
    byId('address').textContent=c.address+', '+c.city;byId('workspace').hidden=false;
    if(!key){
      key='lj.distributor.pending.'+c.code;
      try{pending=JSON.parse(sessionStorage.getItem(key));}catch{pending=null;}
      if(pending)for(const item of pending.selection)selection.set(item.sku,item);
    }
    if(!pending){
      // Remove changed items so an updated price can only be ordered after selection again.
      let changed=false;
      for(const [sku,line] of selection){
        const live=state.products.find(p=>p.sku===sku);
        if(!live||live.version!==line.version||live.available<line.qty){selection.delete(sku);changed=true;}
      }
      if(changed)notice('Harga atau stok berubah. Silakan pilih kembali produk terkait.');
    }
    draw();
  }
  function showError(error){
    if(error.status===401){
      byId('workspace').hidden=true;loginView();
      if(byId('product-dialog').open)byId('product-dialog').close();
      thumbnails.disconnect();listLife.abort();
    }
    notice(error.status?error.message:'Koneksi terputus. Silakan coba kembali.');
  }
  function clearPending(){pending=null;try{sessionStorage.removeItem(key);}catch{/* optional storage */}}
  byId('search').oninput=()=>{page=0;renderCatalog();};
  byId('refresh').onclick=()=>{if(!busy){notice('');load().catch(showError);}};
  byId('submit').onclick=async()=>{
    if(busy||(!selection.size&&!pending))return;
    busy=true;
    if(!pending){
      const items=Array.from(selection.values(),({sku,qty,version})=>({sku,qty,version}));
      pending={request:{requestId:crypto.randomUUID(),items},selection:Array.from(selection.values())};
      try{sessionStorage.setItem(key,JSON.stringify(pending));}catch{/* same-page retries still reuse the key */}
    }
    draw();notice('');
    try{
      const result=await api(pending.request);
      clearPending();selection.clear();
      const receipt='Pesanan '+result.orderNo+' sudah diterima.';
      notice(receipt);
      try{await load();}catch{notice(receipt+' Muat ulang untuk melihat status.');}
    }catch(error){
      if([400,409,413].includes(error.status)){clearPending();try{await load();}catch{/* show original error */}}
      showError(error);
    }finally{busy=false;draw();}
  };
  try{await load();notice(pending?'Periksa kembali pesanan sebelumnya sebelum membuat pesanan baru.':'');}
  catch(error){showError(error);}
})();
