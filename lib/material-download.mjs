// A receipt is written only after all bytes arrive and the selected file closes.
export async function receiveMaterial(response,size,writable,onProgress=(_received,_size)=>{}){
 let reader;const chunks=[];let received=0;
 try{
  if(!response.ok||!response.body||!response.headers.get('content-type')?.startsWith('video/'))throw Error('视频读取失败，请刷新登录或重试');
  reader=response.body.getReader();
  for(;;){const {done,value}=await reader.read();if(done)break;received+=value.byteLength;
   if(received>size)throw Error('视频大小异常，请重新下载');
   if(writable)await writable.write(value);else chunks.push(value);
   onProgress(received,size);
  }
  if(received!==size)throw Error('文件接收不完整，请重新下载');
  if(writable)await writable.close();
  return writable?null:new Blob(chunks,{type:response.headers.get('content-type')});
 }catch(e){try{await reader?.cancel();}catch{}if(writable)try{await writable.abort();}catch{}throw e;}
}
