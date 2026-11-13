(()=>{
 const desk=document.getElementById('payment-desk'),form=document.getElementById('payment-form'),message=document.getElementById('payment-message'),history=document.getElementById('payment-history');
 const token=location.hash.slice(1),headers=/^[a-f0-9]{64}$/.test(token)?{Authorization:'Bearer '+token}:{};
 let pending=null,busy=false;
 const storageKey='lj-mitra-payment-pending';try{pending=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
 const money=n=>new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(n);
 async function api(body){const r=await fetch('/api/distributor?payment=1',{method:body?'POST':'GET',credentials:'same-origin',headers,body,cache:'no-store'}),d=await r.json();if(!r.ok)throw Error(d.error||'Coba lagi nanti.');return d;}
 async function load(){try{const d=await api(),select=form.elements.orderNo,old=select.value;select.replaceChildren();for(const o of d.orders){const option=new Option(o.order_no+' · '+money(o.total_amount),o.order_no);select.add(option);}if([...select.options].some(o=>o.value===old))select.value=old;
 form.hidden=!d.orders.length;history.replaceChildren();for(const r of d.submissions){const article=document.createElement('article');article.className='line';for(const text of [r.order_no+' · '+money(r.amount),r.reference+' · '+r.business_date,{submitted:'Menunggu verifikasi keuangan',verified:'Bukti terhubung ke catatan penerimaan dana',reversed:'Catatan penerimaan dikoreksi; hubungi tim keuangan',rejected:'Perlu diperbaiki'}[r.state],r.review_note]){const p=document.createElement('p');p.textContent=text;article.append(p);}history.append(article);}if(!d.orders.length)message.textContent='Bukti pembayaran dapat dikirim setelah pesanan disetujui.';
 }catch(e){message.textContent=e.message;}}
 desk.addEventListener('toggle',()=>{if(desk.open&&!busy)load();});
 form.onsubmit=async event=>{event.preventDefault();if(busy)return;busy=true;form.querySelector('button').disabled=true;message.textContent='Mengunggah…';
 const body=new FormData(form),file=body.get('evidence');
 const key=JSON.stringify([...body.entries()].map(([k,v])=>[k,typeof v==='string'?v:[v.name,v.size,v.lastModified]]));
 if(pending?.key!==key)pending={key,id:crypto.randomUUID()};try{sessionStorage.setItem(storageKey,JSON.stringify(pending));}catch{}body.set('requestId',pending.id);
 try{await api(body);pending=null;try{sessionStorage.removeItem(storageKey);}catch{}form.reset();message.textContent='Bukti diterima. Menunggu pemeriksaan dana oleh tim keuangan.';await load();}catch(e){message.textContent=e.message;}finally{busy=false;form.querySelector('button').disabled=false;}
 };
})();
