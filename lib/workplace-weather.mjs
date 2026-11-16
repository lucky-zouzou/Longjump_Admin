// City index: GeoNames (CC BY 4.0). See scripts/build-weather-cities.py.
const names = {
  'Guangzhou':'广州','Shenzhen':'深圳','Shanghai':'上海','Beijing':'北京','Hangzhou':'杭州','Dongguan':'东莞',
  'Foshan':'佛山','Wuhan':'武汉','Yiwu':'义乌','Chengdu':'成都','Changsha':'长沙','Xiamen':'厦门','Hong Kong':'香港',
  'Jakarta':'雅加达','Bandung':'万隆','Surabaya':'泗水','Yogyakarta':'日惹','Medan':'棉兰','Semarang':'三宝垄',
  'Tangerang':'唐格朗','Bekasi':'勿加泗','Denpasar':'登巴萨','Kuala Lumpur':'吉隆坡','Johor Bahru':'新山',
  'George Town':'乔治市','Manila':'马尼拉','Cebu City':'宿务','Bangkok':'曼谷','Chiang Mai':'清迈',
  'Hanoi':'河内','Ho Chi Minh City':'胡志明市','Da Nang':'岘港','Singapore':'新加坡'
};
const suggested = ['1809858','1642911','1735161','1609350','1581130','1701668'];
const fold = s => s.normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/gi,'d').toLowerCase();
let index;
async function cities() {
  if (!index) index = import('./weather-cities.json', {with:{type:'json'}}).then(({default:rows}) => {
    const all = rows.map(([id,name,country,lat,lon,zone,aliases]) => {
      const label = (['CN','HK','ID','MY','TH','VN','PH','SG'].includes(country) && names[name]) || name;
      return {id,name:label,country,lat,lon,zone,key:fold(name+' '+label+' '+aliases)};
    });
    return {all,byId:new Map(all.map(city=>[city.id,city]))};
  });
  return index;
}
function publicCity({id,name,country,zone}) {return {id,name,country,zone};}

function nearby(all, lat, lon) {
  const cos = Math.cos(lat*Math.PI/180);
  let best = null, distance = 40;
  for (const city of all) {
    const dy = (city.lat-lat)*111;
    if (Math.abs(dy)>distance) continue;
    const dx = ((city.lon-lon+540)%360-180)*111*cos;
    const km = Math.hypot(dx,dy);
    // Coordinates from the browser are rounded. Favour the larger city for near ties.
    if (km+0.6 < distance) {best=city;distance=km;}
  }
  return best;
}

const HOUR = 3600000;
export function weatherService(fetchWeather=fetch, clock=Date.now) {
  const cache = new Map(), inFlight = new Map();
  let starts = [];
  async function forecast(city) {
    const now=clock(), old=cache.get(city.id);
    if (old && now<old.until) return old;
    if (inFlight.has(city.id)) return inFlight.get(city.id);
    starts=starts.filter(t=>now-t<60000);
    if (starts.length>=30 || inFlight.size>=4) return old;
    starts.push(now);
    const load=async()=>{
      let entry;
      try {
        const url=new URL('https://api.met.no/weatherapi/locationforecast/2.0/compact');
        url.search=new URLSearchParams({lat:String(city.lat),lon:String(city.lon)}).toString();
        const res=await fetchWeather(url,{headers:{'User-Agent':'LoongJumpWorkplace/1.0 (https://admin.loongjump.com)'},signal:AbortSignal.timeout(4800)});
        if (!res.ok) throw Error('weather unavailable');
        const body=await res.json();
        const hours=body.properties.timeseries.slice(0,48).map(({time,data})=>({
          time:Date.parse(time), temperature:data.instant?.details?.air_temperature,
          symbol:data.next_1_hours?.summary?.symbol_code || data.next_6_hours?.summary?.symbol_code || ''
        })).filter(h=>Number.isFinite(h.time)&&Number.isFinite(h.temperature));
        if (!hours.length) throw Error('weather unavailable');
        const expires=Date.parse(res.headers.get('expires'));
        entry={hours,fetched:now,until:Math.max(now+3*HOUR,Number.isFinite(expires)?expires:0),failed:false};
      } catch {
        entry={hours:old?.hours||[],fetched:old?.fetched||0,until:now+300000,failed:true};
      }
      if (!cache.has(city.id) && cache.size>=256) cache.delete(cache.keys().next().value);
      cache.set(city.id,entry);
      return entry;
    };
    const promise=load().finally(()=>inFlight.delete(city.id));
    inFlight.set(city.id,promise);
    return promise;
  }
  return async function read(params) {
    const {all,byId}=await cities();
    if (params.has('city')) {
      const city=byId.get(params.get('city'));
      if (!city) return {status:404,body:{error:'unknown city'}};
      const entry=await forecast(city), now=clock();
      const slot=entry?.hours.findLast(h=>h.time<=now && now-h.time<HOUR);
      return {status:200,body:{city:publicCity(city),weather:slot && now-entry.fetched<=12*HOUR?
        {...slot,stale:entry.failed||now>=entry.until}:null}};
    }
    if (params.has('lat')||params.has('lon')) {
      const a=params.get('lat'), b=params.get('lon');
      if (!a || !b || !/^-?\d{1,3}(\.\d)?$/.test(a) || !/^-?\d{1,3}(\.\d)?$/.test(b) || Math.abs(+a)>90 || Math.abs(+b)>180)
        return {status:400,body:{error:'invalid location'}};
      const city=nearby(all,+a,+b);
      return {status:200,body:{city:city?publicCity(city):null}};
    }
    const q=fold((params.get('q')||'').trim().slice(0,80));
    const matches=q?all.filter(c=>c.key.includes(q)).slice(0,12):suggested.map(id=>byId.get(id)).filter(Boolean);
    return {status:200,body:{cities:matches.map(publicCity)}};
  };
}
export const readWorkplaceWeather=weatherService();
