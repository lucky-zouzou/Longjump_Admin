import test from 'node:test';
import assert from 'node:assert/strict';
import {receiveMaterial} from '../lib/material-download.mjs';
const response=(bytes=3,type='video/mp4')=>new Response(new Uint8Array(bytes),{headers:{'Content-Type':type}});
test('下载返回前必须完整接收并关闭文件，浏览器回退保留原字节',async()=>{
 const events=[],file={write:async b=>events.push(b.length),close:async()=>events.push('closed'),abort:async()=>events.push('aborted')};
 await receiveMaterial(response(),3,file);assert.deepEqual(events,[3,'closed']);
 const blob=await receiveMaterial(response(),3,null);assert.equal(blob.size,3);assert.equal(blob.type,'video/mp4');
});
test('断流、登录页、文件写入及关闭失败都不会返回成功',async()=>{
 for(const [res,size,stage,match] of [[response(2),3,'none',/不完整/],[response(4),3,'none',/大小异常/],[response(3,'text/html'),3,'none',/视频读取失败/],[response(),3,'write',/磁盘写入失败/],[response(),3,'close',/关闭失败/]]){
  let aborted=false;const file={write:async()=>{if(stage==='write')throw Error('磁盘写入失败');},close:async()=>{if(stage==='close')throw Error('关闭失败');},abort:async()=>{aborted=true;}};
  await assert.rejects(receiveMaterial(res,size,file),match);assert.equal(aborted,true);
 }
 const stream=new ReadableStream({pull(c){c.error(Error('网络断开'));}});
 await assert.rejects(receiveMaterial(new Response(stream,{headers:{'Content-Type':'video/mp4'}}),3,null),/网络断开/);
});
