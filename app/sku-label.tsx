"use client";
import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import {PRODUCT_IMAGE_ROLES} from '../lib/product-images.mjs';
import {useWholesaleLanguage, type WholesaleLanguage} from './wholesale-language';
import {translateWholesale} from '../lib/wholesale-i18n.mjs';
import './sku-label.css';

type ImageIndex = Map<string, string>;
type Preview = {sku:string; src:string; language:WholesaleLanguage};
type ImageContext = {images:ImageIndex; state:'loading'|'ready'|'error'; load:(force?:boolean)=>void; open:(value:Preview)=>void};
const Context = createContext<ImageContext|null>(null);
const source = (id:string) => '/api/product-information/files?id='+encodeURIComponent(id);

export function SkuImagesProvider({role, children}:{role:string; children:ReactNode}) {
    const [images,setImages] = useState<ImageIndex>(()=>new Map()), [state,setState] = useState<ImageContext['state']>('loading');
    const [preview,setPreview] = useState<Preview|null>(null);
    const request = useRef<AbortController|null>(null), requested = useRef(false), updated = useRef(0), alive=useRef(true);
    const enabled=PRODUCT_IMAGE_ROLES.includes(role);
    const load=useCallback((force=false)=>{
        if (!enabled || request.current || requested.current && !force) return;
        requested.current=true;
        const controller=new AbortController();request.current=controller;setState('loading');
        void fetch('/api/product-images',{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])})
            .then(async response=>{
                if(!response.ok) throw Error('图片索引读取失败');
                const data=await response.json();
                if(!Array.isArray(data.images)||data.images.some((r:Record<string,unknown>)=>typeof r?.sku!=='string'||typeof r?.id!=='string'))throw Error('图片索引无效');
                if(!alive.current||controller.signal.aborted)return;
                setImages(new Map(data.images.map((r:{sku:string;id:string})=>[r.sku,r.id])));setState('ready');updated.current=Date.now();
            }).catch(()=>{if(alive.current&&!controller.signal.aborted){setImages(new Map());setState('error');}})
            .finally(()=>{if(request.current===controller)request.current=null;});
    },[enabled]);
    useEffect(()=>{
        alive.current=true;
        const refresh=()=>{if(requested.current&&document.visibilityState==='visible'&&Date.now()-updated.current>300000)load(true);};
        const changed=()=>{updated.current=0;if(requested.current)load(true);};
        window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);window.addEventListener('product-images-changed',changed);
        return()=>{alive.current=false;request.current?.abort();request.current=null;requested.current=false;window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);window.removeEventListener('product-images-changed',changed);};
    },[load]);
    const value=useMemo(()=>enabled?{images,state,load,open:setPreview}:null,[enabled,images,state,load]);
    return <Context.Provider value={value}>{children}{preview&&<ImagePreview key={preview.src} image={preview} close={()=>setPreview(null)}/>}</Context.Provider>;
}

// Exact SKU matching avoids accidentally showing another colour/size's photograph.
// In an existing clickable card, preview=false keeps valid, single-action controls.
export default function SkuLabel({sku,preview=true}:{sku:string|undefined|null;preview?:boolean}) {
    const {language,t}=useWholesaleLanguage();
    const context=useContext(Context), id=sku?context?.images.get(sku):undefined;
    const [failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
    useEffect(()=>{if(sku)context?.load();},[sku,context?.load]);
    useEffect(()=>{setFailed(false);setAttempt(0);},[id]);
    if(!sku)return <>—</>;
    if(!context)return <>{sku}</>;
    const src=id?source(id):'',error=failed||context.state==='error';
    const text=t(error?'重试':context.state==='loading'?'载入中':'待补图');
    const title=error?t(preview?'{0} 图片加载失败，点击重试':'{0} 图片暂不可用',[sku]):src?t(preview?'查看 {0} 商品大图':'{0} 商品图',[sku]):`${sku} ${text}`;
    const thumbnail=src&&!failed?<img key={id+':'+attempt} src={src} alt={t('{0} 商品图',[sku])} width={40} height={40} loading="lazy" decoding="async" onError={()=>setFailed(true)}/>:<span className="sku-photo-placeholder"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/></svg><span>{preview?text:error?t('图片异常'):text}</span></span>;
    return <span className="sku-label" data-sku={sku}>{preview&&(src||error)?<button type="button" className="sku-photo" aria-label={title} title={title} onClick={e=>{e.stopPropagation();if(error){setFailed(false);setAttempt(n=>n+1);if(context.state==='error')context.load(true);}else context.open({sku,src,language});}}>{thumbnail}</button>:<span className="sku-photo" title={title}>{thumbnail}</span>}<span className="sku-code">{sku}</span></span>;
}

function ImagePreview({image,close}:{image:Preview;close:()=>void}) {
    const t=(key:string,values:unknown[]=[])=>translateWholesale(image.language,key,values);
    const dialog=useRef<HTMLDialogElement>(null),[failed,setFailed]=useState(false),[retry,setRetry]=useState(0);
    useEffect(()=>{const el=dialog.current,previous=document.activeElement as HTMLElement|null;el?.showModal();return()=>{el?.close();if(previous?.isConnected)previous.focus();};},[]);
    return createPortal(<dialog ref={dialog} className="sku-image-dialog" aria-label={t('{0} 商品大图',[image.sku])} onCancel={e=>{e.preventDefault();close();}} onClick={e=>{if(e.target===e.currentTarget)close();}}><div className="sku-image-content"><header><strong>{image.sku}</strong><button type="button" className="btn" autoFocus onClick={close}>{t('关闭大图')}</button></header>{failed?<div className="sku-image-error">{t('图片加载失败，请重试。')}<button type="button" className="btn" onClick={()=>{setFailed(false);setRetry(n=>n+1);}}>{t('重新加载')}</button></div>:<img key={retry} src={image.src} alt={t('{0} 商品大图',[image.sku])} onError={()=>setFailed(true)}/>}</div></dialog>,document.body);
}
