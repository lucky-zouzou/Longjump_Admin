'use client';
import {useState} from 'react';
import {useWholesaleLanguage} from './wholesale-language';
import {sampleCreatorUrl} from '../lib/marketing-sample-application.mjs';
type Row=Record<string,any>;
const reasons:Record<string,[string,string]>={
 accept:['待 BD 接收需求','Menunggu BD menerima permintaan'],confirm:['待 BD 确认合作条件','Menunggu konfirmasi ketentuan oleh BD'],
 approval:['合作条件待管理员审批','Ketentuan menunggu persetujuan admin'],items:['本轮未约定寄样 SKU 和数量','SKU dan jumlah sampel belum disepakati'],
 paused:['达人已暂停，先核对是否恢复','Kreator dijeda; periksa tindak lanjut'],existing:['已有寄样单，继续原单即可','Pengajuan sudah ada; lanjutkan dokumen tersebut'],
 dispatched:['历史已寄出，本轮不能重复申请','Sudah dikirim; tidak dapat diajukan lagi'],costed:['已有历史样品费用，需核对原记录','Biaya sampel sudah tercatat; periksa riwayat']
};
export default function SamplePreparation({application,readyCount}:{application:Row;readyCount:number}){
 const {language}=useWholesaleLanguage(),tr=(z:string,i:string)=>language==='id'?i:z;
 const [creatorId,setCreatorId]=useState(''),[query,setQuery]=useState(''),[limit,setLimit]=useState(8);
 const app=application||{profiles:[],pending:[],blocked:[],scopeCount:0};
 const pending=[...app.pending,...app.blocked],matching=pending.filter((r:Row)=>[r.creatorName,r.shop,r.roundNo].join(' ').toLowerCase().includes(query.toLowerCase()));
 const profiles=app.profiles.filter((r:Row)=>[r.creatorName,r.shop].join(' ').toLowerCase().includes(query.toLowerCase()));
 return <div className="ms-preparation">
  <div className="ms-steps" aria-label={tr('申请寄样步骤','Langkah pengajuan sampel')}><span><b>1</b>{tr('选择达人，确认合作','Pilih kreator dan konfirmasi kerja sama')}</span><span><b>2</b>{tr('填协议和收件信息','Isi perjanjian dan penerima')}</span><span><b>3</b>{tr('提交给供应链审核','Ajukan ke rantai pasok')}</span></div>
  {!readyCount&&<p className="ms-empty-title">{tr('先把合作条件确认好，就能接着申请样品。','Konfirmasikan ketentuan kerja sama untuk melanjutkan pengajuan sampel.')}</p>}
  {!app.scopeCount?<p className="notice info">{tr('当前账号没有印尼 TikTok 店铺分工。请管理员或 BD 组长在“达人与直播 BD → 协作设置”配置店铺或达人归属。','Akun ini belum memiliki penugasan TikTok Indonesia. Minta admin atau ketua BD mengatur penugasan toko atau kreator.')}</p>:<>
   <div className="ms-preparation-start"><div><strong>{tr('新一轮寄样，从这里开始','Mulai kerja sama sampel baru di sini')}</strong><small>{tr('已有合作先处理下方记录；没有合作，再选择达人发起。','Lanjutkan kerja sama yang ada di bawah, atau pilih kreator untuk kerja sama baru.')}</small></div><a className="ms-text-link" href={sampleCreatorUrl('new')}>{tr('＋ 新建达人档案','＋ Tambah profil kreator')}</a></div>
   <div className="ms-start-fields"><label>{tr('查找达人 / 合作','Cari kreator / kerja sama')}<input type="search" value={query} placeholder={tr('输入达人名、店铺或合作单号','Nama kreator, toko atau nomor kerja sama')} onChange={e=>{setQuery(e.target.value);setCreatorId('');setLimit(8);}}/></label><label>{tr('为已有达人发起合作','Buat kerja sama untuk kreator')}<select value={creatorId} onChange={e=>setCreatorId(e.target.value)}><option value="">{tr('选择我负责的达人','Pilih kreator tanggung jawab saya')}</option>{profiles.map((p:Row)=><option value={p.creatorId} key={p.creatorId}>{p.creatorName} · {p.shop}</option>)}</select></label>{creatorId?<a className="btn" href={sampleCreatorUrl('creator',creatorId)}>{tr('填写合作条件 →','Isi ketentuan →')}</a>:<button type="button" className="btn" disabled>{tr('填写合作条件 →','Isi ketentuan →')}</button>}</div>
   {!app.profiles.length&&<p className="ms-muted">{tr('还没有可用的达人档案，可以新建档案，或请 BD 组长把已有达人分配给你。','Belum ada profil aktif. Tambahkan profil atau minta ketua BD menugaskan kreator yang ada.')}</p>}
  </>}
  {pending.length>0&&<div className="ms-preparation-list"><h4>{tr('已有合作，下一步做什么','Langkah selanjutnya untuk kerja sama yang ada')} <span>{pending.length}</span></h4>{matching.slice(0,limit).map((r:Row)=>{
   const href=r.orderId?'/?page=marketing-samples&entity='+encodeURIComponent(r.orderId):r.requestId&&r.reason!=='paused'?sampleCreatorUrl('request',r.requestId):r.reason==='paused'?sampleCreatorUrl('profile',r.creatorId):sampleCreatorUrl('round',r.roundId);
   const action=r.reason==='accept'?tr('接收并核对条件','Terima dan periksa'):r.reason==='confirm'?tr('去确认合作条件','Konfirmasi ketentuan'):r.orderId?tr('查看原寄样单','Buka pengajuan'):tr('查看并处理','Buka dan tindak lanjuti');
   return <article key={r.key}><div><strong>{r.creatorName}</strong><small>{r.shop}{r.roundNo?' · '+r.roundNo:''}</small></div><span>{tr(...reasons[r.reason])}</span><a className="ms-text-link" href={href}>{action} →</a></article>;
  })}{!matching.length&&<p>{tr('没有匹配的合作记录。','Tidak ada kerja sama yang sesuai.')}</p>}{matching.length>limit&&<button type="button" className="btn" onClick={()=>setLimit(limit+8)}>{tr('再显示 8 条','Tampilkan 8 lagi')} · {matching.length-limit}</button>}</div>}
 </div>;
}
