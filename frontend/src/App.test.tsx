import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import App from './App';
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
it('requires confirmation before replacing an existing explanation',async()=>{
 const note={slide_id:'s',body:'Saved explanation',revision:1,updated_at:'today'};
 const slide={id:'s',page_number:1,width:800,height:600,explanation:{...note,kind:'explanation'},personal:{...note,kind:'personal',body:''},detail:{...note,kind:'detail',body:''}};
 const doc={id:'d',notebook_id:'n',name:'Lecture',page_count:1,explained_count:1,deleted_at:null,created_at:'today',epoch:'e',slides:[slide]};
 vi.stubGlobal('IntersectionObserver',class{observe(){} disconnect(){}});
 HTMLElement.prototype.scrollTo=vi.fn();
 const fetcher=vi.fn(async(url:unknown,options?:RequestInit)=>{
  const path=String(url);
  const data=path.endsWith('/status')?{epoch:'e',last_document:'d',reasoning:'high',api_key_configured:true,model:'test',queue_paused:false}:path.endsWith('/library')?{notebooks:[{id:'n',name:'Notebook',deleted_at:null}],documents:[doc]}:path==='/api/documents/d'?doc:path.includes('/generate')?{job_ids:['job']}:path.includes('reading-position')?null:[];
  return {ok:true,json:async()=>data} as Response;
 });
 vi.stubGlobal('fetch',fetcher);
 render(<App/>);
 fireEvent.click(await screen.findByRole('button',{name:'Regenerate'}));
 expect(screen.getByRole('dialog',{name:'Confirm regeneration'})).toBeTruthy();
 expect(fetcher.mock.calls.some(([url])=>String(url).includes('/generate'))).toBe(false);
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 expect(screen.getByText('Saved explanation')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Regenerate'}));
 fireEvent.click(screen.getByRole('button',{name:'Regenerate and replace'}));
 await waitFor(()=>expect(fetcher.mock.calls.some(([url,options])=>String(url).includes('/generate')&&options?.method==='POST')).toBe(true));
});
