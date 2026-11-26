import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBusinessNumber,uniqueBusinessNumber} from '../lib/distribution-identifiers.mjs';
test('country plus exactly six numeric digits preserves leading zeros and rejects biased bytes',()=>{
 const number=randomBusinessNumber('CN',buffer=>{buffer.set([255,254,253,252,251,250,0,1,2,3,4,5]);return buffer;});
 assert.equal(number,'CN-012345');for(let n=0;n<20;n++)assert.match(randomBusinessNumber('ID'),/^ID-\d{6}$/);assert.throws(()=>randomBusinessNumber('XX'),/Unsupported/);
});
test('number collisions retry without updating historical records; exhaustion and dynamic SQL are rejected',async()=>{
 const queries=[],db={prepare:sql=>({bind:value=>({first:async()=>{queries.push([sql,value]);return value==='ID-000001'?{exists:1}:null;}})})};let calls=0;
 assert.equal(await uniqueBusinessNumber(db,'wholesale_orders','order_no','ID',{candidate:()=>++calls===1?'ID-000001':'ID-000002'}),'ID-000002');
 assert.equal(queries.length,2);assert.ok(queries.every(([sql])=>sql.startsWith('SELECT ')));
 await assert.rejects(()=>uniqueBusinessNumber(db,'wholesale_orders','order_no','ID',{candidate:()=> 'ID-000001'}),e=>e.status===409);
 await assert.rejects(()=>uniqueBusinessNumber(db,'users','id','ID'),/Unsupported/);
 await assert.rejects(()=>uniqueBusinessNumber(db,'wholesale_orders','order_no','ID',{candidate:()=> 'ID-ABC123'}),/Invalid/);
});
