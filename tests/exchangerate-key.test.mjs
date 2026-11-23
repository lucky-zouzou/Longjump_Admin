import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fixture} from './fixtures.mjs';
import {loadSalesFx,cachedSalesFx,configureSalesFxKeyReader,validateFxPayload,convertSalesSummary} from '../lib/sales-fx.mjs';
import {readExchangeRateKey} from '../server/exchangerate-config.mjs';

const now=Date.now(),DAY=86400000,key='test_key_0123456789012345';
const rates={CNY:1,IDR:2000,MYR:.6,THB:5,VND:3500,PHP:8,USD:.14};
const standard=(time=now)=>({result:'success',base_code:'CNY',time_last_update_unix:Math.floor((time-3600000)/1000),time_next_update_unix:Math.floor((time+23*3600000)/1000),conversion_rates:rates});
const response=data=>new Response(JSON.stringify(data));

test('专用接口使用人民币基准和 conversion_rates，五站合计准确且不泄露密钥',async()=>{
 const f=fixture();try{
 let calls=0;
 const fetcher=async(url,options)=>{calls++;assert.equal(url,`https://v6.exchangerate-api.com/v6/${key}/latest/CNY`);assert.equal(options.redirect,'error');assert.equal(options.body,undefined);return response(standard());};
 const fx=await loadSalesFx(f.db,{apiKey:key,now,fetcher});
 assert.equal(fx.access,'standard');assert.equal(fx.status,'fresh');
 const report={filters:{},scopes:Object.entries(rates).filter(([c])=>!['CNY','USD'].includes(c)).map(([currency,revenue])=>({site:'印尼',currency,revenue,adCost:0,qty:1}))};
 assert.equal(convertSalesSummary(report,fx).total.revenueCny,5);
 await loadSalesFx(f.db,{apiKey:key,now:now+1000,fetcher});assert.equal(calls,1);
 assert(!JSON.stringify(fx).includes(key));assert(!JSON.stringify(f.sqlite.prepare('SELECT * FROM sales_fx_snapshots').all()).includes(key));
 assert.throws(()=>validateFxPayload({...standard(),base_code:'USD'},now,'standard'));
 assert.throws(()=>validateFxPayload({...standard(),conversion_rates:undefined,rates},now,'standard'));
 }finally{f.sqlite.close();}
});

test('切换到专用接口立即读取，不被公共缓存遮盖，两类快照互不覆盖',async()=>{
 const f=fixture();try{
 await loadSalesFx(f.db,{apiKey:'',now,fetcher:async()=>response({...standard(),rates,conversion_rates:undefined})});
 let calls=0;
 const fx=await loadSalesFx(f.db,{apiKey:key,now,fetcher:async()=>{calls++;return response({...standard(now-120000),conversion_rates:{...rates,IDR:2100}});}});
 assert.equal(calls,1);assert.equal(fx.rates.IDR,2100);assert.equal(fx.access,'standard');
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_fx_snapshots').get().n,2);
 configureSalesFxKeyReader(()=>key);
 assert.equal((await cachedSalesFx(f.db,now)).rates.IDR,2100);
 const retry=await loadSalesFx(f.db,{apiKey:key,now:now+DAY,fetcher:async()=>response({...standard(now-120000),conversion_rates:{...rates,IDR:2200}})});
 assert.equal(retry.rates.IDR,2100);
 }finally{configureSalesFxKeyReader(()=>'');f.sqlite.close();}
});

test('无效密钥、未激活、额度耗尽及网络失败保留可用缓存并抑制重试',async()=>{
 for(const error of ['invalid-key','inactive-account','quota-reached','network']){
  const f=fixture();try{
   await loadSalesFx(f.db,{apiKey:'',now,fetcher:async()=>response({...standard(),rates})});
   let calls=0;const fetcher=async()=>{calls++;if(error==='network')throw Error(`secret endpoint ${key}`);return response({result:'error','error-type':error});};
   const result=await loadSalesFx(f.db,{apiKey:key,now,fetcher});
   assert.equal(result.refreshFailed,true);assert.equal(result.access,'open');assert.equal(result.rates.PHP,8);
   await loadSalesFx(f.db,{apiKey:key,now:now+1000,fetcher});assert.equal(calls,1);
   assert(!JSON.stringify(result).includes(key));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM sales_fx_snapshots').get().n,1);
  }finally{f.sqlite.close();}
 }
});

test('专用请求并发合并，密钥不允许路径注入或跟随重定向',async()=>{
 const f=fixture();try{
  let calls=0;const fetcher=async(_url,options)=>{calls++;assert.equal(options.redirect,'error');await new Promise(r=>setTimeout(r,10));return response(standard());};
  await Promise.all([loadSalesFx(f.db,{apiKey:key,now,fetcher}),loadSalesFx(f.db,{apiKey:key,now,fetcher})]);assert.equal(calls,1);
  const bad=await loadSalesFx(f.db,{apiKey:key+'/../../bad',now,fetcher});assert.equal(bad.refreshFailed,true);assert.equal(calls,1);
 }finally{f.sqlite.close();}
});

test('服务端支持私密文件，已配置但无法读取时不降级为公共请求',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lj-fx-key-'));try{
 const path=join(dir,'key');writeFileSync(path,key,{mode:0o600});
 assert.equal(readExchangeRateKey({LOONGJUMP_EXCHANGERATE_KEY_FILE:path}),key);
 assert.equal(readExchangeRateKey({EXCHANGERATE_API_KEY:key,LOONGJUMP_EXCHANGERATE_KEY_FILE:'missing'}),key);
 assert.equal(readExchangeRateKey({}),'');
 assert.throws(()=>readExchangeRateKey({LOONGJUMP_EXCHANGERATE_KEY_FILE:join(dir,'missing')}),/汇率密钥文件不可用/);
 writeFileSync(path,'');assert.throws(()=>readExchangeRateKey({LOONGJUMP_EXCHANGERATE_KEY_FILE:path}),/汇率密钥文件不可用/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('部署脚本原子保存私密文件，拒绝非法值和符号链接且不打印密钥',()=>{
 const dir=mkdtempSync(join(tmpdir(),'lj-fx-config-')),script=fileURLToPath(new URL('../scripts/configure-exchangerate-key.py',import.meta.url));
 try{
 const run=value=>spawnSync('python3',[script],{cwd:dir,input:value,encoding:'utf8'});
 const good=run(key);assert.equal(good.status,0,good.stderr);assert.equal(good.stdout,'');assert(!good.stderr.includes(key));
 const folder=join(dir,'secrets/exchangerate'),path=join(folder,'api_key');
 assert.equal(readFileSync(path,'utf8'),key);assert.equal(statSync(folder).mode&0o777,0o700);assert.equal(statSync(path).mode&0o777,0o444);
 const bad=run('bad/key');assert.notEqual(bad.status,0);assert.equal(readFileSync(path,'utf8'),key);
 rmSync(path);const external=join(dir,'external');writeFileSync(external,'unchanged');symlinkSync(external,path);
 assert.notEqual(run(key).status,0);assert.equal(readFileSync(external,'utf8'),'unchanged');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
