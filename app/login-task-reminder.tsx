"use client";
import {useEffect,useRef,useState} from "react";
import {claimReminder,rankedReminderTasks} from "../lib/login-task-reminder.mjs";
import Icon from "./workspace-icons";
import "./xiaopin-mascot.css";

type Task = Record<string,any>;
type Props = {scope:string;visit:string;name:string;allowed:string[];tasks:Task[];
  ready:boolean;failed:boolean;go:(page:string,task:Task)=>boolean};

// The little carry handle and satchel match Xiaopin's existing mint-green face.
function XiaopinMascot() {
  return <span className="xiaopin-mascot" aria-hidden="true">
    <span className="xiaopin-jump">
      <span className="xiaopin-figure">
        <span className="xiaopin-feet"/>
        <span className="xiaopin-arm"/>
        <span className="xiaopin-wave"><span className="xiaopin-mitten"/></span>
        <span className="xiaopin-coat"><span className="xiaopin-satchel"/></span>
        <span className="xiaopin-head"><span className="xiaopin-screen">
          <span className="xiaopin-eyes"/><span className="xiaopin-smile"/>
        </span></span>
      </span>
    </span>
  </span>;
}

export default function LoginTaskReminder({scope,visit,name,allowed,tasks,ready,failed,go}:Props) {
  const [phase,setPhase]=useState<"closed"|"open"|"leaving">("closed");
  const reopenButton=useRef<HTMLButtonElement>(null);
  const returnFocus=useRef(false);
  const closeButton=useRef<HTMLButtonElement>(null);
  const focusOnOpen=useRef(false);
  const [showAll,setShowAll]=useState(false);
  useEffect(()=>{
    if(!ready)return;
    let active=true;
    const offer=()=>{
      if(active && document.visibilityState==="visible" && claimReminder(scope,visit))setPhase("open");
    };
    const onVisible=()=>{
      if(document.visibilityState!=="visible")return;
      if(visit && navigator.locks)void navigator.locks.request("lj-login-reminder:"+visit,offer).catch(offer);
      else offer();
    };
    onVisible();
    document.addEventListener("visibilitychange",onVisible);
    return ()=>{active=false;document.removeEventListener("visibilitychange",onVisible);};
  },[scope,visit,ready]);

  useEffect(()=>{
    if(phase==="open" && focusOnOpen.current){
      focusOnOpen.current=false;
      closeButton.current?.focus({preventScroll:true});
    }
    if(phase==="leaving"){
      const timer=window.setTimeout(()=>setPhase("closed"),180);
      return ()=>window.clearTimeout(timer);
    }
    if(phase==="closed" && returnFocus.current){
      returnFocus.current=false;
      reopenButton.current?.focus({preventScroll:true});
    }
  },[phase]);

  const list=ready?rankedReminderTasks(tasks,allowed) as Task[]:[];
  const priority=list.filter(task=>task.level==="red").length;
  const openTasks=()=>{
    claimReminder(scope,visit);
    focusOnOpen.current=true;
    setShowAll(false);
    setPhase("open");
  };
  const dismiss=()=>{
    returnFocus.current=true;
    setPhase(window.matchMedia("(prefers-reduced-motion: reduce)").matches?"closed":"leaving");
  };
  const intro=priority?`有 ${priority} 项要优先跟进，先从第一件开始吧。`:
    list.length?"待办给你理好了，挑一件顺手的开始吧。":"手头的待办都清啦，按自己的节奏开工吧。";
  if(phase==="closed")return <section className="login-reminder is-closed" aria-label="小品同学的待办提醒" lang="zh-CN">
    <button ref={reopenButton} className="login-reminder-toggle" type="button" aria-expanded={false} onClick={openTasks}>
      <Icon name="business-actions"/><strong>我的待办{ready?` · ${list.length}`:""}</strong>
      <span className="login-reminder-disclosure">展开<Icon name="chevron"/></span>
    </button>
  </section>;

  return <section className={`login-reminder ${phase==="leaving"?"is-leaving":""}`} data-has-tasks={list.length>0}
    aria-label="小品同学的待办提醒" lang="zh-CN"
    onKeyDown={e=>{if(e.key==="Escape" && phase==="open"){e.stopPropagation();dismiss();}}}>
    <div className="login-reminder-greeting">
      <XiaopinMascot/>
      <div className="login-reminder-message"><strong>小品同学</strong><span className="login-reminder-caption">我的待办{ready?` · ${list.length}`:""}</span>
        <p role="status">{failed?"待办还没更新成功，可以点工作区的「重新连接」。":!ready?"稍等一下，我在核对你的待办。":`${name?name+"，":""}${intro}`}</p>
      </div>
      <button ref={closeButton} className="login-reminder-close" type="button" aria-label="关闭小品提醒" onClick={dismiss}><Icon name="close"/><span>关闭</span></button>
    </div>
    {list.length>0 && <div className="login-reminder-body" inert={phase==="leaving"}>
      <div className="overview-task-list">
        {(showAll?list:list.slice(0,3)).map((task,i)=><button className={`overview-task ${task.level}`} type="button"
          key={JSON.stringify([task.tab,task.entity,task.view,task.month,task.title,i])}
          onClick={()=>{if(go(task.tab,task)){setShowAll(false);setPhase("closed");}}}>
          <span className="task-mark"><Icon name={task.tab}/></span>
          <span className="task-copy"><strong>{task.title}</strong><span>{task.detail}</span></span>
          {task.level==="red" && <span className="task-priority">优先处理</span>}<Icon name="arrow"/>
        </button>)}
      </div>
      {list.length>3 && <button className="overview-link" type="button" aria-expanded={showAll}
        onClick={()=>setShowAll(!showAll)}>{showAll?"只看前三项":`看全部 ${list.length} 项待办`}</button>}
    </div>}
  </section>;
}
