// Private S3 / R2 only. Credentials never leave this module. All file bytes go directly to storage.
import {distFail} from './distributor-accounts.mjs';
const enc=s=>encodeURIComponent(s).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
const bytes=s=>new TextEncoder().encode(s),hex=b=>Array.from(new Uint8Array(b),x=>x.toString(16).padStart(2,'0')).join('');
const hash=async s=>hex(await crypto.subtle.digest('SHA-256',bytes(s)));
const hmac=async(k,s)=>crypto.subtle.sign('HMAC',await crypto.subtle.importKey('raw',typeof k==='string'?bytes(k):k,{name:'HMAC',hash:'SHA-256'},false,['sign']),bytes(s));
export function materialConfig(env={}){
 if(env.MATERIALS_ENABLED!=='1')distFail(503,'Pustaka materi belum diaktifkan.');
 let endpoint;try{endpoint=new URL(env.MATERIALS_S3_ENDPOINT);}catch{distFail(503,'Penyimpanan materi belum tersedia.');}
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||!env.MATERIALS_S3_ACCESS_KEY||!env.MATERIALS_S3_SECRET_KEY||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.MATERIALS_S3_BUCKET||''))distFail(503,'Penyimpanan materi belum tersedia.');
 return {endpoint:endpoint.origin,bucket:env.MATERIALS_S3_BUCKET,access:env.MATERIALS_S3_ACCESS_KEY,secret:env.MATERIALS_S3_SECRET_KEY,region:env.MATERIALS_S3_REGION||'auto'};
}
export async function signMaterialObject(config,key,{method='GET',ttl=120,headers={},query={},now=new Date()}={}){
 if(!/^distributor-materials\/(?:staging|objects)\/[a-z0-9-]+\/(?:file|cover)$/.test(key))throw Error('Invalid material key');
 if(!Number.isInteger(ttl)||ttl<1||ttl>300)throw Error('Invalid expiry');
 const date=now.toISOString().replace(/[:-]|\.\d{3}/g,''),day=date.slice(0,8),scope=`${day}/${config.region}/s3/aws4_request`;
 const url=new URL(config.endpoint+'/'+enc(config.bucket)+'/'+key.split('/').map(enc).join('/'));
 const hs={host:url.host,...Object.fromEntries(Object.entries(headers).map(([k,v])=>[k.toLowerCase(),String(v).trim()]))};
 const signed=Object.keys(hs).sort().join(';');
 const q={...query,'X-Amz-Algorithm':'AWS4-HMAC-SHA256','X-Amz-Credential':config.access+'/'+scope,'X-Amz-Date':date,'X-Amz-Expires':String(ttl),'X-Amz-SignedHeaders':signed};
 const qs=Object.entries(q).map(([k,v])=>[enc(k),enc(v)]).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>k+'='+v).join('&');
 const canonical=[method,url.pathname,qs,Object.keys(hs).sort().map(k=>k+':'+hs[k]+'\n').join(''),signed,'UNSIGNED-PAYLOAD'].join('\n');
 const signing=await hmac(await hmac(await hmac(await hmac('AWS4'+config.secret,day),config.region),'s3'),'aws4_request');
 const signature=hex(await hmac(signing,'AWS4-HMAC-SHA256\n'+date+'\n'+scope+'\n'+await hash(canonical)));
 return url.origin+url.pathname+'?'+qs+'&X-Amz-Signature='+signature;
}
export function materialStorage(env){
 const config=materialConfig(env);
 return {
  sign:(key,options)=>signMaterialObject(config,key,options),
  async seal(key,mime,size,destination=key){
   const staging=key.replace('/objects/','/staging/');
   const head=await fetch(await signMaterialObject(config,staging,{method:'HEAD'}),{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!head.ok||head.headers.get('content-type')!==mime||Number(head.headers.get('content-length'))!==size)distFail(409,'Berkas belum lengkap atau format berubah. Unggah ulang.');
   // Copy to an immutable key. Replaying an upload URL can only alter the staging object.
   const etag=head.headers.get('etag');if(!etag)distFail(409,'Berkas belum dapat diverifikasi.');
   const headers={'x-amz-copy-source':'/'+config.bucket+'/'+staging,'x-amz-copy-source-if-match':etag};
   const copy=await fetch(await signMaterialObject(config,destination,{method:'PUT',headers}),{method:'PUT',headers,redirect:'error',signal:AbortSignal.timeout(15000)});
   const body=await copy.text();if(!copy.ok||!body.includes('<CopyObjectResult')||body.includes('<Error>'))distFail(503,'Penyimpanan sedang sibuk. Coba lagi.');
  }
 };
}
