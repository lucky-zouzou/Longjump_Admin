'use client';
import {useState} from 'react';
import {useWholesaleLanguage} from './wholesale-language';
import {useDirtyGuard} from './workspace-hooks';
import SampleItemsImport from './marketing-sample-items-import';
type Row=Record<string,any>;
export default function McnSampleCreate({data,busy,act,close}:{data:Row;busy:boolean;act:(p:Row)=>Promise<boolean>;close:()=>void}){
 const {language}=useWholesaleLanguage(),tr=(z:string,i:string)=>language==='id'?i:z;
 const scopes=data.mcnScopes||[],skus=data.skus||[];
 const [v,setV]=useState<Row>({scopeId:scopes.length===1?scopes[0].id:'',name:'',contactName:'',contactMethod:'',cooperationRef:'',purpose:'',signedOn:'',agreementRef:'',fulfillment:'',requirement:'',dueDate:'',confirmed:false,recipient:{name:'',phone:'',city:'',address:''},items:[{sku:'',sampleQty:''}]}),[dirty,setDirty]=useState(false),[query,setQuery]=useState('');
 useDirtyGuard(dirty);const set=(key:string,value:any)=>{setDirty(true);setV({...v,[key]:value});};
 const field=(key:string,z:string,i:string,type='text',max=1000)=><label>{tr(z,i)}<input required disabled={busy} type={type} maxLength={max} value={v[key]} onChange={e=>set(key,e.target.value)}/></label>;
 const exit=()=>{if(!dirty||confirm(tr('放弃尚未保存的内容？','Buang perubahan yang belum disimpan?'))){setDirty(false);close();}};
 return <section className="panel ms-editor ms-mcn-editor" id="mcn-sample-application"><h3>{tr('MCN 机构寄样申请','Pengajuan sampel agensi MCN')}</h3><p className="ms-muted">{tr('无需选择达人。以机构和本次合作编号留档，由你负责跟进，供应链审核后才能锁库。','Tidak perlu memilih kreator. Catat agensi dan nomor kerja sama, lalu tindak lanjuti. Stok dicadangkan setelah tinjauan rantai pasok.')}</p>
 {!scopes.length?<p className="notice info">{tr('当前账号没有印尼 TikTok 店铺分工，请联系管理员或 BD 组长配置。','Akun belum ditugaskan ke toko TikTok Indonesia. Hubungi admin atau ketua BD.')}</p>:<form onSubmit={async e=>{e.preventDefault();if(await act({action:'createMcn',scopeId:v.scopeId,mcn:{name:v.name,contactName:v.contactName,contactMethod:v.contactMethod,cooperationRef:v.cooperationRef,purpose:v.purpose},signedOn:v.signedOn,agreementRef:v.agreementRef,fulfillment:v.fulfillment,requirement:v.requirement,dueDate:v.dueDate,confirmed:v.confirmed,recipient:v.recipient,items:v.items})){setDirty(false);close();}}}>
  <h4>{tr('1 · 机构与合作','1 · Agensi dan kerja sama')}</h4><div className="ms-grid">
   <label>{tr('所属印尼 TikTok 店铺','Toko TikTok Indonesia')}<select required disabled={busy} value={v.scopeId} onChange={e=>set('scopeId',e.target.value)}><option value="">{tr('选择店铺','Pilih toko')}</option>{scopes.map((s:Row)=><option key={s.id} value={s.id}>{s.shop}</option>)}</select></label>
   {field('name','MCN 机构名称','Nama agensi MCN','text',150)}{field('contactName','机构联系人','Nama kontak agensi','text',100)}{field('contactMethod','机构联系方式','Kontak agensi','text',200)}{field('cooperationRef','本次合作编号 / 项目编号','Nomor kerja sama / proyek','text',150)}{field('purpose','寄样用途','Tujuan pengiriman sampel')}
  </div><h4>{tr('2 · 协议与交付约定','2 · Perjanjian dan kewajiban')}</h4><div className="ms-grid">
   {field('signedOn','协议签署日期','Tanggal perjanjian','date')}{field('agreementRef','已签署协议凭据 / 文件链接','Bukti / tautan perjanjian')}
   <label>{tr('机构交付方式','Kewajiban agensi')}<select required disabled={busy} value={v.fulfillment} onChange={e=>set('fulfillment',e.target.value)}><option value="">{tr('按协议选择','Pilih sesuai perjanjian')}</option><option value="content">{tr('约定内容 / 推广交付','Konten / promosi diwajibkan')}</option><option value="sample_only">{tr('协议明确仅寄样，不要求内容','Hanya sampel, tanpa kewajiban konten')}</option></select></label>
   {v.fulfillment==='content'&&field('dueDate','约定交付日期','Batas waktu penyerahan','date')}
   <label className="ms-wide">{tr('机构约定交付说明','Rincian kewajiban yang disepakati')}<textarea required disabled={busy} maxLength={2000} value={v.requirement} onChange={e=>set('requirement',e.target.value)} placeholder={tr('按协议填写；仅寄样也请说明具体用途与约定。','Isi sesuai perjanjian, termasuk tujuan dan ketentuan jika hanya mengirim sampel.')}/></label>
  </div><h4>{tr('3 · 样品清单','3 · Daftar sampel')}</h4>
  <SampleItemsImport skus={skus} items={v.items} busy={busy} contextKey={v.scopeId} onApply={items=>set('items',items)}/>
  <input type="search" aria-label={tr('筛选寄样 SKU','Cari SKU sampel')} placeholder={tr('搜索 SKU 或商品名','Cari SKU atau nama barang')} value={query} onChange={e=>setQuery(e.target.value)}/>
  <div className="ms-mcn-items">{v.items.map((item:Row,index:number)=><div key={index}><label>{tr('第','SKU ke-')}{index+1}{tr('项 SKU','')}<select required disabled={busy} value={item.sku} onChange={e=>set('items',v.items.map((x:Row,n:number)=>n===index?{...x,sku:e.target.value}:x))}><option value="">{tr('选择 SKU','Pilih SKU')}</option>{skus.filter((s:Row)=>s.sku===item.sku||[s.sku,s.name].join(' ').toLowerCase().includes(query.trim().toLowerCase())).map((s:Row)=><option key={s.sku} value={s.sku}>{s.sku} · {s.name}</option>)}</select></label><label>{tr('第','Jumlah ke-')}{index+1}{tr('项数量','')}<input required disabled={busy} type="number" min={1} max={10000} step={1} value={item.sampleQty} onChange={e=>set('items',v.items.map((x:Row,n:number)=>n===index?{...x,sampleQty:e.target.value}:x))}/></label><button type="button" className="btn" disabled={busy||v.items.length===1} onClick={()=>set('items',v.items.filter((_:Row,n:number)=>n!==index))}>{tr('移除','Hapus')}</button></div>)}</div>
  <button type="button" className="btn" disabled={busy||v.items.length>=100} onClick={()=>set('items',[...v.items,{sku:'',sampleQty:''}])}>{tr('＋ 添加 SKU','＋ Tambah SKU')}</button>
  <h4>{tr('4 · 实际收件信息','4 · Penerima aktual')}</h4><div className="ms-grid">{[['name','实际收件人','Nama penerima'],['phone','收件电话','Telepon penerima'],['city','城市','Kota'],['address','完整收货地址','Alamat lengkap']].map(([key,z,i])=><label key={key} className={key==='address'?'ms-wide':''}>{tr(z,i)}<input required disabled={busy} maxLength={key==='address'?500:key==='phone'?80:100} value={v.recipient[key]} onChange={e=>set('recipient',{...v.recipient,[key]:e.target.value})}/></label>)}</div>
  <label className="ms-mcn-confirm"><input type="checkbox" required disabled={busy} checked={v.confirmed} onChange={e=>set('confirmed',e.target.checked)}/>{tr('我已与 MCN 核对协议、SKU、数量和交付约定','Saya telah mengonfirmasi perjanjian, SKU, jumlah dan kewajiban dengan MCN')}</label>
  <p className="ms-muted">{tr('免费样品，不生成销售收入或客户应收；财务按实发数量分别核对样品成本和运费。','Sampel gratis tidak menghasilkan penjualan atau piutang. Keuangan memverifikasi biaya sampel dan ongkos kirim berdasarkan pengiriman aktual.')}</p>
  <button className="btn primary" disabled={busy}>{tr('提交 MCN 寄样申请','Ajukan sampel MCN')}</button>
 </form>}<button type="button" className="btn" disabled={busy} onClick={exit}>{tr('关闭','Tutup')}</button></section>;
}
