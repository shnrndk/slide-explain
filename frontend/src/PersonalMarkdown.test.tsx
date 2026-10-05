import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Editor } from './Editor';
import type { Note } from './api';

const original: Note = {slide_id:'markdown-slide', kind:'personal', body:'', revision:0, updated_at:'today'};
const markdown = '# My notes\n\n**Important** and *helpful* with `code`.\n\n- First point\n- Second point\n\n> Remember this\n\n```python\nx = 1\n```\n\n| Term | Meaning |\n| --- | --- |\n| Page | Memory |\n\n$x^2$';
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IntersectionObserver', class {observe(){} disconnect(){}});
});
afterEach(() => {cleanup(); vi.unstubAllGlobals();});

it('previews authored Markdown, saves the source intact, and renders it when reopened', async () => {
  const saved = {...original, body:markdown, revision:1};
  const fetcher = vi.fn(async (_url:unknown, _options?:RequestInit) => ({ok:true, json:async () => saved} as Response));
  vi.stubGlobal('fetch', fetcher);
  const view = render(<Editor note={original} epoch="e" onSaved={() => {}}/>);
  fireEvent.click(screen.getByLabelText('Edit personal notes'));
  fireEvent.change(screen.getByLabelText('Personal notes'), {target:{value:markdown}});
  const preview = screen.getByRole('region', {name:'Personal notes Markdown preview'});
  expect(within(preview).getByRole('heading', {name:'My notes'})).toBeTruthy();
  expect(preview.querySelector('strong')?.textContent).toBe('Important');
  expect(preview.querySelector('em')?.textContent).toBe('helpful');
  expect(preview.querySelectorAll('li')).toHaveLength(2);
  expect(preview.querySelector('blockquote')?.textContent).toContain('Remember this');
  expect(preview.querySelector('pre code')?.textContent).toBe('x = 1\n');
  expect(preview.querySelector('table')).toBeTruthy();
  expect(preview.querySelector('.katex')).toBeTruthy();
  fireEvent.click(screen.getByText('Hide preview'));
  expect(screen.queryByRole('region')).toBeNull();
  expect((screen.getByLabelText('Personal notes') as HTMLTextAreaElement).value).toBe(markdown);
  fireEvent.click(screen.getByText('Show preview'));
  fireEvent.click(screen.getByLabelText('Save personal notes'));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string)).toEqual({body:markdown, revision:0, epoch:'e'});
  expect(localStorage.getItem('slide-notes:draft:e:markdown-slide:personal')).toBeNull();
  view.unmount();
  const reopened = render(<Editor note={saved} epoch="e" onSaved={() => {}}/>);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('heading', {name:'My notes'})).toBeTruthy();
  expect(reopened.container.querySelector('[data-note-kind="personal"] strong')?.textContent).toBe('Important');
  fireEvent.click(screen.getByLabelText('Edit personal notes'));
  expect((screen.getByLabelText('Personal notes') as HTMLTextAreaElement).value).toBe(markdown);
});
