import {dailyGreeting,weatherWords,salutation} from './workplace-greeting.js';

const preference='lj.workplace.weather-city.v1';
const regions=new Intl.DisplayNames(['zh-CN'],{type:'region'});
async function request(params) {
  const response=await fetch('/api/workplace-weather?'+new URLSearchParams(params),{
    credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(String(response.status));
  return response.json();
}
const layout=document.createElement('template');
layout.innerHTML=`<style>
:host{display:block;min-width:0;color:#324b66;font:400 14px/1.55 system-ui,sans-serif;letter-spacing:normal;margin-top:6px}
.bar{display:flex;align-items:center;gap:5px 14px;flex-wrap:wrap}
.hello{display:inline-flex;align-items:center;gap:7px;flex-wrap:wrap}.face{border-radius:50%;background:#fff0bf;color:#935610;width:25px;height:25px;display:inline-grid;place-items:center;font:600 20px/1 system-ui}
@media(prefers-reduced-motion:no-preference){.face{animation:hello-wave .65s ease-out 1}@keyframes hello-wave{0%,100%{transform:rotate(0)}35%{transform:rotate(-12deg)}70%{transform:rotate(8deg)}}}
.salute{color:#2c5264;font-weight:630}.greeting{color:#405974}
.weather{color:#4c6477;font-size:12px}
button{font:inherit;cursor:pointer;color:#315a85;background:transparent;border:0;padding:0}
button:focus-visible,input:focus-visible{outline:2px solid #3276b8;outline-offset:3px}
.quick,.settings{font-size:12px;text-decoration:underline;text-underline-offset:3px}
.panel{box-sizing:border-box;max-width:390px;background:#fff;border:1px solid #dbe5ed;border-radius:10px;margin:8px 0;padding:12px;font-size:13px}
form{display:flex;align-items:center;gap:7px;margin:8px 0}
input{box-sizing:border-box;min-width:0;flex:1;padding:6px 8px;border:1px solid #b8c8d5;border-radius:5px;font:inherit}
.options{display:flex;gap:5px;flex-wrap:wrap}
.options button{padding:3px 8px;background:#eef3f8;border-radius:5px}
.note{display:block;color:#566a77;margin-top:4px}
.source{margin-top:7px;font-size:11px;color:#627489}.source a{color:inherit}
[hidden]{display:none!important}
</style>
<div class="bar"><span class="hello"><span class="face" aria-hidden="true">☺</span><span class="salute"></span><span class="greeting"></span></span><span class="weather" aria-live="polite"></span><button class="quick" type="button">定位城市</button><button class="settings" type="button" aria-expanded="false" aria-controls="city-panel">选择城市</button></div>
<div class="panel" id="city-panel" hidden>
<button class="locate" type="button">◎ 使用当前位置</button>
<form role="search"><input aria-label="城市名称" maxlength="80" placeholder="输入城市中文名或当地名称"><button type="submit">搜索</button></form>
<div class="options" aria-label="城市搜索结果"></div><span class="note" role="status"></span>
<div class="source">预报来自 <a href="https://www.met.no/en" target="_blank" rel="noopener noreferrer">MET Norway</a>，城市来自 <a href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a>。已换算显示格式 · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a></div></div>`;

class WorkplaceWelcome extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({mode:'open'}).append(layout.content.cloneNode(true));
    const get=s=>this.shadowRoot.querySelector(s);
    this.salute=get('.salute');this.greeting=get('.greeting');this.weather=get('.weather');this.panel=get('.panel');
    this.quick=get('.quick');this.quick.onclick=()=>this.locate(true);this.toggle=get('.settings');this.input=get('input');this.options=get('.options');this.note=get('.note');
    this.city=null;this.last=0;this.sequence=0;this.searchSequence=0;
    this.toggle.onclick=()=>this.showPanel(this.panel.hidden);
    get('.locate').onclick=()=>this.locate(true);
    get('form').onsubmit=e=>{e.preventDefault();this.search(this.input.value.trim());};
    this.onVisible=()=>{if(!document.hidden)this.refresh();};
  }
  connectedCallback() {
    this.sayHello();
    this.weather.textContent='本地天气';
    let saved;
    try {saved=localStorage.getItem(preference);} catch {}
    if (saved && /^\d+$/.test(saved)) this.loadCity(saved,false);
    else {
      const initial=this.sequence;
      navigator.permissions?.query({name:'geolocation'}).then(p=>{
        if(this.isConnected&&initial===this.sequence&&p.state==='granted')this.locate(false);
      }).catch(()=>{});
    }
    this.timer=setInterval(()=>this.onVisible(),60000);
    document.addEventListener('visibilitychange',this.onVisible);
  }
  disconnectedCallback() {
    clearInterval(this.timer);this.sequence++;this.searchSequence++;
    document.removeEventListener('visibilitychange',this.onVisible);
  }
  sayHello() {
    const now=new Date(),zone=this.city?.zone,name=this.getAttribute('employee-name')?.trim();
    this.salute.textContent=salutation(now,zone)+(name&&!name.includes('@')?'，'+name:'')+'！';
    this.greeting.textContent=dailyGreeting(now,zone);
  }
  refresh() {
    this.sayHello();
    if(this.selected&&Date.now()-this.last>this.retryAfter)this.loadCity(this.selected,this.auto);
  }
  showPanel(open) {
    this.panel.hidden=!open;this.toggle.setAttribute('aria-expanded',String(open));
    if(open){this.input.focus();if(!this.options.childElementCount)this.search('');}
    else this.toggle.focus();
  }
  async search(q) {
    const turn=++this.searchSequence;
    this.note.textContent='正在查找城市…';
    try {
      const {cities}=await request({q});
      if(turn!==this.searchSequence)return;
      this.options.replaceChildren(...cities.map(city=>{
        const button=document.createElement('button');button.type='button';
        button.textContent=city.name+' · '+regions.of(city.country);
        button.onclick=()=>{try{localStorage.setItem(preference,city.id);}catch{} this.showPanel(false);this.loadCity(city.id,false);};
        return button;
      }));
      this.note.textContent=cities.length?'':'没有找到，可换用城市的当地名称。';
    } catch {if(turn===this.searchSequence)this.note.textContent='城市列表暂时无法读取，请稍后再试。';}
  }
  locate(explicit) {
    const turn=++this.sequence;
    this.searchSequence++;
    const fail=()=>{if(turn!==this.sequence)return;
      if(explicit&&this.panel.hidden)this.showPanel(true);
      this.note.textContent='未能定位，请搜索并选择城市。';
      if(!this.city)this.weather.textContent='请选择城市查看天气';
    };
    if(!navigator.geolocation){fail();return;}
    this.note.textContent='正在定位城市…';if(!this.city)this.weather.textContent='正在定位城市…';
    navigator.geolocation.getCurrentPosition(async({coords})=>{
      try {
        if(turn!==this.sequence)return;
        const {city}=await request({lat:coords.latitude.toFixed(1),lon:coords.longitude.toFixed(1)});
        if(turn!==this.sequence)return;
        if(!city){fail();return;}
        try{localStorage.removeItem(preference);}catch{}
        if(explicit&&!this.panel.hidden)this.showPanel(false);
        this.loadCity(city.id,true);
      } catch {fail();}
    },fail,{enableHighAccuracy:false,maximumAge:300000,timeout:8000});
  }
  async loadCity(id,auto) {
    const turn=++this.sequence;
    const previous=this.city?.id===id;
    this.selected=id;this.auto=auto;this.retryAfter=1800000;
    if(!previous){this.city=null;this.weather.textContent='正在读取城市天气…';this.sayHello();}
    this.last=Date.now();
    try {
      const {city,weather}=await request({city:id});
      if(turn!==this.sequence)return;
      this.city=city;this.quick.hidden=true;this.retryAfter=weather?1800000:300000;this.toggle.textContent='切换城市';
      this.sayHello();
      const prefix=city.name+(auto?'附近':'')+' · ';
      if(!weather){this.weather.textContent=prefix+'天气暂不可用';return;}
      const time=new Intl.DateTimeFormat('zh-CN',{hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZone:city.zone}).format(weather.time);
      this.weather.textContent=prefix+[weatherWords(weather.symbol),Math.round(weather.temperature)+'°C',time+(weather.stale?' 缓存预报':' 小时预报')].filter(Boolean).join(' ');
    } catch {
      if(turn!==this.sequence)return;
      this.retryAfter=300000;
      this.weather.textContent=(this.city?this.city.name+' · ':'')+'天气暂不可用';
    }
  }
}
class WorkplaceDaily extends HTMLElement {
  connectedCallback(){(this.shadowRoot||this.attachShadow({mode:'open'})).textContent=dailyGreeting();}
}
if(!customElements.get('workplace-daily'))customElements.define('workplace-daily',WorkplaceDaily);
if(!customElements.get('workplace-welcome'))customElements.define('workplace-welcome',WorkplaceWelcome);
