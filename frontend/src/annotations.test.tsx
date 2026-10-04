import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { decorate, selectedRange, type Annotation } from './annotations';
import { AnnotatedText } from './AnnotatedText';

beforeEach(()=>{localStorage.clear();});
afterEach(()=>{cleanup();window.getSelection()?.removeAllRanges();vi.unstubAllGlobals();});

it('decorates selections across bold text and retains overlapping underline',()=>{
  const root=document.createElement('div');
  root.innerHTML='<p>Shared <strong>data</strong> needs a lock.</p>';
  const marks:Annotation[]=[{id:'h',start_offset:0,end_offset:11,quote:'Shared data',style:'highlight',color:'yellow'}, {id:'u',start_offset:7,end_offset:17,quote:'data needs',style:'underline',color:'yellow'}];
  decorate(root,marks);
  expect(root.textContent).toBe('Shared data needs a lock.');
  expect(root.querySelector('strong .mark-yellow.mark-underlined')?.textContent).toBe('data');
  decorate(root,[]);
  expect(root.querySelector('[data-note-mark]')).toBeNull();
  expect(root.querySelector('strong')?.textContent).toBe('data');
});

it('never paints a stale quote onto changed text',()=>{
  const root=document.createElement('div');root.textContent='Changed words';
  decorate(root,[{id:'h',start_offset:0,end_offset:7,quote:'Original',style:'highlight',color:'blue'}]);
  expect(root.querySelector('[data-note-mark]')).toBeNull();
});

it('selects rendered ranges across markup with UTF-16 offsets',()=>{
  const root=document.createElement('div');root.innerHTML='<p>🧠 <strong>Shared</strong> data</p>';
  document.body.append(root);
  const strong=root.querySelector('strong')!;
  const range=document.createRange();range.setStart(strong.firstChild!,0);range.setEnd(strong.nextSibling!,5);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  expect(selectedRange(root,selection)).toMatchObject({start:3,end:14,quote:'Shared data'});
  root.remove();
});

it('saves and reloads a highlight with a selection palette',async()=>{
  let saved:Annotation[]=[];
  const fetchMock=vi.fn(async(_url:string,options?:RequestInit)=>{
    if(options?.method==='POST') {
      const data=JSON.parse(options.body as string);
      saved=[{id:'a',start_offset:data.start,end_offset:data.end,quote:data.quote,style:data.style,color:data.color}];
    }
    return {ok:true,json:async()=>saved} as Response;
  });
  vi.stubGlobal('fetch',fetchMock);
  const note={slide_id:'s',kind:'explanation' as const,body:'Important **shared data**.',revision:1,updated_at:'today'};
  const rendered=render(<AnnotatedText body={note.body} note={note} epoch="e" enabled/>);
  await waitFor(()=>expect(fetchMock).toHaveBeenCalled());
  const strong=rendered.container.querySelector('strong')!;
  const range=document.createRange();range.selectNodeContents(strong);
  range.getBoundingClientRect=()=>({left:30,top:100,bottom:120,width:80} as DOMRect);
  const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
  fireEvent.pointerUp(strong);
  fireEvent.click(screen.getByLabelText('Highlight pink'));
  await waitFor(()=>expect(screen.getByText('Marking saved')).toBeTruthy());
  expect(rendered.container.querySelector('.mark-pink')?.textContent).toBe('shared data');
  rendered.unmount();
  const reopened=render(<AnnotatedText body={note.body} note={note} epoch="e" enabled/>);
  await waitFor(()=>expect(reopened.container.querySelector('.mark-pink')?.textContent).toBe('shared data'));
});
