"use client";
import { createContext,useContext,useEffect,useMemo,useState } from "react";
import { translateWholesale,wholesaleLanguage,wholesalePreferenceKey,wholesaleNumber,wholesaleMoney,wholesaleStamp } from "../lib/wholesale-i18n.mjs";
export type WholesaleLanguage="zh"|"id";
type Preference={language:WholesaleLanguage;setLanguage:(value:WholesaleLanguage)=>void};
export const WholesaleLanguageContext=createContext<Preference>({language:"zh",setLanguage:()=>{}});
export function useWholesalePreference(actorId:string):Preference{
  const [preference,setPreference]=useState<{actorId:string;language:WholesaleLanguage}>({actorId,language:"zh"});
  useEffect(()=>{let language:WholesaleLanguage="zh";try{language=wholesaleLanguage(localStorage.getItem(wholesalePreferenceKey(actorId)));}catch{}setPreference({actorId,language});},[actorId]);
  return {language:preference.actorId===actorId?preference.language:"zh",setLanguage:value=>{const language=wholesaleLanguage(value);setPreference({actorId,language});try{localStorage.setItem(wholesalePreferenceKey(actorId),language);}catch{}}};
}
export function useWholesaleLanguage(){
  const {language,setLanguage}=useContext(WholesaleLanguageContext);
  return useMemo(()=>({language,setLanguage,t:(key:string,values:unknown[]=[])=>translateWholesale(language,key,values),fmt:(n:unknown)=>wholesaleNumber(language,n),money:(n:unknown)=>wholesaleMoney(language,n),stamp:(s:string)=>wholesaleStamp(language,s)}),[language,setLanguage]);
}
export function WholesaleLanguageSwitch(){
  const {language,setLanguage}=useWholesaleLanguage();
  return <div className="wh-language" role="group" aria-label="中文 / Bahasa Indonesia">{([['zh','中文'],['id','Bahasa Indonesia']] as const).map(([value,label])=><button type="button" key={value} lang={value==="zh"?"zh-CN":"id"} aria-pressed={language===value} className={language===value?"active":""} onClick={()=>setLanguage(value)}>{label}</button>)}</div>;
}
