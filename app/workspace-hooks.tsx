"use client";
import {createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';
import {readWorkspaceRoute,workspaceUrl,draftKey,readDraft,writeDraft} from '../lib/workspace-model.mjs';
type Route=ReturnType<typeof readWorkspaceRoute>;
const Guard=createContext({register:(_id:symbol,_dirty:boolean)=>{},remove:(_id:symbol)=>{},hasDirty:():boolean=>false,confirm:():boolean=>true});
export function WorkspaceGuard({children}:{children:React.ReactNode}){
  const pending=useRef(new Set<symbol>()),approved=useRef(false);
  const [value]=useState(()=>({register:(id:symbol,dirty:boolean)=>{if(dirty)pending.current.add(id);else pending.current.delete(id);},remove:(id:symbol)=>{pending.current.delete(id);},hasDirty:()=>pending.current.size>0,confirm:()=>{if(approved.current||!pending.current.size)return true;const ok=window.confirm(document.querySelector('.app-shell')?.getAttribute('lang')==='id'?'Ada isian yang belum dikirim. Draf pesanan tersimpan di perangkat; isian lain yang belum disimpan dapat hilang. Tetap keluar?':'有尚未提交的内容。订单申请草稿会保存在本机，其他未保存内容可能丢失，是否离开？');if(ok){approved.current=true;queueMicrotask(()=>{approved.current=false;});}return ok;}}));
  useEffect(()=>{const before=(e:BeforeUnloadEvent)=>{if(pending.current.size){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[]);
  return <Guard.Provider value={value}>{children}</Guard.Provider>;
}
export function useDirtyGuard(dirty:boolean){const guard=useContext(Guard),id=useRef(Symbol());useEffect(()=>{guard.register(id.current,dirty);return()=>guard.remove(id.current);},[guard,dirty]);return guard.confirm;}
export function useWorkspaceRoute(){
  const [route,setRoute]=useState<Route>(()=>readWorkspaceRoute(typeof window==='undefined'?'':window.location.search));
  const latest=useRef(route);latest.current=route;const guard=useContext(Guard);
  const navigate=useCallback((next:Partial<Route>,replace=false)=>{
    const value={...latest.current,...next};
    if(['page','entity','view','month'].some(k=>value[k as keyof Route]!==latest.current[k as keyof Route])&&!guard.confirm())return false;
    const url=workspaceUrl(value);if(url!==window.location.pathname+window.location.search)window.history[replace?'replaceState':'pushState'](null,'',url);
    latest.current=value;setRoute(value);return true;
  },[guard]);
  useEffect(()=>{const pop=()=>{if(!guard.confirm()){window.history.pushState(null,'',workspaceUrl(latest.current));return;}setRoute(readWorkspaceRoute(window.location.search));};window.addEventListener('popstate',pop);return()=>window.removeEventListener('popstate',pop);},[guard]);
  return {route,navigate};
}
export function useVisibleRefresh(refresh:()=>Promise<unknown>,interval=15000,enabled=true,skipDirty=false){
  const guard=useContext(Guard);
  const action=useRef(refresh);action.current=refresh;
  useEffect(()=>{if(!enabled)return;let running=false,disposed=false;const run=async()=>{if(running||disposed||document.visibilityState!=='visible'||skipDirty&&guard.hasDirty())return;running=true;try{await action.current();}catch{}finally{running=false;}};const timer=window.setInterval(run,interval);window.addEventListener('focus',run);document.addEventListener('visibilitychange',run);return()=>{disposed=true;clearInterval(timer);window.removeEventListener('focus',run);document.removeEventListener('visibilitychange',run);};},[interval,enabled,skipDirty,guard]);
}
export function useLocalDraft<T>(actor:string,key:string,initial:()=>T,valid:(value:unknown)=>boolean=()=>true){
  const [value,setValue]=useState<T>(()=>{try{const stored=typeof window==='undefined'?null:readDraft(localStorage,actor,key);return stored&&valid(stored)?stored:initial();}catch{return initial();}});
  const [saved,setSaved]=useState(''),[error,setError]=useState('');const cleared=useRef(false);
  useEffect(()=>{if(cleared.current)return;try{writeDraft(localStorage,actor,key,value);setSaved(new Date().toLocaleTimeString());setError('');}catch{setError('浏览器未能保存本机草稿，请保持页面打开并尽快提交。');}},[actor,key,value]);
  const clear=()=>{cleared.current=true;try{localStorage.removeItem(draftKey(actor,key));}catch{}};
  return {value,setValue,saved,error,clear};
}
