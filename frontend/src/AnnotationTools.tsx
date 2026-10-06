import { Underline, Eraser, X } from 'lucide-react';
import type { MarkColor } from './annotations';

export function AnnotationTools({saving, message, onMark, onClear, onClose}: {
  saving:boolean; message:string; onMark:(style:'highlight'|'underline', color?:MarkColor)=>void;
  onClear:()=>void; onClose:()=>void;
}) {
  return <><div className="selection-tools">
    {(['yellow','green','blue','pink'] as const).map(color=><button key={color} disabled={saving} className={`highlight-swatch mark-${color}`} aria-label={`Highlight ${color}`} title={`Highlight ${color}`} onClick={()=>onMark('highlight',color)}/>)}
    <button disabled={saving} className="icon-button" aria-label="Underline selected text" title="Underline" onClick={()=>onMark('underline')}><Underline size={18}/></button>
    <button disabled={saving} className="icon-button" aria-label="Remove markings touching selected text" title="Remove markings touching this selection" onClick={onClear}><Eraser size={18}/></button>
    <button className="icon-button" aria-label="Close text formatting" onClick={onClose}><X size={17}/></button>
  </div>{message && <small role="status">{message}</small>}</>;
}
