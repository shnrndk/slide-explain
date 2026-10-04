import {useEffect, type RefObject} from 'react';
import {api,json,type FullDocument} from './api';

/** Save a slide-relative anchor; it remains meaningful when images or text reflow. */
export function useReadingPosition(content:RefObject<HTMLDivElement|null>,doc:FullDocument|null){
 const id=doc?.id,epoch=doc?.epoch;
 useEffect(()=>{
  const scroller=content.current;
  if(!scroller||!id||!epoch)return;
  let stopped=false,ready=false,touched=false,timer:ReturnType<typeof setTimeout>|undefined;
  let anchor:{page:number;fraction:number}|null=null;
  const measure=()=>{
   const top=scroller.getBoundingClientRect().top;
   const row=Array.from(scroller.querySelectorAll<HTMLElement>('.slide-row')).find(r=>r.getBoundingClientRect().bottom>top+1);
   if(!row)return null;
   const bounds=row.getBoundingClientRect();
   return {page:Number(row.id.replace('slide-','')),fraction:Math.max(0,Math.min(1,(top-bounds.top)/Math.max(1,bounds.height)))};
  };
  const save=()=>{
   if(!ready||!anchor)return;
   void api(`/documents/${id}/reading-position`,{...json('PUT',{...anchor,epoch}),keepalive:true}).catch(()=>{});
  };
  const scroll=()=>{if(!ready)return;anchor=measure();clearTimeout(timer);timer=setTimeout(save,400);};
  const touch=()=>{touched=true;};
  const onHide=()=>{if(document.visibilityState==='hidden')save();};
  scroller.addEventListener('scroll',scroll);scroller.addEventListener('wheel',touch,{passive:true});scroller.addEventListener('pointerdown',touch);
  document.addEventListener('visibilitychange',onHide);window.addEventListener('pagehide',save);window.addEventListener('blur',save);
  void api<{page:number;fraction:number}|null>(`/documents/${id}/reading-position`).then(saved=>{
   if(stopped)return;
   if(saved&&!touched){const row=scroller.querySelector<HTMLElement>(`#slide-${saved.page}`);if(row){const bounds=row.getBoundingClientRect();scroller.scrollTo({top:scroller.scrollTop+bounds.top-scroller.getBoundingClientRect().top+saved.fraction*bounds.height,behavior:'instant'});}}
   ready=true;anchor=measure();save();
  }).catch(()=>{if(!stopped){ready=true;anchor=measure();}});
  return()=>{stopped=true;clearTimeout(timer);save();scroller.removeEventListener('scroll',scroll);scroller.removeEventListener('wheel',touch);scroller.removeEventListener('pointerdown',touch);document.removeEventListener('visibilitychange',onHide);window.removeEventListener('pagehide',save);window.removeEventListener('blur',save);};
 },[id,epoch,content]);
}
