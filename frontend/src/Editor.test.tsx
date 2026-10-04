import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Editor } from "./Editor";
import type { Note } from "./api";
const note: Note = {
  slide_id: "slide-one",
  kind: "personal",
  body: "Saved note",
  revision: 1,
  updated_at: "today",
};
const response = (data: unknown, status = 200) => ({
  ok: status === 200,
  status,
  json: async () => data,
});
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("durable note editing", () => {
  it("saves on blur and clears only the acknowledged draft", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({ ...note, body: "Updated note", revision: 2 }) as Response,
    );
    render(<Editor note={note} epoch="epoch" onSaved={() => {}} />);
    if(screen.queryByLabelText("Edit personal notes")) fireEvent.click(screen.getByLabelText("Edit personal notes"));
  fireEvent.change(screen.getByLabelText("Personal notes"), {
      target: { value: "Updated note" },
    });
    expect(
      JSON.parse(
        localStorage.getItem("slide-notes:draft:epoch:slide-one:personal")!,
      ).body,
    ).toBe("Updated note");
    fireEvent.blur(screen.getByLabelText("Personal notes"));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    expect(
      localStorage.getItem("slide-notes:draft:epoch:slide-one:personal"),
    ).toBeNull();
    const call = vi.mocked(fetch).mock.calls[0];
    expect(JSON.parse(call[1]!.body as string)).toEqual({
      body: "Updated note",
      revision: 1,
      epoch: "epoch",
    });
  });
  it("preserves an unsaved draft when the backend is offline", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Offline"));
    render(<Editor note={note} epoch="epoch" onSaved={() => {}} />);
    if(screen.queryByLabelText("Edit personal notes")) fireEvent.click(screen.getByLabelText("Edit personal notes"));
  fireEvent.change(screen.getByLabelText("Personal notes"), {
      target: { value: "Never lose this" },
    });
    fireEvent.blur(screen.getByLabelText("Personal notes"));
    await screen.findByText("Not saved");
    expect(
      JSON.parse(
        localStorage.getItem("slide-notes:draft:epoch:slide-one:personal")!,
      ).body,
    ).toBe("Never lose this");
  });
  it("requires an explicit choice after a revision conflict", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        response(
          {
            detail: "Changed elsewhere",
            current: { ...note, body: "Other tab", revision: 2 },
          },
          409,
        ) as Response,
      )
      .mockResolvedValueOnce(
        response({ ...note, body: "My draft", revision: 3 }) as Response,
      );
    render(<Editor note={note} epoch="epoch" onSaved={() => {}} />);
    if(screen.queryByLabelText("Edit personal notes")) fireEvent.click(screen.getByLabelText("Edit personal notes"));
  fireEvent.change(screen.getByLabelText("Personal notes"), {
      target: { value: "My draft" },
    });
    fireEvent.blur(screen.getByLabelText("Personal notes"));
    await screen.findByText("Conflict");
    expect(
      (screen.getByLabelText("Personal notes") as HTMLTextAreaElement).value,
    ).toBe("My draft");
    fireEvent.click(screen.getByText("Keep my draft"));
    await screen.findByText("Saved");
    expect(
      JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).revision,
    ).toBe(2);
  });
  it("recovers a stale draft without overwriting the newer server note", () => {
    localStorage.setItem(
      "slide-notes:draft:epoch:slide-one:personal",
      JSON.stringify({ body: "Recovered draft", revision: 0 }),
    );
    render(<Editor note={note} epoch="epoch" onSaved={() => {}} />);
    expect(screen.getByText("Conflict")).toBeTruthy();
    expect(
      (screen.getByLabelText("Personal notes") as HTMLTextAreaElement).value,
    ).toBe("Recovered draft");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not erase typing that happens during an in-flight save", async () => {
    let resolve!: (r: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<Editor note={note} epoch="epoch" onSaved={() => {}} />);
    if(screen.queryByLabelText("Edit personal notes")) fireEvent.click(screen.getByLabelText("Edit personal notes"));
  fireEvent.change(screen.getByLabelText("Personal notes"), {
      target: { value: "First edit" },
    });
    fireEvent.blur(screen.getByLabelText("Personal notes"));
    if(screen.queryByLabelText("Edit personal notes")) fireEvent.click(screen.getByLabelText("Edit personal notes"));
  fireEvent.change(screen.getByLabelText("Personal notes"), {
      target: { value: "Second edit" },
    });
    resolve(response({ ...note, body: "First edit", revision: 2 }) as Response);
    await waitFor(() => expect(screen.getByText("Unsaved")).toBeTruthy());
    expect(
      (screen.getByLabelText("Personal notes") as HTMLTextAreaElement).value,
    ).toBe("Second edit");
    expect(
      JSON.parse(
        localStorage.getItem("slide-notes:draft:epoch:slide-one:personal")!,
      ).revision,
    ).toBe(2);
  });
});

it("preserves an unsaved draft while reading mode previews it", () => {
  const { rerender } = render(
    <Editor note={note} epoch="epoch" onSaved={() => {}} />,
  );
  if(screen.queryByLabelText("Edit personal notes")) fireEvent.click(screen.getByLabelText("Edit personal notes"));
  fireEvent.change(screen.getByLabelText("Personal notes"), {
    target: { value: "My unfinished thought" },
  });
  rerender(<Editor note={note} epoch="epoch" readingMode onSaved={() => {}} />);
  expect(screen.queryByRole("textbox", { name: "Personal notes" })).toBeNull();
  expect(screen.getByText("My unfinished thought")).toBeTruthy();
  expect(
    JSON.parse(
      localStorage.getItem("slide-notes:draft:epoch:slide-one:personal")!,
    ).body,
  ).toBe("My unfinished thought");
  rerender(<Editor note={note} epoch="epoch" onSaved={() => {}} />);
  expect(
    (screen.getByLabelText("Personal notes") as HTMLTextAreaElement).value,
  ).toBe("My unfinished thought");
});

it("saves detailed explanations without touching the main explanation", async () => {
  const detail: Note = { ...note, kind: "detail", body: "Deeper explanation" };
  vi.mocked(fetch).mockResolvedValue(response({ ...detail, body: "My detailed edit", revision: 2 }) as Response);
  render(<Editor note={detail} epoch="epoch" onSaved={() => {}} />);
  fireEvent.click(screen.getByLabelText("Edit explanation"));
  fireEvent.change(screen.getByLabelText("Detailed explanation"), {target: {value: "My detailed edit"}});
  fireEvent.blur(screen.getByLabelText("Detailed explanation"));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/slides/slide-one/notes/detail', expect.objectContaining({method: 'PUT'})));
  await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
  expect(localStorage.getItem('slide-notes:draft:epoch:slide-one:detail')).toBeNull();
});

import { DetailDialog } from './DetailDialog';
import { useTheme } from './useTheme';

it('reopens saved details without regenerating and closes with Escape', () => {
  const onClose=vi.fn(), onGenerate=vi.fn();
  const slide={id:note.slide_id,page_number:3,width:800,height:600,
    explanation:{...note,kind:'explanation' as const},personal:note,
    detail:{...note,kind:'detail' as const,body:'Persisted detailed answer'}};
  render(<DetailDialog slide={slide} epoch="epoch" paused={false} busy={false} onClose={onClose} onGenerate={onGenerate} onSaved={()=>{}}/>);
  expect(screen.getByText('Persisted detailed answer')).toBeTruthy();
  expect(onGenerate).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
  expect(onClose).toHaveBeenCalledOnce();
});

it('keeps the chosen theme after the window remounts', () => {
  function ThemeControl(){ const {dark,toggleTheme}=useTheme(); return <button onClick={toggleTheme}>{dark?'Dark':'Light'}</button>; }
  localStorage.setItem('slide-notes:theme','light');
  const first=render(<ThemeControl/>);
  fireEvent.click(screen.getByText('Light'));
  expect(document.documentElement.dataset.theme).toBe('dark');
  first.unmount();
  render(<ThemeControl/>);
  expect(screen.getByText('Dark')).toBeTruthy();
});

it('shows waiting rather than generating while a detailed job is queued', () => {
  const slide={id:note.slide_id,page_number:3,width:800,height:600,
    explanation:{...note,kind:'explanation' as const},personal:note,
    detail:{...note,kind:'detail' as const,body:''}};
  const job={id:'j',slide_id:note.slide_id,page_number:3,kind:'detail' as const,status:'queued',reasoning:'high' as const,created_at:'today',error:null};
  render(<DetailDialog slide={slide} epoch="epoch" job={job} paused={false} busy={false} onClose={()=>{}} onGenerate={()=>{}} onSaved={()=>{}}/>);
  expect(screen.getByText(/Waiting for a generation slot/)).toBeTruthy();
  expect(screen.queryByText(/Generating a more detailed explanation/)).toBeNull();
});
