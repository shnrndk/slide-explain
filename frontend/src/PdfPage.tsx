import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, json, type Slide } from './api';
import { selectedRange, type Annotation, type MarkColor } from './annotations';
import { AnnotationTools } from './AnnotationTools';

type Glyph = {text:string; start:number; end:number; box:[number,number,number,number]|null; angle?:number};
type Layer = {text:string; text_hash:string; characters:Glyph[]; selectable:boolean};
type SelectionPick = {start:number; end:number; quote:string; x:number; y:number};

export function PdfPage({slide, epoch}: {slide:Pick<Slide,'id'|'page_number'|'width'|'height'>; epoch:string}) {
  const page=useRef<HTMLDivElement>(null), text=useRef<HTMLDivElement>(null), toolbar=useRef<HTMLDivElement>(null);
  const [visible,setVisible]=useState(false), [width,setWidth]=useState(0);
  const [layer,setLayer]=useState<Layer|null>(null), [marks,setMarks]=useState<Annotation[]>([]);
  const [pick,setPick]=useState<SelectionPick|null>(null), [saving,setSaving]=useState(false), [message,setMessage]=useState('');
  const [error,setError]=useState(''), [retry,setRetry]=useState(0);
  const request=useRef(false), mutation=useRef(0);
  const path=`/slides/${slide.id}`;
  useEffect(()=>{
    if(!page.current)return;
    if(!window.IntersectionObserver){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{setVisible(entries.some(e=>e.isIntersecting));},{rootMargin:'200px'});
    observer.observe(page.current);return ()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if(!page.current)return;
    const measure=()=>setWidth(page.current!.getBoundingClientRect().width);
    measure();
    if(!window.ResizeObserver){window.addEventListener('resize',measure);return()=>window.removeEventListener('resize',measure);}
    const observer=new ResizeObserver(measure);observer.observe(page.current);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if(!visible||layer)return;
    let stopped=false;
    setError('');
    void Promise.all([api<Layer>(`${path}/text-layer?epoch_id=${encodeURIComponent(epoch)}`),api<Annotation[]>(`${path}/pdf-annotations?epoch_id=${encodeURIComponent(epoch)}`)])
      .then(([next,annotations])=>{if(!stopped){setLayer(next);setMarks(annotations);}})
      .catch(e=>{if(!stopped)setError((e as Error).message);});
    return()=>{stopped=true;};
  },[path,epoch,visible,retry,layer]);
  useEffect(()=>{
    if(!visible||!layer)return;
    let stopped=false;
    const refresh=async()=>{
      if(request.current||window.getSelection()?.toString())return;
      const generation=mutation.current;
      try{
        const result=await api<Annotation[]>(`${path}/pdf-annotations?epoch_id=${encodeURIComponent(epoch)}`);
        if(!stopped&&!request.current&&generation===mutation.current)setMarks(result);
      }catch{/* Keep saved markings visible during an offline interval. */}
    };
    const timer=setInterval(()=>void refresh(),5000);
    return()=>{stopped=true;clearInterval(timer);};
  },[path,epoch,visible,layer]);
  useEffect(()=>{
    if(!visible||!layer)return;
    const select=(event:Event)=>{
      if(toolbar.current?.contains(event.target as Node)||request.current)return;
      if(!text.current||!layer?.selectable)return;
      const value=selectedRange(text.current,window.getSelection());
      if(!value){setPick(null);return;}
      const rect=value.range.getBoundingClientRect(), menuWidth=Math.min(310,window.innerWidth-16);
      setPick({start:value.start,end:value.end,quote:value.quote,
        x:Math.max(8,Math.min(window.innerWidth-menuWidth-8,rect.left+rect.width/2-menuWidth/2)),
        y:Math.max(8,Math.min(window.innerHeight-100,rect.top>70?rect.top-56:rect.bottom+8))});setMessage('');
    };
    const keyboard=(event:KeyboardEvent)=>{if(event.shiftKey&&event.key.startsWith('Arrow'))select(event);};
    const tab=(event:KeyboardEvent)=>{if(event.key==='Tab'&&pick&&!toolbar.current?.contains(document.activeElement)){event.preventDefault();event.stopPropagation();toolbar.current?.querySelector('button')?.focus();}};
    const hide=()=>setPick(null);
    document.addEventListener('pointerup',select);document.addEventListener('scroll',hide,true);window.addEventListener('resize',hide);
    document.addEventListener('keyup',keyboard);document.addEventListener('keydown',tab,true);
    return()=>{document.removeEventListener('pointerup',select);document.removeEventListener('scroll',hide,true);window.removeEventListener('resize',hide);document.removeEventListener('keyup',keyboard);document.removeEventListener('keydown',tab,true);};
  },[layer,visible,pick]);
  async function mark(style:'highlight'|'underline',color:MarkColor='yellow',action:'mark'|'clear'='mark') {
    if(!pick||!layer||request.current)return;
    request.current=true;mutation.current++;setSaving(true);setMessage('Saving marking…');
    try{
      const result=await api<Annotation[]>(`${path}/pdf-annotations`,json('POST',{start:pick.start,end:pick.end,quote:pick.quote,style,color,action,text_hash:layer.text_hash,epoch}));
      setMarks(result);setMessage('Marking saved');window.getSelection()?.removeAllRanges();
    }catch(e){setMessage((e as Error).message);}
    finally{request.current=false;setSaving(false);}
  }
  const valid=marks.filter(m=>layer && layer.text.slice(m.start_offset,m.end_offset)===m.quote);
  return <><div ref={page} className="pdf-page slide-image-button" onClick={e=>e.stopPropagation()} onKeyDown={e=>{
    if(e.key==='Escape'&&pick){e.stopPropagation();setPick(null);}
    if(e.key==='Tab'&&pick){e.preventDefault();toolbar.current?.querySelector('button')?.focus();}
  }}>
    <img loading="lazy" draggable={false} src={`/api/slides/${slide.id}/image`} alt={`Slide ${slide.page_number}`} width={slide.width} height={slide.height}/>
    <svg className="pdf-mark-layer" viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-hidden="true">
      {visible&&valid.flatMap(m=>layer!.characters.filter(c=>c.box && c.start<m.end_offset && c.end>m.start_offset).map(c=>{
        const [x,y,w,h]=c.box!;
        const side=((Math.round((c.angle||0)/90)%4)+4)%4;
        const line=side===1?[x,y,x,y+h]:side===2?[x,y,x+w,y]:side===3?[x+w,y,x+w,y+h]:[x,y+h,x+w,y+h];
        return m.style==='highlight'?<rect key={`${m.id}:${c.start}`} className={`pdf-highlight pdf-mark-${m.color}`} x={x*1000} y={y*1000} width={w*1000} height={h*1000}/>:<line key={`${m.id}:${c.start}`} className="pdf-underline" x1={line[0]*1000} x2={line[2]*1000} y1={line[1]*1000} y2={line[3]*1000} vectorEffect="non-scaling-stroke"/>;
      }))}
    </svg>
    <div ref={text} className="pdf-text-layer" aria-label={`Selectable text of slide ${slide.page_number}`}>
      {visible&&layer?.characters.map(c=><span key={c.start} style={c.box?{left:`${c.box[0]*100}%`,top:`${c.box[1]*100}%`,width:`${c.box[2]*100}%`,height:`${c.box[3]*100}%`,fontSize:`${Math.max(1,width*c.box[3]*slide.height/slide.width)}px`}:{left:0,top:0,width:0,height:0,fontSize:'1px',pointerEvents:'none'}}>{c.text}</span>)}
    </div>
  </div>
  {error?<p className="pdf-text-status" role="status">Text selection unavailable: {error} <button onClick={()=>setRetry(v=>v+1)}>Retry</button></p>:layer&&!layer.selectable?<p className="pdf-text-status">No selectable text on this page. Scanned pages need OCR.</p>:null}
  {pick&&createPortal(<div ref={toolbar} className="selection-toolbar pdf-selection-toolbar" role="toolbar" aria-label="Selected PDF text formatting" style={{left:pick.x,top:pick.y,width:'min(310px, calc(100vw - 16px))'}} onClick={e=>e.stopPropagation()} onPointerDown={e=>e.preventDefault()} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setPick(null);}}}>
    <AnnotationTools saving={saving} message={message} onMark={(style,color)=>void mark(style,color)} onClear={()=>void mark('highlight','yellow','clear')} onClose={()=>setPick(null)}/>
  </div>,document.body)}
  </>;
}
