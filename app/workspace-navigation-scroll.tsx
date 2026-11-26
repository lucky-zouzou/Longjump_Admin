"use client";
import {useEffect,useRef,useState,type ReactNode} from "react";
import WorkspaceIcon from "./workspace-icons";

// Personal shortcuts and business groups share one viewport, including on mobile.
// Keep a visible way to scroll when the OS hides its overlay scrollbar.
export default function WorkspaceNavigationScroll({children,activeKey,query,t}:{children:ReactNode;activeKey:string;query:string;t:(key:string)=>string}) {
  const viewport=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null);
  const [overflow,setOverflow]=useState(false),[below,setBelow]=useState(false);
  const measure=()=>{const el=viewport.current;if(el){setOverflow(el.scrollHeight>el.clientHeight+2);setBelow(el.scrollHeight-el.clientHeight-el.scrollTop>2);}};
  useEffect(()=>{
    const el=viewport.current,inner=content.current;if(!el||!inner)return;
    const observer=new ResizeObserver(measure);observer.observe(el);observer.observe(inner);measure();
    return()=>observer.disconnect();
  },[]);
  useEffect(()=>{if(viewport.current)viewport.current.scrollTop=0;},[query]);
  useEffect(()=>{
    const el=viewport.current,active=content.current?.querySelector('[aria-current="page"]');if(!el||!active)return;
    if(!active.getClientRects().length)return;
    const bounds=el.getBoundingClientRect(),target=active.getBoundingClientRect();
    if(target.top<bounds.top)el.scrollTop+=target.top-bounds.top-8;
    else if(target.bottom>bounds.bottom)el.scrollTop+=target.bottom-bounds.bottom+8;
    measure();
  },[activeKey,query]);
  const browse=()=>{const el=viewport.current;if(el)el.scrollTo({top:below?el.scrollTop+Math.max(80,el.clientHeight*.8):0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});};
  return <div className="workspace-navigation-body">
    <div ref={viewport} className="workspace-navigation-scroll" onScroll={measure} tabIndex={0} aria-label={t("工作区菜单，可上下滚动")}><div ref={content} className="workspace-navigation-content">{children}</div></div>
    <div className="navigation-scroll-footer">{overflow?<button type="button" onClick={browse} className={below?"":"at-bottom"}><span>{t(below?"下方还有工作区":"返回菜单顶部")}</span><WorkspaceIcon name="chevron"/></button>:<span>{t("以上为当前岗位可用工作区")}</span>}</div>
  </div>;
}
