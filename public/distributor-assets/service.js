(() => {
  const desk=document.getElementById('service-desk'), form=document.getElementById('service-form');
  const fields=form.elements, message=document.getElementById('service-message'), history=document.getElementById('service-history');
  const itemField=fields.namedItem('item');
  const refresh=document.getElementById('service-refresh'), labels={submitted:'Menunggu persetujuan',approved:'Sedang diproses keuangan',completed:'Selesai',rejected:'Ditolak'};
  const headers={Authorization:'Bearer '+location.hash.slice(1)};
  let pending=null,busy=false,sequence=0;
  async function requestKey(body,files){
    // Persist only a digest and UUID so a lost response can be retried after refresh.
    const values=['item','kind','qty','reason','description'].map(k=>body.get(k));
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([values,files.map(f=>[f.name,f.size,f.lastModified])])));
    const key='lj.dist.service.'+Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,'0')).join('');
    let id=pending?.key===key?pending.id:null;
    try{id=id||sessionStorage.getItem(key);}catch{}
    id=id||crypto.randomUUID();pending={key,id};try{sessionStorage.setItem(key,id);}catch{}
    return id;
  }
  const paragraph=(parent,value)=>{const p=document.createElement('p');p.textContent=value;parent.append(p);};
  function limit(){fields.qty.max=itemField.selectedOptions[0]?.dataset.available || '0';}
  async function api(body){
    const response=await fetch('/api/distributor?service=1',{method:body?'POST':'GET',headers,body,credentials:'omit',cache:'no-store'});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Gagal memproses permintaan.');return result;
  }
  async function load(success=''){
    const current=++sequence;
    try{
      const result=await api();if(current!==sequence)return;
      const prior=itemField.value;itemField.replaceChildren();
      for(const line of result.lines){
        const opt=new Option(line.order_no+' · '+line.sku+' · '+line.available+' unit',line.id);
        opt.dataset.available=line.available;itemField.add(opt);
      }
      if(result.lines.some(l=>l.id===prior))itemField.value=prior;
      limit();form.hidden=!result.lines.length;history.replaceChildren();
      for(const claim of result.cases){
        const article=document.createElement('article'),title=document.createElement('strong');
        title.textContent=(claim.kind==='return'?'Retur':'Tukar barang')+' · '+labels[claim.state];article.append(title);
        paragraph(article,claim.date+' · '+claim.sku+' × '+claim.qty+' · '+claim.orderNo);
        paragraph(article,claim.caseNo);
        if(claim.message)paragraph(article,claim.message);
        if(claim.refund!==null)paragraph(article,'Pengembalian dana: '+new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(claim.refund));
        if(claim.tracking)paragraph(article,claim.carrier+' · Resi '+claim.tracking);
        history.append(article);
      }
      if(!result.cases.length)paragraph(history,'Belum ada pengajuan.');
      message.textContent=[success,result.lines.length?'':'Belum ada unit terkirim yang dapat diajukan.'].filter(Boolean).join(' ');
    }catch(e){if(current===sequence)message.textContent=(success?success+' ':'')+(e.message||'Tidak dapat memuat data.');}
  }
  itemField.onchange=limit;
  desk.ontoggle=()=>{if(desk.open&&!busy)void load();};
  refresh.onclick=()=>{if(!busy)void load();};
  form.onsubmit=async e=>{
    e.preventDefault();if(busy)return;
    const files=Array.from(fields.evidence.files);
    if(!files.length||files.length>3||files.some(f=>f.size===0||f.size>18*1024*1024)||files.reduce((n,f)=>n+f.size,0)>=20*1024*1024){
      message.textContent='Periksa jumlah dan ukuran berkas bukti.';return;
    }
    const body=new FormData(form);
    busy=true;++sequence;fields[0].disabled=true;refresh.disabled=true;message.textContent='Mengirim pengajuan dan bukti…';
    try{body.set('requestId',await requestKey(body,files));
      const result=await api(body);
      try{sessionStorage.removeItem(pending.key);}catch{}pending=null;form.reset();await load('Pengajuan diterima: '+result.caseNo+'.');}
    catch(error){message.textContent=error.message||'Koneksi terputus. Coba kembali.';}
    finally{busy=false;fields[0].disabled=false;refresh.disabled=false;}
  };
})();
