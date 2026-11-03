export class InquiryError extends Error{constructor(status,message){super(message);this.status=status;}}
export async function inquiryHash(raw){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function signInquiry(secret,timestamp,raw){
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return [...new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+raw)))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
export async function verifyInquiryRequest(request,secret,now=Date.now()){
 if(!secret||secret.length<32)throw new InquiryError(503,'询盘同步尚未配置');
 if(request.method!=='POST')throw new InquiryError(405,'仅接受服务端推送');
 const timestamp=request.headers.get('x-loongjump-timestamp')||'',signature=request.headers.get('x-loongjump-signature')||'';
 if(!/^\d{13}$/.test(timestamp)||Math.abs(now-Number(timestamp))>300000||!/^([a-f0-9]{64})$/.test(signature))throw new InquiryError(401,'同步签名无效或已过期');
 if(Number(request.headers.get('content-length')||0)>64000)throw new InquiryError(413,'询盘内容过大');
 const reader=request.body?.getReader();let raw='',size=0;const decoder=new TextDecoder();
 if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>64000){await reader.cancel();throw new InquiryError(413,'询盘内容过大');}raw+=decoder.decode(value,{stream:true});}raw+=decoder.decode();
 const expected=await signInquiry(secret,timestamp,raw);let diff=0;for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^signature.charCodeAt(i);
 if(diff)throw new InquiryError(401,'同步签名无效或已过期');
 try{const input=JSON.parse(raw);if(!input||typeof input!=='object'||Array.isArray(input))throw Error();return input;}catch{throw new InquiryError(400,'询盘格式错误');}
}
