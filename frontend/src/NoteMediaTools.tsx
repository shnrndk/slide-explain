import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { ImagePlus, Link, Workflow } from 'lucide-react';
import { api } from './api';
import { youtubeId } from './NoteMedia';

const templates: Record<string,string> = {
  Flowchart:'flowchart TD\n  A[Start] --> B{Question?}\n  B -->|Yes| C[Next step]\n  B -->|No| D[Try again]',
  Sequence:'sequenceDiagram\n  participant Student\n  participant System\n  Student->>System: Request\n  System-->>Student: Response',
  'Mind map':'mindmap\n  root((Main idea))\n    Definition\n    Example\n    Takeaway',
  'Class diagram':'classDiagram\n  class Notebook {\n    +name\n    +addNote()\n  }\n  Notebook "1" --> "many" Note',
  'State diagram':'stateDiagram-v2\n  [*] --> Ready\n  Ready --> Learning\n  Learning --> Ready',
  'ER diagram':'erDiagram\n  NOTEBOOK ||--o{ NOTE : contains\n  NOTE {\n    string title\n    string content\n  }',
};
type Asset = {id:string; url:string; original_name:string};
export const escapeLabel = (text:string)=>text.replace(/[\r\n]/g,' ').replace(/([\\[\]])/g,'\\$1');

export function NoteMediaTools({slideId, epoch, insert, children}: {
  slideId:string; epoch:string; insert:(text:string)=>void;
  children:(events:{onPaste:(e:ClipboardEvent<HTMLTextAreaElement>)=>void; onDrop:(e:DragEvent<HTMLTextAreaElement>)=>void; onDragOver:(e:DragEvent<HTMLTextAreaElement>)=>void})=>React.ReactNode;
}) {
  const input=useRef<HTMLInputElement>(null), alive=useRef(true), uploading=useRef(false);
  const [busy,setBusy]=useState(false), [message,setMessage]=useState('');
  const [video,setVideo]=useState(false), [link,setLink]=useState(''), [diagram,setDiagram]=useState(false);
  const [assets,setAssets]=useState<Asset[]|null>(null);
  const pending=useRef<{file:File; id:string}|null>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!busy)return;
    const warn=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};
    window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
  },[busy]);
  async function upload(file:File, retry=false) {
    if(uploading.current)return;
    if(file.size>15*1024*1024){setMessage('Choose an image of 15 MB or smaller.');return;}
    if(!retry)pending.current={file,id:crypto.randomUUID().replaceAll('-','')};
    uploading.current=true;setBusy(true);setMessage('Saving image…');
    try {
      const form=new FormData();form.append('file',file);form.append('epoch_id',epoch);form.append('asset_id',pending.current!.id);
      const asset=await api<Asset>(`/slides/${slideId}/note-assets`,{method:'POST',body:form});
      if(alive.current){insert(`![${escapeLabel(asset.original_name || 'Note image')}](${asset.url})`);setMessage('Image stored locally. Save the note to keep its placement.');setAssets(null);}
      pending.current=null;
    } catch(e){if(alive.current)setMessage((e as Error).message);}
    finally{uploading.current=false;if(alive.current)setBusy(false);}
  }
  async function savedImages() {
    if(assets){setAssets(null);return;}
    try{setAssets(await api<Asset[]>(`/slides/${slideId}/note-assets?epoch_id=${encodeURIComponent(epoch)}`));}
    catch(e){setMessage((e as Error).message);}
  }
  const events={
    onPaste:(e:ClipboardEvent<HTMLTextAreaElement>)=>{
      const file=Array.from(e.clipboardData.files).find(f=>f.type.startsWith('image/'));
      if(file){e.preventDefault();void upload(file);}
    },
    onDrop:(e:DragEvent<HTMLTextAreaElement>)=>{
      const file=Array.from(e.dataTransfer.files).find(f=>f.type.startsWith('image/'));
      if(file){e.preventDefault();void upload(file);}
    },
    onDragOver:(e:DragEvent<HTMLTextAreaElement>)=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();},
  };
  return <>
    <div className="note-media-tools" role="toolbar" aria-label="Insert into personal notes">
      <button type="button" disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>input.current?.click()}><ImagePlus size={14}/> Image</button>
      <button type="button" disabled={busy} onMouseDown={e=>e.preventDefault()} onClick={()=>void savedImages()}>Saved images</button>
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>{setVideo(!video);setDiagram(false);}}><Link size={14}/> YouTube / link</button>
      <button type="button" onMouseDown={e=>e.preventDefault()} onClick={()=>{setDiagram(!diagram);setVideo(false);}}><Workflow size={14}/> Diagram</button>
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif" aria-label="Choose note image" onChange={e=>{if(e.target.files?.[0])void upload(e.target.files[0]);e.target.value='';}}/>
    </div>
    {video && <div className="note-insert-panel">
      <input aria-label="Video or website URL" type="url" placeholder="Paste a YouTube or website link" value={link} onChange={e=>setLink(e.target.value)}/>
      <button type="button" onClick={()=>{
        try {const url=new URL(link.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error();
          insert(`[${youtubeId(url.href)?'YouTube video':'Related link'}](<${url.href.replaceAll('>','%3E').replaceAll('<','%3C')}>)`);setVideo(false);setLink('');setMessage('Link added. Videos play online; the link is included in backups.');
        } catch {setMessage('Enter a complete http or https URL.');}
      }}>Add link</button>
    </div>}
    {diagram && <div className="note-insert-panel diagram-templates">
      <span>Choose a starting diagram, then edit its Mermaid source below.</span>
      {Object.entries(templates).map(([name,source])=><button key={name} type="button" onClick={()=>{insert(`\`\`\`mermaid\n${source}\n\`\`\``);setDiagram(false);}}>{name}</button>)}
    </div>}
    {assets && <div className="note-insert-panel saved-note-images">{assets.length?assets.map(asset=><button key={asset.id} type="button" onClick={()=>{insert(`![${escapeLabel(asset.original_name)}](${asset.url})`);setAssets(null);}}><img src={asset.url} alt=""/>{asset.original_name}</button>):<span>No saved images on this slide yet.</span>}</div>}
    {message && <small role="status" className={`note-media-status ${busy?'save-state saving':''}`}>{message}{!busy&&pending.current&&<button type="button" onClick={()=>void upload(pending.current!.file,true)}>Retry image upload</button>}</small>}
    {children(events)}
  </>;
}
