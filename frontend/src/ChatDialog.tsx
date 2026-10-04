import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Send, Plus, Loader2 } from 'lucide-react';
import { api, json, type Slide, type Reasoning, type Note } from './api';
import { RichText } from './RichText';
import { selectedRange } from './annotations';
interface Turn {id:string; question:string; answer:string; status:string; error:string|null;}
export function ChatDialog({slide,epoch,reasoning,paused,onClose,onSaved}:{slide:Slide;epoch:string;reasoning:Reasoning;paused:boolean;onClose:()=>void;onSaved:()=>void}){
  const draftKey=`slide-notes:chat:${epoch}:${slide.id}`;
  const [question,setQuestion]=useState(()=>{try{return localStorage.getItem(draftKey)||'';}catch{return '';}});
  const [turns,setTurns]=useState<Turn[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [selection,setSelection]=useState<{text:string;turn:string;x:number;y:number}|null>(null);
  const [clipStatus,setClipStatus]=useState('');
  const panel=useRef<HTMLDivElement>(null);
  const toolbar=useRef<HTMLDivElement>(null);
  const request=useRef<{id:string;question:string}|null>(null);
  const clipRequest=useRef<{id:string;text:string;turn:string}|null>(null);
  const active=turns.some(t=>['queued','running'].includes(t.status));
  const refresh=async()=>setTurns(await api<Turn[]>(`/slides/${slide.id}/chat`));
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    panel.current?.focus();let stopped=false;
    const load=async()=>{try{const result=await api<Turn[]>(`/slides/${slide.id}/chat`);if(!stopped)setTurns(result);}catch(e){if(!stopped)setError((e as Error).message);}};
    void load();const timer=setInterval(()=>void load(),2000);
    return ()=>{stopped=true;clearInterval(timer);previous?.focus({preventScroll:true});};
  },[slide.id]);
  useEffect(()=>{
    const select=(event:PointerEvent|KeyboardEvent)=>{
      if(toolbar.current?.contains(event.target as Node))return;
      if(event instanceof KeyboardEvent && !(event.shiftKey && event.key.startsWith('Arrow')))return;
      const sel=window.getSelection();const node=sel?.anchorNode;
      const element=node?.nodeType===Node.ELEMENT_NODE?node as Element:node?.parentElement;
      const answer=element?.closest<HTMLElement>('[data-chat-answer]');
      if(!answer || !panel.current?.contains(answer)){setSelection(null);return;}
      const range=selectedRange(answer,sel||null);
      if(!range){setSelection(null);return;}
      const rect=range.range.getBoundingClientRect();
      setSelection({text:range.quote,turn:answer.dataset.chatAnswer!,x:Math.max(8,Math.min(innerWidth-240,rect.left)),y:Math.max(8,Math.min(innerHeight-80,rect.top>60?rect.top-48:rect.bottom+8))});
      setClipStatus('');
    };
    const hide=()=>setSelection(null);
    document.addEventListener('pointerup',select);document.addEventListener('keyup',select);
    document.addEventListener('scroll',hide,true);
    return ()=>{document.removeEventListener('pointerup',select);document.removeEventListener('keyup',select);document.removeEventListener('scroll',hide,true);};
  },[]);
  async function send(){
    if(busy||active||!question.trim())return;
    setBusy(true);setError('');
    if(!request.current||request.current.question!==question.trim())request.current={id:crypto.randomUUID(),question:question.trim()};
    try{
      await api(`/slides/${slide.id}/chat`,json('POST',{...request.current,reasoning,epoch}));
      request.current=null;setQuestion('');try{localStorage.removeItem(draftKey);}catch{/* The saved conversation remains on the backend. */}await refresh();
    }catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function addToNotes(){
    if(!selection||busy)return;
    setBusy(true);setClipStatus('Saving…');
    try{
      const detail=await api<{slides:Slide[]}>(`/documents/${documentId}`);
      const personal=detail.slides.find(s=>s.id===slide.id)!.personal;
      const pending=JSON.parse(localStorage.getItem(`slide-notes:draft:${epoch}:${slide.id}:personal`)||'null');
      if(pending && pending.body!==personal.body)throw new Error('Save your personal-note draft first, then add this selection.');
      if(!clipRequest.current || clipRequest.current.text!==selection.text || clipRequest.current.turn!==selection.turn)clipRequest.current={id:crypto.randomUUID(),text:selection.text,turn:selection.turn};
      await api<Note>(`/chat/${selection.turn}/notes`,json('POST',{id:clipRequest.current.id,text:selection.text.replace(/([\\`*_{}\[\]<>#+.!|~-])/g,'\\$1'),revision:personal.revision,epoch}));
      setClipStatus('Added to my notes');onSaved();
    }catch(e){setClipStatus((e as Error).message);}finally{setBusy(false);}
  }
  // Parent supplies the owning document so note appends can use the latest revision.
  const documentId=slide.document_id;
  return <div className="modal-backdrop chat-backdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="modal chat-dialog" ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Chat about slide ${slide.page_number}`} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();if(selection)setSelection(null);else onClose();}}}>
      <div className="detail-titlebar"><div><small>SLIDE {slide.page_number}</small><h2>Ask about this slide</h2></div><button className="icon-button" aria-label="Close chat" onClick={onClose}><X size={20}/></button></div>
      <p className="detail-description">Ask a question about the concepts. Select useful answer text to add it to your notes.</p>
      <div className="chat-history">
        {!turns.length&&<p className="empty-personal-note">What would you like to understand better?</p>}
        {turns.map(turn=><div className="chat-turn" key={turn.id}>
          <div className="chat-question"><small>YOU</small><p>{turn.question}</p></div>
          {turn.answer&&<div data-chat-answer={turn.id} className="chat-answer"><RichText body={turn.answer}/></div>}
          {['queued','running'].includes(turn.status)&&<p role="status" className="chat-progress"><Loader2 size={15} className="spin"/>{turn.status==='queued'?paused?'Queue paused. Resume generation in the document toolbar.':'Waiting for the next available slot…':'Thinking through your question… You can close this chat and return later.'}</p>}
          {turn.error&&<div className="inline-warning">{turn.error} <button className="text-button" disabled={busy||active} onClick={async()=>{setBusy(true);try{await api(`/chat/${turn.id}/retry`,json('POST',{epoch,revision:0}));await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>Retry</button></div>}
        </div>)}
      </div>
      {error&&<p role="alert" className="inline-warning">{error}</p>}
      <form className="chat-composer" onSubmit={e=>{e.preventDefault();void send();}}>
        <textarea aria-label="Your question" value={question} maxLength={8000} placeholder="Ask about a term, diagram, or example…" onChange={e=>{setQuestion(e.target.value);try{localStorage.setItem(draftKey,e.target.value);}catch{setError('Could not save your question draft locally. Keep this window open.');}}}/>
        <button className="button primary" disabled={busy||active||!question.trim()}><Send size={15}/> Ask</button>
      </form>
    </div>
    {selection&&createPortal(<div ref={toolbar} className="selection-toolbar chat-selection" style={{left:selection.x,top:selection.y,width:230}} onPointerDown={e=>e.preventDefault()}>
      <button className="text-button" disabled={busy} onClick={()=>void addToNotes()}><Plus size={15}/> Add to my notes</button>
      {clipStatus&&<small role="status">{clipStatus}</small>}
    </div>,document.body)}
  </div>;
}
