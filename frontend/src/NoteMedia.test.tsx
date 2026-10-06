import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {RichText} from './RichText';
import {Editor} from './Editor';
import {youtubeId} from './NoteMedia';
import type {Note} from './api';

const mermaid = vi.hoisted(()=>({initialize:vi.fn(),render:vi.fn(async()=>({svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>A to B</text></svg>'}))}));
vi.mock('mermaid',()=>({default:mermaid}));
const note:Note={slide_id:'s',kind:'personal',body:'Keep this paragraph.',revision:0,updated_at:'today'};
beforeEach(()=>{
 localStorage.clear();vi.stubGlobal('IntersectionObserver',undefined);
 vi.stubGlobal('requestAnimationFrame',(fn:()=>void)=>{fn();return 1;});
 vi.stubGlobal('URL',URL);URL.createObjectURL=vi.fn(()=> 'blob:diagram-test');URL.revokeObjectURL=vi.fn();
 mermaid.render.mockClear();mermaid.render.mockResolvedValue({svg:'<svg xmlns="http://www.w3.org/2000/svg"><text>A to B</text></svg>'});
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it.each(['https://youtu.be/dQw4w9WgXcQ','https://www.youtube.com/watch?v=dQw4w9WgXcQ','https://youtube.com/shorts/dQw4w9WgXcQ','https://m.youtube.com/watch?v=dQw4w9WgXcQ'])('recognizes only valid YouTube links: %s',url=>{
 expect(youtubeId(url)).toBe('dQw4w9WgXcQ');
 expect(youtubeId('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ')).toBeNull();
 expect(youtubeId('javascript:alert(1)')).toBeNull();
});
it('loads YouTube only on request and keeps rendered text offsets stable',()=>{
 const {container}=render(<RichText body='https://youtu.be/dQw4w9WgXcQ'/>);
 const text=container.textContent;
 expect(container.querySelector('iframe')).toBeNull();
 fireEvent.click(screen.getByLabelText('Play YouTube video'));
 expect(container.querySelector('iframe')?.src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
 expect(container.textContent).toBe(text);
 fireEvent.click(screen.getByLabelText('Close YouTube video'));
 expect(container.querySelector('iframe')).toBeNull();
});
it('renders local attachments and keeps external image URLs as links',()=>{
 const {container}=render(<RichText body={`![Local](/api/note-assets/${'a'.repeat(32)})\n\n![Remote](https://example.com/image.png)\n\n<img src=x onerror="alert(1)">`}/>);
 expect(screen.getByAltText('Local').getAttribute('src')).toBe(`/api/note-assets/${'a'.repeat(32)}`);
 expect(container.querySelectorAll('img')).toHaveLength(1);
 expect(screen.getByRole('link',{name:/Remote/}).getAttribute('href')).toBe('https://example.com/image.png');
});
it('renders Mermaid from source without changing annotation offsets',async()=>{
 const {container}=render(<RichText body={'Before\n\n```mermaid\nflowchart TD\nA-->B\n```\n\nAfter'}/>);
 const text=container.textContent;
 await screen.findByAltText('Mermaid diagram');
 expect(mermaid.render).toHaveBeenCalledWith(expect.any(String),'flowchart TD\nA-->B\n');
 expect(container.textContent).toBe(text);
 expect(container.querySelector('svg')).toBeNull();
});
it('keeps invalid diagram source editable instead of losing note content',async()=>{
 mermaid.render.mockRejectedValueOnce(new Error('bad syntax'));
 const {container}=render(<RichText body={'```mermaid\ninvalid diagram\n```'}/>);
 await waitFor(()=>expect(container.querySelector('.note-diagram')?.getAttribute('data-status')).toContain('could not be rendered'));
 expect(container.querySelector('code')?.textContent).toBe('invalid diagram\n');
});
it('uploads a note image, preserves existing text and saves its Markdown reference',async()=>{
 const asset={id:'a'.repeat(32),url:`/api/note-assets/${'a'.repeat(32)}`,original_name:'Diagram.png'};
 const fetcher=vi.fn(async(url:unknown,options?:RequestInit)=>({ok:true,json:async()=>String(url).endsWith('/note-assets')?asset:options?.method==='PUT'?{...note,body:JSON.parse(options.body as string).body,revision:1}:[]} as Response));
 vi.stubGlobal('fetch',fetcher);
 render(<Editor note={note} epoch="e" onSaved={()=>{}}/>);
 fireEvent.click(screen.getByLabelText('Edit personal notes'));
 fireEvent.change(screen.getByLabelText('Choose note image'),{target:{files:[new File(['image'],'Diagram.png',{type:'image/png'})]}});
 await screen.findByText('Image stored locally. Save the note to keep its placement.');
 const body=(screen.getByLabelText('Personal notes') as HTMLTextAreaElement).value;
 expect(body).toContain(note.body);expect(body).toContain(`![Diagram.png](${asset.url})`);
 fireEvent.click(screen.getByLabelText('Save personal notes'));
 await waitFor(()=>expect(screen.queryByLabelText('Personal notes')).toBeNull());
 expect(screen.getByAltText('Diagram.png')).toBeTruthy();
 const form=fetcher.mock.calls.find(([,options])=>options?.body instanceof FormData)![1]!.body as FormData;
 expect(form.get('epoch_id')).toBe('e');expect(form.get('asset_id')).toMatch(/^[a-f0-9]{32}$/);
});
it('inserts a diagram template and a YouTube link without discarding existing notes',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>[]} as Response)));
 render(<Editor note={note} epoch="e" onSaved={()=>{}}/>);
 fireEvent.click(screen.getByLabelText('Edit personal notes'));
 fireEvent.click(screen.getByText('Diagram'));fireEvent.click(screen.getByText('Sequence'));
 fireEvent.click(screen.getByText('YouTube / link'));fireEvent.change(screen.getByLabelText('Video or website URL'),{target:{value:'https://youtu.be/dQw4w9WgXcQ'}});fireEvent.click(screen.getByText('Add link'));
 const body=(screen.getByLabelText('Personal notes') as HTMLTextAreaElement).value;
 expect(body).toContain(note.body);expect(body).toContain('```mermaid\nsequenceDiagram');expect(body).toContain('[YouTube video](<https://youtu.be/dQw4w9WgXcQ>)');
});
