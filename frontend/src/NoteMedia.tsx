import { useEffect, useRef, useState } from 'react';

export function youtubeId(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const pieces = url.pathname.split('/').filter(Boolean);
    const id = host === 'youtu.be' ? pieces[0]
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com'].includes(host)
        ? url.pathname === '/watch' ? url.searchParams.get('v') : ['embed', 'shorts', 'live'].includes(pieces[0]) ? pieces[1] : null
        : null;
    return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
  } catch { return null; }
}

export function NoteLink({href, children}: {href?: string; children: React.ReactNode}) {
  const [playing, setPlaying] = useState(false);
  const id = href ? youtubeId(href) : null;
  return <span className={id ? 'note-video' : undefined}>
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    {id && <>
      <button type="button" className="media-action" aria-label={playing ? 'Close YouTube video' : 'Play YouTube video'} data-label={playing ? 'Close video' : 'Play video'} onClick={()=>setPlaying(!playing)}/>
      {playing && <iframe className="note-video-player" title="YouTube video" src={`https://www.youtube-nocookie.com/embed/${id}`} referrerPolicy="strict-origin-when-cross-origin" allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen/>}
    </>}
  </span>;
}

export function NoteImage({src, alt, title}: {src?: string; alt?: string; title?: string}) {
  const [failed, setFailed] = useState(false);
  // Only managed images load automatically. External images remain links, not backups.
  const local = !!src && /^\/api\/note-assets\/[a-f0-9]{32}$/.test(src);
  if (!local) return <a href={src} target="_blank" rel="noopener noreferrer">{alt || 'Linked image'} (upload a local copy to include it in backups)</a>;
  return <span className="note-image" data-status={failed ? 'Image unavailable. Restore its attachment from a backup.' : undefined}>
    <img src={src} alt={alt || 'Note image'} title={title} loading="lazy" onError={()=>setFailed(true)} onLoad={()=>setFailed(false)}/>
  </span>;
}

let serial = 0;
let ready: Promise<typeof import('mermaid')['default']> | undefined;
let renderQueue: Promise<unknown> = Promise.resolve();
function renderer() {
  return ready ??= import('mermaid').then(({default:mermaid})=>{
    mermaid.initialize({startOnLoad:false, securityLevel:'strict', suppressErrorRendering:true,
      maxTextSize:20_000, maxEdges:300, theme:'neutral', fontFamily:'Arial, sans-serif',
      htmlLabels:false, flowchart:{htmlLabels:false},
      secure:['secure','securityLevel','startOnLoad','maxTextSize','maxEdges','suppressErrorRendering','htmlLabels','fontFamily']});
    return mermaid;
  });
}

export function MermaidDiagram({source}: {source: string}) {
  const root = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false), [url, setUrl] = useState('');
  const [status, setStatus] = useState('Loading diagram…');
  useEffect(()=>{
    if (!root.current) return;
    if (!window.IntersectionObserver) {setNearby(true);return;}
    const observer = new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting))setNearby(true);},{rootMargin:'200px'});
    observer.observe(root.current);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{
    if (!nearby) return;
    let stopped = false, objectUrl = '';
    setUrl('');setStatus('Loading diagram…');
    const work = async()=>{
      if(stopped)return;
      try {
        if(source.length>20_000)throw new Error('Diagram is too large.');
        // Embedded config may not change how notes execute or fetch remote resources.
        if(/%%\s*\{|^\s*---/m.test(source))throw new Error('Use diagram syntax without configuration directives.');
        const mermaid = await renderer();
        const {svg} = await mermaid.render(`note-diagram-${++serial}`, source);
        if(stopped)return;
        // An SVG image is isolated from the note DOM; diagram text cannot shift mark offsets.
        objectUrl = URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
        setUrl(objectUrl);setStatus('');
      } catch {if(!stopped)setStatus('Diagram could not be rendered. Open Diagram source to check the syntax.');}
    };
    renderQueue = renderQueue.then(work,work);
    return()=>{stopped=true;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[source,nearby]);
  return <div ref={root} className="note-diagram" data-status={status} aria-label={status || 'Mermaid diagram'}>
    {url && <img src={url} alt="Mermaid diagram"/>}
    <details><summary aria-label="Diagram source" data-label="Diagram source"/><pre><code>{source}</code></pre></details>
  </div>;
}
