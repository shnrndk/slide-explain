import { PdfPage } from "./PdfPage";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Moon,
  Sun,
  BookOpen,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  ChevronDown,
  ChevronRight,
  FileText,
  Upload,
  Sparkles,
  Settings2,
  Trash2,
  X,
  ArrowUpRight,
  Check,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  RotateCcw,
  Download,
  ShieldCheck,
  MoreHorizontal,
  NotebookPen,
  CircleHelp,
  AlertCircle,
  FolderOpen,
  ArrowRight,
} from "lucide-react";
import {
  api,
  json,
  type Document,
  type FullDocument,
  type Job,
  type Notebook,
  type Reasoning,
  type Status,
} from "./api";
import { Editor } from "./Editor";
import { useTheme } from "./useTheme";
import { ChatDialog } from "./ChatDialog";
import { DetailDialog } from "./DetailDialog";
import { useReadingPosition } from "./useReadingPosition";
import { useReadingMode } from "./useReadingMode";

type Library = { notebooks: Notebook[]; documents: Document[] };
function errorText(e: unknown) {
  return e instanceof Error
    ? e.message
    : "Something went wrong. Please try again.";
}
function date(value: string | null) {
  return value ? new Date(value).toLocaleString() : "No backup yet";
}

export default function App() {
  const { dark, toggleTheme } = useTheme();
  const themeButton = <button className="theme-toggle button subtle" onClick={toggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"}>{dark ? <Sun size={17}/> : <Moon size={17}/>}</button>;
  const [confirmGeneration,setConfirmGeneration] = useState<{mode:"all"|"selected"|"missing"|"failed";ids:string[];kind:"explanation"|"detail";count:number}|null>(null);
  const [chatSlide, setChatSlide] = useState<string | null>(null);
  const [detailSlide, setDetailSlide] = useState<string | null>(null);
  const [library, setLibrary] = useState<Library>({
    notebooks: [],
    documents: [],
  });
  const [status, setStatus] = useState<Status | null>(null);
  const [doc, setDoc] = useState<FullDocument | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const [notebookId, setNotebookId] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [explanationLength, setExplanationLength] = useState(() => { try { return localStorage.getItem('slide-explain:length') || 'brief'; } catch { return 'brief'; } });
  const [reasoning, setReasoning] = useState<Reasoning>("high");
  const [showSettings, setShowSettings] = useState(false);
  const [showTrash, setShowTrash] = useState(false);
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 600);
  const [busy, setBusy] = useState("");
  const [toast, setToast] = useState("");
  const [connection, setConnection] = useState("");
  const [split, setSplit] = useState(51);
  const [nameDialog, setNameDialog] = useState<{
    kind: "new" | "notebooks" | "documents";
    id?: string;
    name: string;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ id: string; page: number } | null>(
    null,
  );
  useEffect(() => {setDetailSlide(null);setChatSlide(null);setConfirmGeneration(null);}, [docId]);
  const upload = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const { readingMode, setReadingMode } = useReadingMode(content, docId);
  useReadingPosition(content, doc?.id === docId ? doc : null);
  const currentId = useRef(docId);
  currentId.current = docId;
  const initialized = useRef(false);
  const currentEpoch = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const id = currentId.current;
    try {
      const [lib, st] = await Promise.all([
        api<Library>("/library"),
        api<Status>("/status"),
      ]);
      setLibrary(lib);
      setStatus(st);
      setConnection("");
      if (currentEpoch.current && currentEpoch.current !== st.epoch) {
        setDoc(null);
        setDocId(null);
        setSelected(new Set());
        setToast("Library restored. Reopen a document to continue.");
      }
      currentEpoch.current = st.epoch;
      if (!initialized.current) {
        initialized.current = true;
        setReasoning(st.reasoning);
        const last = lib.documents.find(d=>d.id===st.last_document && !d.deleted_at && lib.notebooks.some(n=>n.id===d.notebook_id && !n.deleted_at));
        if(last)setDocId(last.id);
        const first = lib.notebooks.find((n) => n.id===last?.notebook_id) || lib.notebooks.find((n) => !n.deleted_at);
        if (first) {
          setNotebookId(first.id);
          setExpanded(new Set([first.id]));
        }
      }
      if (id && currentId.current === id) {
        const [d, j] = await Promise.all([
          api<FullDocument>(`/documents/${id}`),
          api<Job[]>(`/jobs?document_id=${id}`),
        ]);
        if (currentId.current === id) {
          setDoc(d);
          setJobs(j);
        }
      }
    } catch (e) {
      setConnection(errorText(e));
    }
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 2500);
    return () => clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    setDoc(null);
    setJobs([]);
    setSelected(new Set());
    void refresh();
    content.current?.scrollTo(0, 0);
  }, [docId, refresh]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!lightbox) setReadingMode(false);
        setLightbox(null);
        setMenu(null);
        setNameDialog(null);
        setShowSettings(false);
        setShowTrash(false);
      }
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [lightbox, setReadingMode]);
  async function action(task: () => Promise<unknown>, message?: string) {
    try {
      await task();
      if (message) setToast(message);
      await refresh();
    } catch (e) {
      setToast(errorText(e));
    }
  }
  async function saveName() {
    if (!nameDialog?.name.trim()) return;
    await action(async () => {
      if (nameDialog.kind === "new") {
        const n = await api<Notebook>(
          "/notebooks",
          json("POST", { name: nameDialog.name }),
        );
        setNotebookId(n.id);
        setExpanded((s) => new Set([...s, n.id]));
      } else
        await api(
          `/${nameDialog.kind}/${nameDialog.id}`,
          json("PATCH", { name: nameDialog.name }),
        );
      setNameDialog(null);
    });
  }
  async function importFile(file: File) {
    if (!notebookId) {
      setToast("Create or select a notebook first.");
      return;
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setToast(
        "Choose a PDF. Export PowerPoint or Keynote slides as PDF first.",
      );
      return;
    }
    setBusy("Importing your PDF…");
    try {
      const form = new FormData();
      form.append("file", file);
      const d = await api<Document>(`/notebooks/${notebookId}/import`, {
        method: "POST",
        body: form,
      });
      setExpanded((s) => new Set([...s, notebookId]));
      setDocId(d.id);
      setToast(
        `${d.page_count} slides imported. Choose which slides to explain.`,
      );
      await refresh();
    } catch (e) {
      setToast(errorText(e));
    } finally {
      setBusy("");
      if (upload.current) upload.current.value = "";
    }
  }
  async function generate(
    mode: "all" | "selected" | "missing" | "failed",
    ids?: string[],
    kind: "explanation" | "detail" = "explanation",
    confirmed = false,
  ) {
    if (!doc) return;
    const targetIds=ids || [...selected];
    const replacing=doc.slides.filter(s=>!!s[kind].body.trim() && (mode!=="selected" || targetIds.includes(s.id)) && mode!=="missing");
    if(!confirmed && replacing.length){setConfirmGeneration({mode,ids:targetIds,kind,count:replacing.length});return;}
    setBusy("Adding slides to the queue…");
    try {
      const result = await api<{ job_ids: string[] }>(
        `/documents/${doc.id}/generate`,
        json("POST", { mode, slide_ids: ids || [...selected], reasoning, kind, length: kind === "detail" ? "long" : explanationLength }),
      );
      setToast(
        result.job_ids.length
          ? `${result.job_ids.length} slides queued${status?.queue_paused ? " — resume the queue to start" : ""}.`
          : "No new slides to queue. They may already be running or explained.",
      );
      await refresh();
    } catch (e) {
      setToast(errorText(e));
    } finally {
      setBusy("");
    }
  }
  async function moveToTrash(kind: "notebooks" | "documents", id: string) {
    await action(async () => {
      await api(`/${kind}/${id}`, json("DELETE"));
      if (
        (kind === "documents" && docId === id) ||
        (kind === "notebooks" && notebookId === id)
      ) {
        setDocId(null);
        if (kind === "notebooks") setNotebookId(null);
      }
      setMenu(null);
    }, "Moved to trash. You can restore it anytime.");
  }
  function dragDivider(e: React.PointerEvent) {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const bounds = e.currentTarget.parentElement!.getBoundingClientRect();
    const move = (event: PointerEvent) =>
      setSplit(
        Math.min(
          67,
          Math.max(33, ((event.clientX - bounds.left) / bounds.width) * 100),
        ),
      );
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const activeNotebooks = library.notebooks.filter((n) => !n.deleted_at);
  const activeDocuments = library.documents.filter(
    (d) => !d.deleted_at && activeNotebooks.some((n) => n.id === d.notebook_id),
  );
  const notebook = library.notebooks.find((n) => n.id === notebookId);
  const latestJobs = new Map<string, Job>();
  jobs.forEach((j) => {
    if (j.kind !== "detail" && !latestJobs.has(j.slide_id)) latestJobs.set(j.slide_id, j);
  });
  const detailJobs = new Map<string, Job>();
  jobs.forEach(j => { if (j.kind === "detail" && !detailJobs.has(j.slide_id)) detailJobs.set(j.slide_id, j); });
  const chat = doc?.slides.find(s => s.id === chatSlide);
  const detail = doc?.slides.find(s => s.id === detailSlide);
  const pending = jobs.filter(
    (j) => j.status === "queued" || j.status === "running",
  );
  const failed = [...latestJobs.values()].filter((j) =>
    ["failed", "interrupted"].includes(j.status),
  );
  const explained =
    doc?.slides.filter((s) => !!s.explanation.body.trim()).length || 0;
  const trashCount =
    library.notebooks.filter((n) => n.deleted_at).length +
    library.documents.filter((d) => d.deleted_at).length;
  return (
    <div
      className={`app ${sidebar ? "" : "sidebar-hidden"} ${readingMode ? "reading-mode" : ""}`}
    >
      <aside className="sidebar">
        <button
          className="icon-button sidebar-mobile-close"
          aria-label="Close sidebar"
          onClick={() => setSidebar(false)}
        >
          <X size={16} />
        </button>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setDocId(null);
          }}
        >
          <div className="brand-icon">
            <NotebookPen size={23} />
          </div>
          <span>
            slide explain<span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="avatar">S</span>
          <div>
            Your study space<small>Personal · Local workspace</small>
          </div>
          <ChevronDown size={14} />
        </div>
        <button
          className="button new-notebook"
          onClick={() => setNameDialog({ kind: "new", name: "" })}
        >
          <Plus size={17} /> New notebook
        </button>
        <div className="sidebar-section-heading">
          YOUR NOTEBOOKS <span>{activeNotebooks.length}</span>
        </div>
        <nav className="notebooks" aria-label="Notebooks">
          {activeNotebooks.length === 0 ? (
            <p className="sidebar-empty">
              A place for every subject.
              <br />
              Create your first notebook above.
            </p>
          ) : (
            activeNotebooks.map((n) => (
              <div className="notebook-group" key={n.id}>
                <div
                  className={`notebook-line ${notebookId === n.id ? "chosen" : ""}`}
                >
                  <button
                    className="notebook-button"
                    onClick={() => {
                      setNotebookId(n.id);
                      setExpanded((s) => {
                        const next = new Set(s);
                        next.has(n.id) ? next.delete(n.id) : next.add(n.id);
                        return next;
                      });
                    }}
                  >
                    {expanded.has(n.id) ? (
                      <ChevronDown size={13} />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                    <BookOpen size={17} />
                    <span>{n.name}</span>
                  </button>
                  <button
                    className="icon-button more"
                    aria-label={`Options for ${n.name}`}
                    onClick={() => setMenu(menu === n.id ? null : n.id)}
                  >
                    <MoreHorizontal size={16} />
                  </button>
                  {menu === n.id && (
                    <div className="small-menu">
                      <button
                        onClick={() => {
                          setNameDialog({
                            kind: "notebooks",
                            id: n.id,
                            name: n.name,
                          });
                          setMenu(null);
                        }}
                      >
                        Rename notebook
                      </button>
                      <button
                        onClick={() => void moveToTrash("notebooks", n.id)}
                      >
                        Move to trash
                      </button>
                    </div>
                  )}
                </div>
                {expanded.has(n.id) && (
                  <div className="document-list">
                    {activeDocuments
                      .filter((d) => d.notebook_id === n.id)
                      .map((d) => (
                        <button
                          className={`document-link ${docId === d.id ? "active" : ""}`}
                          key={d.id}
                          onClick={() => {
                            setNotebookId(n.id);
                            setDocId(d.id);
                          }}
                        >
                          <FileText size={15} />
                          <span>{d.name}</span>
                          {d.explained_count === d.page_count && (
                            <Check size={12} />
                          )}
                        </button>
                      ))}
                    <button
                      className="add-document"
                      onClick={() => {
                        setNotebookId(n.id);
                        setTimeout(() => upload.current?.click(), 0);
                      }}
                    >
                      <Plus size={13} /> Add a PDF
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className="local-dot" />
            <div>
              Made to stay with you
              <small>Your notes are saved on this Mac.</small>
            </div>
            <ShieldCheck size={16} />
          </div>
          <button onClick={() => setShowTrash(true)}>
            <Trash2 size={16} /> Trash{" "}
            {trashCount > 0 && <span className="count">{trashCount}</span>}
          </button>
          <button onClick={() => setShowSettings(true)}>
            <Settings2 size={16} /> Settings & backups
          </button>
          <div className="sidebar-footer">
            A little clarity, slide by slide.
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button"
              aria-label="Toggle sidebar"
              onClick={() => setSidebar(!sidebar)}
            >
              {sidebar ? (
                <PanelLeftClose size={18} />
              ) : (
                <PanelLeftOpen size={18} />
              )}
            </button>
            <span className="breadcrumb-root">My workspace</span>
            {notebook && (
              <>
                <ChevronRight size={13} />
                <span>{notebook.name}</span>
              </>
            )}
          </div>
          <div className="topbar-right">
            {themeButton}
            <span className="local-status">
              <span className="local-dot" /> Saved locally
            </span>
            <button
              className="icon-button"
              aria-label="Help and setup"
              onClick={() => setShowSettings(true)}
            >
              <CircleHelp size={18} />
            </button>
            <span className="avatar small">S</span>
          </div>
        </header>
        {connection && (
          <div className="connection-banner">
            <AlertCircle size={16} /> Connection interrupted. Your saved notes
            and local drafts are preserved.{" "}
            <button onClick={() => void refresh()}>Reconnect</button>
          </div>
        )}
        {docId && !doc ? (
          <div className="loading-state">
            <Loader2 className="spin" /> Opening your notes…
          </div>
        ) : doc ? (
          <>
            <div className="document-heading">
              <div>
                <div className="eyebrow">
                  <FileText size={13} /> LECTURE NOTES <span>·</span>{" "}
                  {doc.page_count} SLIDES
                </div>
                <h1>
                  {doc.name}
                  <button
                    className="icon-button title-edit"
                    aria-label="Rename document"
                    onClick={() =>
                      setNameDialog({
                        kind: "documents",
                        id: doc.id,
                        name: doc.name,
                      })
                    }
                  >
                    <MoreHorizontal size={20} />
                  </button>
                </h1>
                <p>Your slides, with a little more understanding.</p>
              </div>
              <div className="document-actions">
                <button
                  id="enter-reading-mode"
                  className="button reading-mode-button"
                  aria-label="Enter reading mode"
                  aria-pressed={readingMode}
                  onClick={() => {
                    setMenu(null);
                    setReadingMode(true);
                  }}
                  title="Enlarge slides and explanations, and hide distractions"
                >
                  <Maximize2 size={16} /> Reading mode
                </button>
                <a
                  className="button subtle"
                  href={`/api/documents/${doc.id}/original`}
                >
                  <Download size={15} /> Original PDF
                </a>
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={() => upload.current?.click()}
                >
                  <Plus size={16} /> Import PDF
                </button>
                <button
                  className="icon-button"
                  aria-label="Move document to trash"
                  onClick={() => void moveToTrash("documents", doc.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <div className="study-toolbar">
              <div className="selection-controls">
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={selected.size === doc.slides.length}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? new Set(doc.slides.map((s) => s.id))
                          : new Set(),
                      )
                    }
                  />
                  {selected.size
                    ? `${selected.size} selected`
                    : "Select slides"}
                </label>
                <div className="toolbar-separator" />

              </div>
              <div className="generation-controls">
                <label className="reasoning-control">Length <select aria-label="Explanation length" value={explanationLength} onChange={e=>{setExplanationLength(e.target.value);try{localStorage.setItem('slide-explain:length',e.target.value);}catch{}}}><option value="brief">Brief</option><option value="medium">Medium</option><option value="long">Long</option></select></label>
                <label className="reasoning-control">
                  <span>Reasoning</span>
                  <select
                    aria-label="Reasoning effort"
                    value={reasoning}
                    onChange={(e) => setReasoning(e.target.value as Reasoning)}
                  >
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="xhigh">Extra high</option>
                  </select>
                </label>
                <div className="generate-group">
                  <button
                    className="button primary"
                    disabled={!!busy}
                    onClick={() =>
                      void generate(selected.size ? "selected" : "missing")
                    }
                  >
                    <Sparkles size={16} />
                    {selected.size ? "Explain selected" : "Explain missing"}
                  </button>
                  <button
                    className="button primary dropdown-button"
                    aria-label="More generation options"
                    onClick={() =>
                      setMenu(menu === "generate" ? null : "generate")
                    }
                  >
                    <ChevronDown size={14} />
                  </button>
                  {menu === "generate" && (
                    <div className="small-menu generate-menu">
                      <button
                        onClick={() => {
                          setMenu(null);
                          void generate("all");
                        }}
                      >
                        Explain all slides
                      </button>
                      <button
                        onClick={() => {
                          setMenu(null);
                          void generate("missing");
                        }}
                      >
                        Explain missing slides
                      </button>
                      <button
                        disabled={!failed.length}
                        onClick={() => {
                          setMenu(null);
                          void generate("failed");
                        }}
                      >
                        Retry failed slides
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="progress-strip">
              <div>
                <span className="progress-dot" />
                <strong>
                  {explained} of {doc.page_count}
                </strong>{" "}
                slides explained{" "}
                {pending.length > 0 && (
                  <span className="queue-detail">
                    · {pending.filter((j) => j.status === "running").length}{" "}
                    generating ·{" "}
                    {pending.filter((j) => j.status === "queued").length} queued
                  </span>
                )}
                {status?.queue_paused && (
                  <span className="queue-detail">· Queue paused</span>
                )}
              </div>
              <div className="progress-actions">
                {(pending.length > 0 || status?.queue_paused) && (
                  <>
                    <button
                      className="text-button"
                      onClick={() =>
                        void action(() =>
                          api(
                            `/queue/${status?.queue_paused ? "resume" : "pause"}`,
                            json("POST"),
                          ),
                        )
                      }
                    >
                      {status?.queue_paused ? (
                        <Play size={12} />
                      ) : (
                        <Pause size={12} />
                      )}{" "}
                      {status?.queue_paused ? "Resume" : "Pause"}
                    </button>
                    {pending.length > 0 && (
                      <button
                        className="text-button"
                        onClick={() =>
                          void action(() => api("/queue/cancel", json("POST")))
                        }
                      >
                        Cancel queue
                      </button>
                    )}
                  </>
                )}
                <span className="model-label">
                  ✧ Luna · {reasoning === "xhigh" ? "extra high" : reasoning}{" "}
                  reasoning
                </span>
              </div>
            </div>
            {!status?.api_key_configured && (
              <div className="setup-banner">
                <Sparkles size={16} />
                <span>
                  Ready when you are. Add your OpenAI API key to start
                  explaining slides.
                </span>
                <button onClick={() => setShowSettings(true)}>
                  Set up AI <ArrowUpRight size={13} />
                </button>
              </div>
            )}
            {readingMode && (
              <div
                className="reading-bar"
                role="toolbar"
                aria-label="Reading mode"
              >
                <span className="reading-document-title">
                  <BookOpen size={16} />
                  {doc.name}
                </span>
                {themeButton}
                <button
                  id="exit-reading-mode"
                  className="button"
                  onClick={() => setReadingMode(false)}
                >
                  <Minimize2 size={16} /> Exit reading mode <kbd>Esc</kbd>
                </button>
              </div>
            )}
            <div className="study-scroll" ref={content}>
              <div
                className="study-canvas"
                style={
                  {
                    "--split": `${split}%`,
                    "--zoom": 1,
                  } as CSSProperties
                }
              >
                <div className="column-headings">
                  <span>
                    THE SLIDE <small>Select text to highlight or underline</small>
                  </span>
                  <div
                    role="separator"
                    aria-label="Resize slide and explanation columns"
                    aria-orientation="vertical"
                    aria-valuenow={Math.round(split)}
                    tabIndex={0}
                    className="column-divider"
                    onPointerDown={dragDivider}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowLeft")
                        setSplit((v) => Math.max(33, v - 2));
                      if (e.key === "ArrowRight")
                        setSplit((v) => Math.min(67, v + 2));
                    }}
                  />
                  <span>
                    YOUR UNDERSTANDING{" "}
                    <small>Editable · Automatically saved</small>
                  </span>
                </div>
                {doc.slides.map((slide) => {
                  const job = latestJobs.get(slide.id);
                  return (
                    <article
                      className={`slide-row ${selected.has(slide.id) ? "is-selected" : ""}`}
                      key={slide.id}
                      id={`slide-${slide.page_number}`}
                    >
                      <div className="slide-side">
                        <div className="slide-label">
                          <label>
                            <input
                              type="checkbox"
                              aria-label={`Select slide ${slide.page_number}`}
                              checked={selected.has(slide.id)}
                              onChange={(e) =>
                                setSelected((s) => {
                                  const n = new Set(s);
                                  e.target.checked
                                    ? n.add(slide.id)
                                    : n.delete(slide.id);
                                  return n;
                                })
                              }
                            />
                            <span>
                              SLIDE {String(slide.page_number).padStart(2, "0")}
                            </span>
                          </label>
                          <span>
                            {slide.explanation.body ? (
                              <>
                                <Check size={12} /> Explained
                              </>
                            ) : (
                              "Ready to explore"
                            )}
                          </span>
                        </div>
                        <div className="pdf-slide-controls">
                          <button className="icon-button slide-zoom-button" aria-label={`Enlarge slide ${slide.page_number}`} title="Zoom slide" onClick={()=>setLightbox({id:slide.id,page:slide.page_number})}><Maximize2 size={14}/></button>
                        </div>
                        <PdfPage key={`${slide.id}:${doc.epoch}`} slide={slide} epoch={doc.epoch}/>

                        <div className="slide-footer">
                          <span>
                            {slide.page_number} / {doc.page_count}
                          </span>
                          <button
                            className="text-button"
                            disabled={
                              job?.status === "running" ||
                              job?.status === "queued" ||
                              !!busy
                            }
                            onClick={() =>
                              void generate("selected", [slide.id])
                            }
                          >
                            {job?.status === "running" ? (
                              <Loader2 size={13} className="spin" />
                            ) : slide.explanation.body ? (
                              <RotateCcw size={12} />
                            ) : (
                              <Sparkles size={12} />
                            )}{" "}
                            {job?.status === "running"
                              ? "Explaining…"
                              : job?.status === "queued"
                                ? "Queued"
                                : slide.explanation.body
                                  ? "Regenerate"
                                  : "Explain slide"}
                          </button>
                        </div>
                        {job?.error && (
                          <div
                            className={`job-message ${job.status === "completed" ? "info" : ""}`}
                          >
                            <AlertCircle size={14} />
                            <span>{job.error}</span>
                            {["failed", "interrupted"].includes(job.status) && (
                              <button
                                onClick={() =>
                                  void generate("selected", [slide.id])
                                }
                              >
                                Retry
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="notes-side">
                        <Editor
                          key={`${slide.id}:explanation:${doc.epoch}`}
                          readingMode={readingMode}
                          onChat={() => setChatSlide(slide.id)}
                          onDetails={() => {
                            setDetailSlide(slide.id);
                            if (!slide.detail?.body && !detailJobs.has(slide.id)) void generate("selected", [slide.id], "detail");
                          }}
                          note={slide.explanation}
                          epoch={doc.epoch}
                          onSaved={() => void refresh()}
                        />
                        <Editor
                          key={`${slide.id}:personal:${doc.epoch}`}
                          readingMode={readingMode}
                          note={slide.personal}
                          epoch={doc.epoch}
                          onSaved={() => void refresh()}
                        />
                      </div>
                    </article>
                  );
                })}
                <div className="end-of-document">
                  <span>✧</span> A little more understood.{" "}
                  <span>End of document</span>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="home-scroll">
            <div className="home-content">
              <div className="home-kicker">
                <span className="local-dot" /> LESS COPYING. MORE UNDERSTANDING.
              </div>
              <h1>
                Make room for
                <br />
                <em>understanding.</em>
              </h1>
              <p className="home-description">
                Your lecture slides and clear explanations, together.
                <br />A quieter way to turn information into knowledge.
              </p>
              <div className="home-actions">
                <button
                  className="button primary large"
                  onClick={() => {
                    if (!notebookId) setNameDialog({ kind: "new", name: "" });
                    else upload.current?.click();
                  }}
                >
                  {notebookId ? <Upload size={18} /> : <Plus size={18} />}{" "}
                  {notebookId
                    ? "Import your slides"
                    : "Create your first notebook"}
                </button>
                <span>PDF in. Clarity out.</span>
              </div>
              <div className="example-notebook">
                <div className="example-top">
                  <span />
                  <span />
                  <span />
                  <div>YOUR NEXT LIGHTBULB MOMENT</div>
                  <span className="example-badge">
                    A preview of your workspace
                  </span>
                </div>
                <div className="example-body">
                  <div className="example-slide">
                    <div className="example-slide-top">
                      COMPUTER SCIENCE <span>04</span>
                    </div>
                    <h3>
                      Small steps.
                      <br />
                      Shared understanding.
                    </h3>
                    <div className="diagram">
                      <div>Read</div>
                      <ArrowRight size={17} />
                      <div>Think</div>
                      <ArrowRight size={17} />
                      <div>Learn</div>
                    </div>
                    <div className="example-lines">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                  <div className="example-note">
                    <span className="eyebrow">
                      <Sparkles size={13} /> THE IDEA, EXPLAINED
                    </span>
                    <h3>The “why” beside the “what.”</h3>
                    <p>
                      Every slide gets a clear explanation, with the definitions
                      and examples that make it click.
                    </p>
                    <div className="example-takeaway">
                      <span>↳</span> Keep the original in view.
                      <br />
                      Build your understanding beside it.
                    </div>
                    <div className="example-personal">
                      <Pencil size={12} /> And a little space for your own
                      thoughts.
                    </div>
                  </div>
                </div>
              </div>
              <div className="home-features">
                <div>
                  <span>01</span>
                  <h3>Bring your slides</h3>
                  <p>
                    Import a PDF into a notebook.
                    <br />
                    Every page becomes a study space.
                  </p>
                </div>
                <div>
                  <span>02</span>
                  <h3>Find your clarity</h3>
                  <p>
                    Choose your slides. Let Luna explain
                    <br />
                    the ideas, diagrams, and details.
                  </p>
                </div>
                <div>
                  <span>03</span>
                  <h3>Make it yours</h3>
                  <p>
                    Edit, add your thoughts, and come
                    <br />
                    back anytime. Your notes stay yours.
                  </p>
                </div>
              </div>
              {activeDocuments.length > 0 && (
                <section className="recent-section">
                  <div className="section-heading">
                    <h2>Pick up where you left off</h2>
                    <span>{activeDocuments.length} documents</span>
                  </div>
                  <div className="recent-grid">
                    {activeDocuments
                      .slice(-6)
                      .reverse()
                      .map((d) => (
                        <button
                          key={d.id}
                          className="recent-document"
                          onClick={() => {
                            setNotebookId(d.notebook_id);
                            setExpanded((s) => new Set([...s, d.notebook_id]));
                            setDocId(d.id);
                          }}
                        >
                          <div className="recent-icon">
                            <FileText size={22} />
                          </div>
                          <strong>{d.name}</strong>
                          <span>
                            {d.page_count} slides · {d.explained_count}{" "}
                            explained
                          </span>
                          <ArrowUpRight size={17} />
                        </button>
                      ))}
                  </div>
                </section>
              )}
              <div className="home-privacy">
                <ShieldCheck size={14} /> Stored on your Mac. Backed up for
                peace of mind.
              </div>
            </div>
          </div>
        )}
      </main>
      <input
        type="file"
        accept="application/pdf,.pdf"
        ref={upload}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importFile(f);
        }}
      />
      {confirmGeneration && <div className="modal-backdrop" style={{zIndex:1001}}>
        <div className="modal" role="dialog" aria-modal="true" aria-label="Confirm regeneration">
          <h2>Replace saved explanations?</h2>
          <p>Generating again will replace the current {confirmGeneration.kind === 'detail' ? 'long' : ''} explanation for {confirmGeneration.count} slide{confirmGeneration.count===1?'':'s'} when it finishes. Previous text and its markings remain available in History. Personal notes stay saved.</p>
          <div className="detail-actions"><button autoFocus className="button" onClick={()=>setConfirmGeneration(null)}>Cancel</button><button className="button primary" onClick={()=>{const request=confirmGeneration;setConfirmGeneration(null);void generate(request.mode,request.ids,request.kind,true);}}>Regenerate and replace</button></div>
        </div>
      </div>}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {busy && (
        <div className="busy-pill" role="status">
          <Loader2 size={16} className="spin" />
          {busy}
        </div>
      )}
      {nameDialog && (
        <div className="modal-backdrop" onClick={() => setNameDialog(null)}>
          <form
            className="modal small-modal"
            role="dialog"
            aria-modal="true"
            aria-label={nameDialog.kind === "new" ? "New notebook" : "Rename"}
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void saveName();
            }}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">A PLACE FOR YOUR IDEAS</span>
                <h2>
                  {nameDialog.kind === "new"
                    ? "New notebook"
                    : "Give it a name"}
                </h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Close"
                onClick={() => setNameDialog(null)}
              >
                <X size={20} />
              </button>
            </div>
            <label className="field">
              {nameDialog.kind === "documents"
                ? "Document name"
                : "Notebook name"}
              <input
                autoFocus
                maxLength={200}
                placeholder="e.g. Operating Systems"
                value={nameDialog.name}
                onChange={(e) =>
                  setNameDialog({ ...nameDialog, name: e.target.value })
                }
              />
            </label>
            <div className="modal-footer">
              <button
                type="button"
                className="button subtle"
                onClick={() => setNameDialog(null)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={!nameDialog.name.trim()}
              >
                {nameDialog.kind === "new" ? "Create notebook" : "Save name"}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </div>
      )}
      {chat && doc && <ChatDialog slide={chat} epoch={doc.epoch} reasoning={reasoning} paused={!!status?.queue_paused} onClose={()=>setChatSlide(null)} onSaved={()=>void refresh()}/> }
      {detail && doc && <DetailDialog
        slide={detail} epoch={doc.epoch} job={detailJobs.get(detail.id)}
        paused={!!status?.queue_paused} busy={!!busy}
        onClose={() => setDetailSlide(null)}
        onGenerate={() => void generate("selected", [detail.id], "detail")}
        onSaved={() => void refresh()}
      />}
      {showSettings && status && (
        <SettingsDialog
          status={status}
          onClose={() => setShowSettings(false)}
          refresh={refresh}
          notify={setToast}
        />
      )}
      {showTrash && (
        <div className="modal-backdrop" onClick={() => setShowTrash(false)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Trash"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">A SECOND CHANCE</span>
                <h2>Trash</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close trash"
                onClick={() => setShowTrash(false)}
              >
                <X size={20} />
              </button>
            </div>
            <p className="muted">
              Your notes and PDFs stay here until you restore them. Nothing is
              permanently deleted.
            </p>
            {!trashCount && (
              <div className="empty-panel">
                <Trash2 />
                <p>Your trash is empty.</p>
              </div>
            )}
            {library.notebooks
              .filter((n) => n.deleted_at)
              .map((n) => (
                <div className="trash-item" key={n.id}>
                  <BookOpen size={18} />
                  <div>
                    <strong>{n.name}</strong>
                    <span>Notebook and its documents</span>
                  </div>
                  <button
                    className="button"
                    onClick={() =>
                      void action(() =>
                        api(`/notebooks/${n.id}/untrash`, json("POST")),
                      )
                    }
                  >
                    <RotateCcw size={14} /> Restore
                  </button>
                </div>
              ))}
            {library.documents
              .filter((d) => d.deleted_at)
              .map((d) => (
                <div className="trash-item" key={d.id}>
                  <FileText size={18} />
                  <div>
                    <strong>{d.name}</strong>
                    <span>{d.page_count} slides</span>
                  </div>
                  <button
                    className="button"
                    onClick={() =>
                      void action(() =>
                        api(`/documents/${d.id}/untrash`, json("POST")),
                      )
                    }
                  >
                    <RotateCcw size={14} /> Restore
                  </button>
                </div>
              ))}
          </div>
        </div>
      )}
      {lightbox && (
        <div
          className="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={`Slide ${lightbox.page} enlarged`}
          onClick={() => setLightbox(null)}
        >
          <button
            className="lightbox-close"
            aria-label="Close enlarged slide"
            onClick={() => setLightbox(null)}
          >
            <X /> Close
          </button>
          {doc && doc.slides.find(s=>s.id===lightbox.id) && <div className="lightbox-page" style={{width:`min(100%, calc((100dvh - 145px) * ${doc.slides.find(s=>s.id===lightbox.id)!.width/doc.slides.find(s=>s.id===lightbox.id)!.height}))`}}>
            <PdfPage key={`enlarged:${lightbox.id}:${doc.epoch}`} slide={doc.slides.find(s=>s.id===lightbox.id)!} epoch={doc.epoch}/>
          </div>}

          <span>SLIDE {lightbox.page}</span>
        </div>
      )}
    </div>
  );
}

function SettingsDialog({
  status,
  onClose,
  refresh,
  notify,
}: {
  status: Status;
  onClose: () => void;
  refresh: () => Promise<void>;
  notify: (v: string) => void;
}) {
  const [reasoning, setReasoning] = useState(status.reasoning);
  const [folder, setFolder] = useState(status.backup_folder);
  const [backups, setBackups] = useState<{ name: string; size: number }[]>([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  useEffect(() => {
    api<typeof backups>("/backups")
      .then(setBackups)
      .catch((e) => setError(errorText(e)));
  }, []);
  async function run(label: string, task: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await task();
      await refresh();
      setBackups(await api("/backups"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Settings and backups"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">YOUR WORKSPACE, YOUR WAY</span>
            <h2>Settings & backups</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close settings"
            disabled={!!busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <section className="settings-section">
          <h3>
            <Sparkles size={17} /> A little help from Luna
          </h3>
          <div
            className={`key-status ${status.api_key_configured ? "ready" : ""}`}
          >
            <span className="local-dot" />
            {status.api_key_configured
              ? "API key configured"
              : "API key not configured"}
          </div>
          <p>
            Set <code>OPENAI_API_KEY</code> in the project’s <code>.env</code>{" "}
            file, then restart the app. In the desktop app, you can also use Notebook → Configure API key. Your key stays on the backend and is
            never included in backups.
          </p>
          <div className="settings-row">
            <div>
              <strong>Default reasoning</strong>
              <small>Higher effort can use more tokens and take longer.</small>
            </div>
            <select
              aria-label="Default reasoning"
              value={reasoning}
              onChange={(e) => setReasoning(e.target.value as Reasoning)}
            >
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </select>
          </div>
          <p className="tiny-text">
            Model: {status.model}. Slides are sent to OpenAI only when you
            choose Generate. API usage is billed to your account.
          </p>
        </section>
        <section className="settings-section">
          <h3>
            <ShieldCheck size={18} /> A safe place for your notes
          </h3>
          <p>
            Backup ZIPs include original PDFs, slide images, all explanations, detailed explanations, personal notes, and version history. Readable Markdown copies are included too.
          </p>
          <div className="data-path">
            <FolderOpen size={15} />
            <code>{status.data_dir}</code>
          </div>
          <div className="settings-row">
            <div>
              <strong>Automatic backups</strong>
              <small>Daily while running · 7 daily + 4 weekly copies</small>
            </div>
            <span className="status-pill">On</span>
          </div>
          <p className="tiny-text">Last backup: {date(status.last_backup)}</p>
          {status.backup_error && (
            <div className="inline-warning">{status.backup_error}</div>
          )}
          <label className="field">
            Second backup folder <span>Optional</span>
            <input
              placeholder="/Users/you/Library/Mobile Documents/… or /Volumes/…"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
            <small>
              Use an existing iCloud Drive or external-drive folder. Only backup
              archives go here; the live database stays local.
            </small>
          </label>
          <div className="settings-buttons">
            <button
              className="button primary"
              disabled={!!busy}
              onClick={() =>
                void run("Saving…", async () => {
                  await api(
                    "/settings",
                    json("PUT", { reasoning, backup_folder: folder }),
                  );
                  notify("Settings saved.");
                })
              }
            >
              <Check size={15} /> Save settings
            </button>
            <button
              className="button"
              disabled={!!busy}
              onClick={() =>
                void run("Backing up…", async () => {
                  const result = await api("/backups", json("POST"));
                  notify(
                    result.warning ||
                      "Backup created, including your PDFs and notes.",
                  );
                })
              }
            >
              <ShieldCheck size={15} /> Back up now
            </button>
          </div>
        </section>
        <section className="settings-section">
          <h3>
            <HistoryIcon /> Export & restore
          </h3>
          <p>
            Download a complete archive to keep elsewhere, or restore one into
            this app. A safety backup is made before replacing the library.
          </p>
          <div className="backup-list">
            {backups.length === 0 ? (
              <p className="muted">Your backups will appear here.</p>
            ) : (
              backups.slice(0, 8).map((b) => (
                <a href={`/api/backups/${b.name}`} key={b.name}>
                  <FileText size={15} />
                  <span>{b.name}</span>
                  <small>{(b.size / 1024 / 1024).toFixed(1)} MB</small>
                  <Download size={14} />
                </a>
              ))
            )}
          </div>
          <label className="button restore-file">
            <Upload size={15} /> Choose a backup to restore
            <input
              type="file"
              accept=".zip,application/zip"
              disabled={!!busy}
              onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
            />
          </label>
          {restoreFile && (
            <div className="restore-confirm">
              <strong>Replace this library with {restoreFile.name}?</strong>
              <p>
                Save your edits first. Pause the queue and wait for running
                requests to finish. The current library will be kept as a safety
                backup.
              </p>
              <button
                className="button danger"
                disabled={!!busy}
                onClick={() =>
                  void run("Validating and restoring…", async () => {
                    const form = new FormData();
                    form.append("file", restoreFile);
                    await api("/restore", { method: "POST", body: form });
                    notify(
                      "Library restored. A safety backup of your previous library is available.",
                    );
                    setRestoreFile(null);
                    onClose();
                  })
                }
              >
                Restore library
              </button>
              <button
                className="button subtle"
                disabled={!!busy}
                onClick={() => setRestoreFile(null)}
              >
                Cancel
              </button>
            </div>
          )}
        </section>
        {error && (
          <div role="alert" className="inline-warning">
            {error}
          </div>
        )}
        {busy && (
          <div className="settings-busy">
            <Loader2 size={15} className="spin" />
            {busy}
          </div>
        )}
      </div>
    </div>
  );
}
function HistoryIcon() {
  return <RotateCcw size={17} />;
}
