import test from 'node:test';
import assert from 'node:assert/strict';
import {weatherService} from '../lib/workplace-weather.mjs';
import {dailyGreeting,weatherWords,salutation} from '../public/workplace-greeting.js';

test('问候随城市当地日期更换，同日登录与返回总览保持一致',()=>{
  const before=new Date('2026-11-15T15:59:00Z'), after=new Date('2026-11-15T16:01:00Z');
  assert.notEqual(dailyGreeting(before,'Asia/Shanghai'),dailyGreeting(after,'Asia/Shanghai'));
  assert.equal(dailyGreeting(before,'Asia/Jakarta'),dailyGreeting(after,'Asia/Jakarta'));
  assert.equal(dailyGreeting(after,'Asia/Shanghai'),dailyGreeting(new Date('2026-11-16T13:00:00Z'),'Asia/Shanghai'));
  assert.equal(salutation(new Date('2026-11-16T04:00:00Z'),'Asia/Shanghai'),'中午好');
  assert.equal(salutation(new Date('2026-11-16T04:00:00Z'),'America/New_York'),'晚上好');
  assert.equal(weatherWords('partlycloudy_night'),'多云');
  assert.equal(weatherWords('heavyrainandthunder'),'雷雨');
  assert.equal(weatherWords('unknown'),'');
});

test('公共城市查询支持中文、本地名和粗略定位；公司账号及设备坐标不发给预报服务',async()=>{
  let at=Date.parse('2026-11-16T09:10:00Z'),calls=0,failed=false;
  const fetchWeather=async(url,opts)=>{
    calls++;
    assert.equal(url.hostname,'api.met.no');assert.deepEqual([...url.searchParams.keys()],['lat','lon']);
    assert.equal(url.searchParams.get('lat'),'23.12');assert.ok(opts.headers['User-Agent'].includes('loongjump.com'));
    if(failed)throw new Error('offline');
    return Response.json({properties:{timeseries:Array.from({length:16},(_,i)=>({
      time:new Date(Date.parse('2026-11-16T09:00:00Z')+i*3600000).toISOString(),
      data:{instant:{details:{air_temperature:i}},next_1_hours:{summary:{symbol_code:'fair_day'}}}
    }))}},{headers:{Expires:'Mon, 16 Nov 2026 12:00:00 GMT'}});
  };
  const service=weatherService(fetchWeather,()=>at);
  const run=q=>service(new URLSearchParams(q));const city='1809858';
  assert.ok((await run({q:'广州'})).body.cities.some(c=>c.id===city));
  assert.equal((await run({q:'Jakarta'})).body.cities[0].name,'雅加达');
  assert.equal((await run({lat:'23.1',lon:'113.3'})).body.city.country,'CN');
  assert.equal((await run({lat:'0.0',lon:'0.0'})).body.city,null);
  assert.equal((await run({lat:'23.123456',lon:'113.123456'})).status,400);
  assert.equal((await run({city:'unknown'})).status,404);assert.equal(calls,0);
  const [a,b]=await Promise.all([run({city}),run({city})]);
  assert.equal(a.body.weather.temperature,0);assert.deepEqual(a,b);assert.equal(calls,1);
  at+=3600000;assert.equal((await run({city})).body.weather.temperature,1);assert.equal(calls,1);
  failed=true;at+=3*3600000;assert.equal((await run({city})).body.weather.stale,true);
  await run({city});assert.equal(calls,2);
  at+=9*3600000;assert.equal((await run({city})).body.weather,null);
});
