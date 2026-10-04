import { useEffect, useRef } from "react";
import { X, Sparkles, Loader2, RotateCcw } from "lucide-react";
import { Editor } from "./Editor";
import type { Slide, Job } from "./api";

export function DetailDialog({slide, epoch, job, paused, busy, onClose, onGenerate, onSaved}: {
  slide: Slide; epoch: string; job?: Job; paused: boolean; busy: boolean;
  onClose: () => void; onGenerate: () => void; onSaved: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => { previous?.focus({preventScroll: true}); };
  }, []);
  const active = job?.status === "queued" || job?.status === "running";
  const saved = !!slide.detail?.body;
  return <div className="modal-backdrop detail-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="detail-title" className="modal detail-dialog" onKeyDown={e => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, a[href], input, select') || []);
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last?.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="detail-titlebar"><div><small>SLIDE {slide.page_number}</small><h2 id="detail-title">A closer look</h2></div><button className="icon-button" aria-label="Close detailed explanation" onClick={onClose}><X size={20}/></button></div>
      <p className="detail-description">A deeper, step-by-step explanation. Saved with this slide and included in backups.</p>
      <div className="detail-actions">
        <button className="button primary" disabled={active || busy} onClick={onGenerate}>
          {active ? <Loader2 size={16} className="spin"/> : saved ? <RotateCcw size={16}/> : <Sparkles size={16}/>}
          {job?.status === "running" ? "Explaining in detail…" : job?.status === "queued" ? paused ? "Queue paused" : "Queued…" : saved ? "Regenerate details" : job ? "Retry detailed explanation" : "Explain in detail"}
        </button>
        {active && <span role="status">You can close this view while it works.</span>}
      </div>
      {job?.error && <p role="status" className="inline-error">{job.error}</p>}
      {paused && job?.status === "queued" && <p>Resume generation from the document toolbar to continue.</p>}
      {slide.detail && (saved || !active) && <Editor key={`${slide.id}:detail:${epoch}`} note={slide.detail} epoch={epoch} onSaved={onSaved}/>}
      {!saved && active && <div className="detail-wait"><Loader2 className="spin" size={26}/><p role="status">{job?.status === "queued" ? paused ? "Waiting for the queue to resume." : "Waiting for a generation slot. Detailed explanations run before queued bulk slides; requests already running finish first." : "Generating a more detailed explanation. High reasoning can take several minutes; you can close this view and return later."}</p></div>}
    </div>
  </div>;
}
