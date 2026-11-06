"use client";
import {useState} from "react";
import {useWholesaleLanguage} from "./wholesale-language";

type Props={customerId:string;active:boolean;version:number;refresh:()=>Promise<unknown>};
export default function DistributorLink({customerId,active,version,refresh}:Props){
  const {t}=useWholesaleLanguage();
  const [link,setLink]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false);
  const [issuedVersion,setIssuedVersion]=useState(0);
  async function update(action:"issue"|"revoke"){
    if(busy||active&&!window.confirm(t("此操作将使原链接失效，确认继续？")))return;
    setBusy(true);setMessage("");setLink("");
    try{
      const res=await fetch("/api/wholesale/distributor",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({customerId,version,action})});
      const result=await res.json();
      if(!res.ok)throw Error(result.error);
      if(result.path){setLink(new URL(result.path,window.location.origin).href);setIssuedVersion(result.version);}
      else setMessage(t("客户链接已停用"));
    }catch(error){setMessage(error instanceof Error?t(error.message):t("操作失败，请刷新后重试"));}
    finally{try{await refresh();}catch{setMessage(t("请刷新核对链接状态"));}setBusy(false);}
  }
  const visible=Boolean(link)&&version<=issuedVersion;
  return <div><button className="btn" type="button" disabled={busy} onClick={()=>update("issue")}>{t(active?"重置链接":"生成下单链接")}</button>
    {active&&<button className="btn" type="button" disabled={busy} onClick={()=>update("revoke")}>{t("停用链接")}</button>}
    {visible&&<><input readOnly aria-label={t("客户专属下单链接")} value={link} onFocus={e=>e.target.select()}/>
      <button type="button" className="btn" onClick={async()=>{try{await navigator.clipboard.writeText(link);setMessage(t("链接已复制"));}catch{setMessage(t("请选中链接手动复制"));}}}>{t("复制链接")}</button>
      <small>{t("仅发送给该客户，请妥善保存")}</small></>}
    <small role="status">{message}</small></div>;
}
