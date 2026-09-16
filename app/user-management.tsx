"use client";

import {useEffect,useRef,useState,type ReactNode} from "react";

const ROLES=["管理员","销售","运营","运营主管","新品开发","财务","供应链","工厂","海运"];
const SITES=["马来西亚","印尼","泰国","越南","菲律宾"];
const CHANNELS=["TikTok","Shopee"];

export type ManagedUser={id:string;name:string;email:string;role:string;site:string|null;channel:string|null;responsibility_unit:string|null;active:number|boolean};
type Draft={role:string;site:string;channel:string;responsibility_unit:string;active:boolean};
type CreateDraft={name:string;email:string;password:string;confirmPassword:string;role:string;site:string;channel:string;responsibilityUnit:string;active:boolean};
type Props={users:ManagedUser[];actorId:string;busy:boolean;onCreated:()=>Promise<void>;act:(action:string,payload:Record<string,unknown>,success:string)=>Promise<unknown>};
const emptyForm=():CreateDraft=>({name:"",email:"",password:"",confirmPassword:"",role:"运营",site:"",channel:"",responsibilityUnit:"",active:true});
const userDraft=(user:ManagedUser):Draft=>({role:user.role,site:user.site||"",channel:user.channel||"",responsibility_unit:user.responsibility_unit||"",active:Number(user.active)===1});

function Field({label,children}:{label:string;children:ReactNode}){
  return <div className="field"><label>{label}{children}</label></div>;
}

export default function UserManagement({users,actorId,busy,act,onCreated}:Props){
  const [canCreate,setCanCreate]=useState<boolean|null>(null);
  const [loadError,setLoadError]=useState("");
  const [retry,setRetry]=useState(0);
  const [creating,setCreating]=useState(false);
  const [saving,setSaving]=useState(false);
  const pending=useRef(false);
  const [form,setForm]=useState<CreateDraft>(emptyForm);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [drafts,setDrafts]=useState<Record<string,Draft>>({});

  useEffect(()=>{
    let current=true;
    fetch("/api/users",{cache:"no-store"}).then(async response=>{
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||"无法读取账号管理功能");
      if(current){setCanCreate(result.canCreate===true);setLoadError("");}
    }).catch(reason=>{if(current)setLoadError(reason instanceof Error?reason.message:"无法读取账号管理功能");});
    return ()=>{current=false;};
  },[retry]);

  const updateForm=<K extends keyof CreateDraft>(key:K,value:CreateDraft[K])=>setForm(previous=>({...previous,[key]:value}));
  const closeForm=()=>{setCreating(false);setForm(emptyForm());setError("");};
  const create=async(event:React.FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    if(pending.current)return;
    setError("");setMessage("");
    const {confirmPassword,...payload}=form;
    if(form.password!==confirmPassword){setError("两次输入的密码不一致，请重新确认");return;}
    pending.current=true;setSaving(true);
    try{
      const response=await fetch("/api/users",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      const result=await response.json().catch(()=>({error:"服务器响应异常，请刷新成员列表确认是否已创建"}));
      if(!response.ok)throw new Error(result.error||"新增用户失败");
      const success=form.active?`已创建 ${form.name.trim()}，该用户可以使用邮箱和初始密码登录。`:`已创建 ${form.name.trim()}，账号目前停用，启用后才可登录。`;
      closeForm();setMessage(success);
      try{await onCreated();}catch{setMessage(`${success} 成员列表刷新失败，请刷新页面查看；无需重复创建。`);}
    }catch(reason){setError(reason instanceof Error?reason.message:"新增用户失败，请稍后重试");}
    finally{pending.current=false;setSaving(false);}
  };
  const update=(user:ManagedUser,patch:Partial<Draft>)=>setDrafts(previous=>({...previous,[user.id]:{...(previous[user.id]||userDraft(user)),...patch}}));
  const save=async(user:ManagedUser)=>{
    const draft=drafts[user.id]||userDraft(user);
    const result=await act("assignUser",{userId:user.id,...draft,responsibilityUnit:draft.responsibility_unit},"账号权限已更新");
    if(result)setDrafts(previous=>{const next={...previous};delete next[user.id];return next;});
  };

  return <>
    <div className="page-head">
      <div><h3>用户管理</h3><p>新增成员、分配岗位和管理站点渠道权限</p></div>
      {canCreate&&<button className="btn primary" disabled={busy||saving} aria-expanded={creating} aria-controls="create-user-form" onClick={()=>{if(creating)closeForm();else{setCreating(true);setMessage("");}}}>{creating?"收起表单":"＋ 新增用户"}</button>}
    </div>
    {loadError?<div className="notice error" role="alert">{loadError} <button className="btn" onClick={()=>setRetry(value=>value+1)}>重试</button></div>:canCreate===null?<div className="notice info" role="status">正在读取账号管理功能…</div>:<div className="notice info">{canCreate?"管理员可直接创建公司账号，创建后使用邮箱和初始密码登录。":"当前使用 ChatGPT 登录；请让成员先登录一次系统，再在此分配权限。"} 运营必须绑定站点和渠道；销售自动绑定印尼线下分销。</div>}
    {message&&<div className="notice info" role="status">{message}</div>}
    {creating&&canCreate&&<section className="panel" id="create-user-form" aria-labelledby="create-user-title">
      <div className="panel-head"><div><h4 id="create-user-title">新增用户</h4><p>填写员工资料和初始密码，带 * 的项目为必填项。</p></div></div>
      <form onSubmit={create}>
        <fieldset className="user-fields" disabled={saving||busy}>
          <div className="form-grid">
            <Field label="姓名 *"><input name="name" autoComplete="off" required maxLength={120} value={form.name} onChange={event=>updateForm("name",event.target.value)} placeholder="员工姓名"/></Field>
            <Field label="登录邮箱 *"><input name="email" type="email" autoComplete="off" required maxLength={254} value={form.email} onChange={event=>updateForm("email",event.target.value)} placeholder="name@company.com"/></Field>
            <Field label="角色 *"><select name="role" value={form.role} onChange={event=>setForm(previous=>({...previous,role:event.target.value,site:"",channel:""}))}>{ROLES.map(role=><option key={role}>{role}</option>)}</select></Field>
            <Field label="账号状态"><select value={String(form.active)} onChange={event=>updateForm("active",event.target.value==="true")}><option value="true">启用</option><option value="false">停用</option></select></Field>
            {form.role==="运营"&&<>
              <Field label="站点 *"><select required value={form.site} onChange={event=>updateForm("site",event.target.value)}><option value="">请选择站点</option>{SITES.map(site=><option key={site}>{site}</option>)}</select></Field>
              <Field label="渠道 *"><select required value={form.channel} onChange={event=>updateForm("channel",event.target.value)}><option value="">请选择渠道</option>{CHANNELS.map(channel=><option key={channel}>{channel}</option>)}</select></Field>
            </>}
            <Field label="责任单位"><input maxLength={120} value={form.responsibilityUnit} onChange={event=>updateForm("responsibilityUnit",event.target.value)} placeholder="工厂 / 承运商 / 团队（选填）"/></Field>
            <Field label="初始密码 *"><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={form.password} onChange={event=>updateForm("password",event.target.value)} aria-describedby="new-user-password-hint"/></Field>
            <Field label="确认初始密码 *"><input name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={256} value={form.confirmPassword} onChange={event=>updateForm("confirmPassword",event.target.value)}/></Field>
          </div>
          <p className="cell-note" id="new-user-password-hint">密码长度为12—256个字符。请将初始密码交给员工；创建后页面不会显示密码。</p>
          {form.role==="销售"&&<div className="notice info">销售账号的业务范围为：印尼 · 线下分销。</div>}
          {error&&<div className="notice error" role="alert">{error}</div>}
          <div className="form-actions"><button className="btn" type="button" onClick={closeForm}>取消</button><button className="btn primary" type="submit">{saving?"正在创建…":"创建用户"}</button></div>
        </fieldset>
      </form>
    </section>}
    <section className="panel" aria-labelledby="user-list-title">
      <div className="panel-head"><div><h4 id="user-list-title">成员权限</h4><p>共 {users.length} 位成员，{users.filter(user=>Number(user.active)===1).length} 位已启用</p></div></div>
      <div className="table-wrap user-table"><table><thead><tr><th>成员</th><th>邮箱</th><th>角色</th><th>站点</th><th>渠道</th><th>责任单位</th><th>状态</th><th>操作</th></tr></thead><tbody>{users.map(user=>{
        const draft=drafts[user.id]||userDraft(user),self=user.id===actorId;
        return <tr key={user.id}>
          <td><strong>{user.name}</strong>{self&&<div className="cell-note">当前账号</div>}</td><td>{user.email}</td>
          <td><select aria-label={`${user.name}的角色`} disabled={busy||saving||self} value={draft.role} onChange={event=>update(user,{role:event.target.value,site:"",channel:""})}>{ROLES.map(role=><option key={role}>{role}</option>)}</select></td>
          <td><select aria-label={`${user.name}的站点`} disabled={busy||saving||draft.role!=="运营"} value={draft.role==="销售"?"印尼":draft.site} onChange={event=>update(user,{site:event.target.value})}><option value="">{draft.role==="运营"?"请选择":"全局 / 按岗位"}</option>{SITES.map(site=><option key={site}>{site}</option>)}</select></td>
          <td><select aria-label={`${user.name}的渠道`} disabled={busy||saving||draft.role!=="运营"} value={draft.role==="销售"?"线下分销":draft.channel} onChange={event=>update(user,{channel:event.target.value})}><option value="">{draft.role==="运营"?"请选择":"按岗位"}</option>{[...CHANNELS,...(draft.role==="销售"||draft.channel==="线下分销"?["线下分销"]:[])].map(channel=><option key={channel}>{channel}</option>)}</select></td>
          <td><input aria-label={`${user.name}的责任单位`} disabled={busy||saving} maxLength={120} value={draft.responsibility_unit} onChange={event=>update(user,{responsibility_unit:event.target.value})} placeholder="工厂 / 承运商 / 团队"/></td>
          <td><select aria-label={`${user.name}的状态`} disabled={busy||saving||self} value={String(draft.active)} onChange={event=>update(user,{active:event.target.value==="true"})}><option value="true">启用</option><option value="false">停用</option></select></td>
          <td><button className="btn primary" disabled={busy||saving} onClick={()=>save(user)}>保存</button></td>
        </tr>;
      })}</tbody></table></div>
    </section>
  </>;
}
