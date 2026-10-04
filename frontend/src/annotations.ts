export type MarkColor = "yellow" | "green" | "blue" | "pink";
export interface Annotation {
  id: string;
  start_offset: number;
  end_offset: number;
  quote: string;
  style: "highlight" | "underline";
  color: MarkColor;
}

/** Offsets address rendered text, so bold, links and code may share a selection. */
export function selectedRange(root: HTMLElement, selection: Selection | null) {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  const quote = range.toString();
  if (!quote.trim()) return null;
  return { start, end: start + quote.length, quote, range };
}

export function clearDecorations(root: HTMLElement) {
  root.querySelectorAll("[data-note-mark]").forEach(node => node.replaceWith(...node.childNodes));
  root.normalize();
}

export function decorate(root: HTMLElement, annotations: Annotation[]) {
  clearDecorations(root);
  const fullText = root.textContent || "";
  // Never move a highlight onto different words when content or rendering changes.
  const marks = annotations.filter(a => a.start_offset >= 0 && a.end_offset <= fullText.length && fullText.slice(a.start_offset, a.end_offset) === a.quote);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let offset = 0;
  for (const node of nodes) {
    const text = node.data;
    const end = offset + text.length;
    const overlaps = marks.filter(a => a.start_offset < end && a.end_offset > offset);
    if (overlaps.length) {
      const cuts = [...new Set([0, text.length, ...overlaps.flatMap(a => [Math.max(0, a.start_offset - offset), Math.min(text.length, a.end_offset - offset)])])].sort((a,b) => a-b);
      const fragment = document.createDocumentFragment();
      for (let i=0;i<cuts.length-1;i++) {
        const from=cuts[i], to=cuts[i+1];
        const active=overlaps.filter(a=>a.start_offset < offset+to && a.end_offset > offset+from);
        const highlight=active.filter(a=>a.style==='highlight').at(-1);
        const underlined=active.some(a=>a.style==='underline');
        if (highlight || underlined) {
          const span=document.createElement('span');
          span.dataset.noteMark='true';
          span.className=`text-mark ${highlight ? `mark-${highlight.color}` : ''} ${underlined ? 'mark-underlined' : ''}`;
          span.textContent=text.slice(from,to);
          fragment.append(span);
        } else fragment.append(document.createTextNode(text.slice(from,to)));
      }
      node.replaceWith(fragment);
    }
    offset=end;
  }
}
