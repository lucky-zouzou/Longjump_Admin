export function videoFileType(bytes){
  if(String.fromCharCode(...bytes.slice(4,8))==='ftyp'){
    const brand=String.fromCharCode(...bytes.slice(8,12));
    if(brand==='qt  ')return 'video/quicktime';
    if(/^(isom|iso[2-9m]|mp4[12v ]|avc1|M4V |MSNV|dash|3gp[456])$/.test(brand))return 'video/mp4';
  }
  if(bytes[0]===26&&bytes[1]===69&&bytes[2]===223&&bytes[3]===163&&new TextDecoder().decode(bytes.slice(0,512)).includes('webm'))return 'video/webm';
  throw Object.assign(Error('无法识别视频文件，请使用 MP4、MOV 或 WebM'),{status:400});
}
export async function videoFileResponse(bucket,file,range,download,head,partsFor){
  const headers=new Headers({'Content-Type':file.content_type,'Accept-Ranges':'bytes','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Disposition':(download?'attachment':'inline')+"; filename*=UTF-8''"+encodeURIComponent(file.original_name)});
  let start=0,end=file.size-1;
  if(range){
    const r=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(r&&(r[1]||r[2])){
      start=r[1]?Number(r[1]):Math.max(0,file.size-Number(r[2]));
      end=r[1]&&r[2]?Math.min(Number(r[2]),end):end;
    }
    if(!r||!r[1]&&!r[2]||start>end||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)){
      headers.set('Content-Range','bytes */'+file.size);
      return new Response(null,{status:416,headers});
    }
    headers.set('Content-Range','bytes '+start+'-'+end+'/'+file.size);
  }
  headers.set('Content-Length',String(end-start+1));
  if(head)return new Response(null,{status:range?206:200,headers});
  const parts=await partsFor(start,end);
  let next=0,cancelled=false;
  const body=new ReadableStream({async pull(controller){
    if(cancelled)return;if(next>=parts.length){controller.close();return;}
    const part=parts[next++],base=part.base;
    const offset=Math.max(0,start-base),length=Math.min(part.size,end-base+1)-offset;
    const object=await bucket.get(part.object_key,{range:{offset,length}});
    if(!object)throw new Error('素材分片暂时无法读取');
    const bytes=new Uint8Array(await new Response(object.body).arrayBuffer());
    if(bytes.byteLength!==length)throw new Error('视频分片长度不符');
    if(!cancelled)controller.enqueue(bytes);
  },cancel(){cancelled=true;}});
  return new Response(body,{status:range?206:200,headers});
}
