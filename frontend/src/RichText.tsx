import { useRef, useState, type ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";

function CodeBlock({children, ...props}: ComponentPropsWithoutRef<'pre'>) {
  const block=useRef<HTMLPreElement>(null);
  const [status,setStatus]=useState('Copy code');
  const child=children as {props?:{className?:string}};
  const language=child?.props?.className?.replace('language-','') || 'text';
  return <div className="code-block"><div className="code-block-bar" data-language={language}><button type="button" aria-label={status} title={status} data-label={status} onClick={async()=>{try{await navigator.clipboard.writeText(block.current?.textContent||'');setStatus('Copied');}catch{setStatus('Select code to copy');}}}/></div><pre {...props} ref={block}>{children}</pre></div>;
}

export function RichText({ body }: { body: string }) {
  return (
    <div className="prose">
      <Markdown
        components={{pre: CodeBlock}}
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {body}
      </Markdown>
    </div>
  );
}
