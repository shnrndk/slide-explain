import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, fireEvent, screen, waitFor } from '@testing-library/react';
import { PdfPage } from './PdfPage';
import type { Annotation } from './annotations';
const slide={id:'s',page_number:1,width:800,height:600};
const layer={text:'Text',text_hash:'a'.repeat(64),selectable:true,characters:[...('Text')].map((text,i)=>({text,start:i,end:i+1,box:[.1+i*.03,.2,.03,.05]}))};
afterEach(()=>{cleanup();vi.unstubAllGlobals();window.getSelection()?.removeAllRanges();});

it('selects PDF text, saves highlights and underlines, and reloads their page positions',async()=>{
  let marks:Annotation[]=[];
  const fetcher=vi.fn(async(url:unknown,options?:RequestInit)=>{
    if(options?.method==='POST'){
      const data=JSON.parse(options.body as string);
      marks=data.action==='clear'?[]:[...marks,{id:String(marks.length),start_offset:data.start,end_offset:data.end,quote:data.quote,style:data.style,color:data.color}];
    }
    return {ok:true,json:async()=>String(url).includes('text-layer')?layer:marks} as Response;
  });
  vi.stubGlobal('fetch',fetcher);vi.stubGlobal('IntersectionObserver',undefined);
  const view=render(<PdfPage slide={slide} epoch="e"/>);
  const root=await screen.findByLabelText('Selectable text of slide 1');
  await waitFor(()=>expect(root.textContent).toBe('Text'));
  const spans=root.querySelectorAll('span');
  const range=document.createRange();range.setStart(spans[0].firstChild!,0);range.setEnd(spans[3].firstChild!,1);
  range.getBoundingClientRect=()=>({left:30,top:100,bottom:120,width:80} as DOMRect);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  fireEvent.pointerUp(spans[0]);
  fireEvent.click(await screen.findByLabelText('Highlight blue'));
  await screen.findByText('Marking saved');
  expect(view.container.querySelectorAll('rect.pdf-mark-blue')).toHaveLength(4);
  expect(view.container.querySelector('rect')?.getAttribute('x')).toBe('100');
  fireEvent.click(screen.getByLabelText('Underline selected text'));
  await waitFor(()=>expect(view.container.querySelectorAll('line')).toHaveLength(4));
  const posted=fetcher.mock.calls.filter(([,options])=>options?.method==='POST');
  expect(JSON.parse(posted[0][1]!.body as string)).toMatchObject({start:0,end:4,quote:'Text',epoch:'e',text_hash:layer.text_hash});
  view.unmount();
  const reopened=render(<PdfPage slide={slide} epoch="e"/>);
  await waitFor(()=>expect(reopened.container.querySelectorAll('rect.pdf-mark-blue')).toHaveLength(4));
  expect(reopened.container.querySelectorAll('line')).toHaveLength(4);
});

it('loads text layers lazily and explains why scanned pages cannot be selected',async()=>{
  let enter:IntersectionObserverCallback=()=>{};
  vi.stubGlobal('IntersectionObserver',class{constructor(callback:IntersectionObserverCallback){enter=callback;}observe(){}disconnect(){}});
  const fetcher=vi.fn(async(url:unknown)=>({ok:true,json:async()=>String(url).includes('text-layer')?{...layer,characters:[],text:'',selectable:false}:[]} as Response));
  vi.stubGlobal('fetch',fetcher);
  render(<PdfPage slide={slide} epoch="e"/>);
  expect(fetcher).not.toHaveBeenCalled();
  enter([{isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver);
  await screen.findByText('No selectable text on this page. Scanned pages need OCR.');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('keeps a failed marking visible for explicit retry and never reports it as saved',async()=>{
  vi.stubGlobal('IntersectionObserver',undefined);
  vi.stubGlobal('fetch',vi.fn(async(url:unknown,options?:RequestInit)=>options?.method==='POST'?{ok:false,status:500,json:async()=>({detail:'Could not save marking'})} as Response:{ok:true,json:async()=>String(url).includes('text-layer')?layer:[]} as Response));
  const view=render(<PdfPage slide={slide} epoch="e"/>);
  const root=await screen.findByLabelText('Selectable text of slide 1');
  await waitFor(()=>expect(root.textContent).toBe('Text'));
  const range=document.createRange();range.selectNodeContents(root);
  range.getBoundingClientRect=()=>({left:30,top:100,bottom:120,width:80} as DOMRect);
  window.getSelection()?.removeAllRanges();window.getSelection()?.addRange(range);fireEvent.pointerUp(root);
  fireEvent.click(await screen.findByLabelText('Highlight yellow'));
  await screen.findByText('Could not save marking');
  expect(screen.queryByText('Marking saved')).toBeNull();
  expect(screen.getByLabelText('Highlight yellow')).toBeTruthy();
  expect(view.container.querySelector('rect')).toBeNull();
});
