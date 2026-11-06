import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {contentFixture,brief,date} from './content-center-fixture.mjs';
import {fileBucket,openDatabase} from '../server/storage.mjs';
import {createBackup,restoreBackup} from '../server/backup.mjs';
import {uploadMaterialPart,listMaterials,materialResponse,updateMaterials,partBytes} from '../lib/content-materials.mjs';

function setup(t){
  const f=contentFixture(),root=mkdtempSync(join(tmpdir(),'lj-materials-')),bucket=fileBucket(join(root,'original'));
  t.after(()=>{f.sqlite.close();rmSync(root,{recursive:true,force:true});});
  const data=new TextEncoder().encode('\x00\x00\x00\x18ftypisom0000test');
  const meta={id:crypto.randomUUID(),batch:crypto.randomUUID(),original:'容量.mp4',title:'通勤包容量',sku:'H068-3',from:'2026-11-01',to:'2026-11-08',note:'无字幕',sites:['印尼'],size:data.length};
  const upload=(m=meta,b=data,index=0,as=f.camera)=>uploadMaterialPart(f.db,bucket,as,m,index,new Blob([b]));
  const list=(as,filters={})=>listMaterials(f.db,as,filters);
  const modify=(as,action,extra={})=>updateMaterials(f.db,as,{action,ids:[meta.id],...extra});
  return {...f,root,bucket,meta,data,upload,list,modify};
}
test('成片只有分发站点可读，追加站点不抹去原收件人，归档保留记录',async t=>{
  const f=setup(t),{indonesia:id,malaysia:my}=f.users;
  await f.upload();
  assert.equal((await f.list(my)).total,0);
  await assert.rejects(materialResponse(f.db,f.bucket,my,f.meta.id,null,false),{status:404});
  await assert.rejects(f.modify(id,'assign',{sites:['泰国']}),{status:403});
  await assert.rejects(f.upload({...f.meta,id:crypto.randomUUID()},f.data,0,id),{status:403});
  await assert.rejects(f.modify(f.camera,'downloaded',{site:'印尼'}),{status:403});
  await f.modify(id,'failed',{site:'印尼'});
  assert.equal((await f.list(id,{status:'failed'})).total,1);
  await f.modify(id,'downloaded',{site:'印尼'});
  await f.modify(f.camera,'assign',{sites:['马来西亚','印尼']});
  await f.modify(id,'failed',{site:'印尼'});
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM audit_logs WHERE entity_id=? AND action='素材下载失败'").get(f.meta.id).n,1);
  assert.equal((await f.list(my,{q:'H068',status:'pending',site:'马来西亚'})).items[0].sites.length,1);
  assert.equal((await f.list(id,{status:'downloaded'})).items[0].sites[0].handled_by,id.name);
  await assert.rejects(f.modify(my,'downloaded',{site:'印尼'}),{status:403});
  await assert.rejects(f.modify(my,'archive'),{status:403});
  await assert.rejects(f.list(f.users.finance),{status:403});
  await f.modify(f.users.admin,'archive');
  assert.equal((await f.list(my,{archived:'1'})).total,0);
  assert.equal((await f.list(f.camera,{archived:'1',by:f.camera.id})).items[0].sites.length,2);
  await assert.rejects(materialResponse(f.db,f.bucket,id,f.meta.id,null,true),{status:404});
});
test('批次部分完成时逐文件可见；分片校验、重试、字节范围与备份恢复',async t=>{
  const f=setup(t),first=new Uint8Array(partBytes),last=new Uint8Array([1,2,3,4]);
  first.set(f.data);first[first.length-1]=123;
  const m={...f.meta,size:partBytes+4},id=f.users.indonesia;
  await f.upload(m,first);
  assert.equal((await f.list(id)).total,0);
  await f.upload(m,first);
  await f.upload({...f.meta,id:crypto.randomUUID()});
  assert.equal((await f.list(id)).total,1);
  await assert.rejects(f.upload({...m,sku:'其他'},last,1),{status:409});
  await f.upload(m,last,1);
  await f.upload(m,last,1);
  await assert.rejects(f.upload(m,new Uint8Array([1,2,3,5]),1),{status:409});
  assert.equal((await f.list(id)).total,2);
  assert.equal((await materialResponse(f.db,f.bucket,id,m.id,'bytes=99999999999-',false)).status,416);
  const bytes=await materialResponse(f.db,f.bucket,id,m.id,'bytes='+(partBytes-1)+'-'+(partBytes+1),false);
  assert.equal(bytes.status,206);
  assert.deepEqual(new Uint8Array(await bytes.arrayBuffer()),new Uint8Array([123,1,2]));
  assert.equal((await f.list(id)).items[0].sites[0].status,'pending');
  const archive=join(f.root,'backup.tar'),target=join(f.root,'restored');
  await createBackup({DB:f.db,WHOLESALE_FILES:f.bucket},archive);
  await restoreBackup(archive,target);
  const restored=openDatabase(join(target,'business.sqlite'));
  try{const r=await materialResponse(restored,fileBucket(join(target,'files')),id,m.id,'bytes=-4',true);
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()),last);
    assert.match(r.headers.get('Content-Disposition'),/^attachment/);
  }finally{restored.sqlite.close();}
});
test('非法格式、站点和日期被拒绝；同页批量处理不可部分生效',async t=>{
  const f=setup(t);
  await assert.rejects(f.upload(f.meta,new Uint8Array(f.data.length)),/无法识别/);
  await assert.rejects(f.upload({...f.meta,from:'2026-02-30'}),/日期/);
  await assert.rejects(f.upload({...f.meta,sites:['巴西']}),/站点/);
  await f.upload();
  await assert.rejects(f.modify(f.camera,'assign',{sites:['泰国'],ids:[f.meta.id,crypto.randomUUID()]}),{status:409});
  assert.equal((await f.list(f.camera,{site:'泰国'})).total,0);
  assert.equal((await f.list(f.camera,{from:'2000-01-01',to:'2000-01-01'})).total,0);
  assert.equal((await f.list(f.camera,{q:'不存在'})).total,0);
});

test('同批十二个成片共用实拍需求与两个站点，禁止错配产品或其他来源的脚本',async t=>{
  const f=setup(t),source=(await f.act(f.users.indonesia,'create',{...brief,due:date()})).id;
  const m={...f.meta,sku:brief.sku,sites:['印尼','马来西亚'],scriptId:source};
  await assert.rejects(f.upload({...m,sku:'BAG-B'}),/须与产品编码一致/);
  const other=(await f.act(f.users.indonesia,'create',{...brief,source:'ai',scene:'AI 生成',due:date()})).id;
  await assert.rejects(f.upload({...m,scriptId:other}),/须与产品编码一致/);
  for(let i=0;i<12;i++)await f.upload({...m,id:crypto.randomUUID(),title:'成片 '+i});
  const list=await f.list(f.users.indonesia,{q:m.batch});
  assert.equal(list.total,12);
  assert.ok(list.items.every(row=>row.script_id===source&&row.sites.length===1&&row.sites[0].site==='印尼'));
  assert.equal((await f.list(f.users.malaysia,{status:'pending'})).total,12);
});
