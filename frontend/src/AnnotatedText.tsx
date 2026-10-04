import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Underline, Eraser, X } from "lucide-react";
import { RichText } from "./RichText";
import { api, json, type Note } from "./api";
import { decorate, clearDecorations, selectedRange, type Annotation, type MarkColor } from "./annotations";

const StableText = memo(RichText);
type Pick = { start: number; end: number; quote: string; x: number; y: number };
const colors: MarkColor[] = ["yellow", "green", "blue", "pink"];

export function AnnotatedText({body, note, epoch, enabled}: {body: string; note: Note; epoch: string; enabled: boolean}) {
  const root=useRef<HTMLDivElement>(null);
  const toolbar=useRef<HTMLDivElement>(null);
  const [marks,setMarks]=useState<Annotation[]>([]);
  const [pick,setPick]=useState<Pick|null>(null);
  const [saving,setSaving]=useState(false);
  const [message,setMessage]=useState("");
  const [visible,setVisible]=useState(false);
  const alive=useRef(true);
  const request=useRef(false);
  const mutation=useRef(0);
  const selected=useRef<Pick|null>(null);
  selected.current=pick;
  const path=`/slides/${note.slide_id}/notes/${note.kind}/annotations`;
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if (!root.current) return;
    if (!window.IntersectionObserver) {setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>setVisible(entries.some(e=>e.isIntersecting)),{rootMargin:'120px'});
    observer.observe(root.current);
    return ()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if (!visible || !enabled) return;
    let stopped=false;
    const refresh=async()=>{
      if(request.current || window.getSelection()?.toString()) return;
      const generation=mutation.current;
      try {
        const result=await api<Annotation[]>(`${path}?revision=${note.revision}&epoch_id=${encodeURIComponent(epoch)}`);
        if(!stopped && !request.current && generation===mutation.current && Array.isArray(result)) setMarks(previous=>JSON.stringify(previous)===JSON.stringify(result)?previous:result);
      } catch { /* Selecting text retries loading and exposes any error before saving. */ }
    };
    void refresh();
    const timer=setInterval(()=>void refresh(),5000);
    return ()=>{stopped=true;clearInterval(timer);};
  },[path,note.revision,epoch,enabled,visible]);
  useLayoutEffect(()=>{
    if(root.current) decorate(root.current,marks);
    return ()=>{if(root.current) clearDecorations(root.current);};
  },[marks,body]);
  useEffect(()=>{
    const select=()=>{
      if(!root.current || !enabled || request.current) return;
      const selection=window.getSelection();
      const value=selectedRange(root.current,selection);
      if(!value){setPick(null);return;}
      const rect=value.range.getBoundingClientRect();
      const width=Math.min(310,window.innerWidth-16);
      setPick({start:value.start,end:value.end,quote:value.quote,
        x:Math.max(8,Math.min(window.innerWidth-width-8,rect.left+rect.width/2-width/2)),
        y:Math.max(8,Math.min(window.innerHeight-100,rect.top>70?rect.top-56:rect.bottom+8))});
      setMessage("");
    };
    const pointer=(event:PointerEvent)=>{if(!toolbar.current?.contains(event.target as Node)) select();};
    const keyboard=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){setPick(null);return;}
      if(event.shiftKey && event.key.startsWith('Arrow')) select();
    };
    const tab=(event:KeyboardEvent)=>{
      if(event.key==='Tab' && selected.current && !toolbar.current?.contains(document.activeElement)){
        event.preventDefault();event.stopPropagation();toolbar.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }
    };
    const hide=()=>setPick(null);
    document.addEventListener('pointerup',pointer);
    document.addEventListener('keyup',keyboard);
    document.addEventListener('keydown',tab,true);
    window.addEventListener('resize',hide);
    document.addEventListener('scroll',hide,true);
    return ()=>{document.removeEventListener('pointerup',pointer);document.removeEventListener('keyup',keyboard);document.removeEventListener('keydown',tab,true);window.removeEventListener('resize',hide);document.removeEventListener('scroll',hide,true);};
  },[enabled]);
  async function mark(style:'highlight'|'underline', color:MarkColor='yellow', action:'mark'|'clear'='mark'){
    if(!pick || request.current) return;
    request.current=true;mutation.current++;setSaving(true);setMessage('Saving marking…');
    try{
      const result=await api<Annotation[]>(path,json('POST',{...pick,style,color,action,revision:note.revision,epoch}));
      if(alive.current){setMarks(result);setMessage('Marking saved');}
      window.getSelection()?.removeAllRanges();
      // Keep the range so underline can be added to the same highlighted words.
    }catch(error){if(alive.current)setMessage((error as Error).message);}
    finally{request.current=false;if(alive.current)setSaving(false);}
  }
  return <>
    <div ref={root} className="annotatable-text" data-note-kind={note.kind}><StableText body={body}/></div>
    {pick && createPortal(<div ref={toolbar} role="toolbar" aria-label="Selected text formatting" className="selection-toolbar" style={{left:pick.x,top:pick.y,width:'min(310px, calc(100vw - 16px))'}} onPointerDown={e=>e.preventDefault()} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setPick(null);root.current?.focus();}}}>
      <div className="selection-tools">
        {colors.map(color=><button key={color} disabled={saving} className={`highlight-swatch mark-${color}`} aria-label={`Highlight ${color}`} title={`Highlight ${color}`} onClick={()=>void mark('highlight',color)}/>)}
        <button disabled={saving} className="icon-button" aria-label="Underline selected text" title="Underline" onClick={()=>void mark('underline')}><Underline size={18}/></button>
        <button disabled={saving} className="icon-button" aria-label="Remove markings touching selected text" title="Remove markings touching this selection" onClick={()=>void mark('highlight','yellow','clear')}><Eraser size={18}/></button>
        <button className="icon-button" aria-label="Close text formatting" onClick={()=>setPick(null)}><X size={17}/></button>
      </div>
      {message && <small role="status">{message}</small>}
    </div>,document.body)}
  </>;
}
