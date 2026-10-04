import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Clock3,
  History,
  Pencil,
  X,
  AlertCircle,
  RotateCcw,
  MessageCircle,
} from "lucide-react";
import { api, ApiError, json, type Note } from "./api";
import { RichText } from "./RichText";
import { AnnotatedText } from "./AnnotatedText";
export { RichText } from "./RichText";

interface Draft {
  body: string;
  revision: number;
}
interface Version {
  id: string;
  body: string;
  origin: string;
  created_at: string;
  model?: string;
  reasoning?: string;
  usage?: string;
}

export function Editor({
  note,
  epoch,
  onSaved,
  readingMode = false,
  onDetails,
  onChat,
}: {
  note: Note;
  epoch: string;
  onSaved: () => void;
  readingMode?: boolean;
  onDetails?: () => void;
  onChat?: () => void;
}) {
  const key = `slide-notes:draft:${epoch}:${note.slide_id}:${note.kind}`;
  const initial = useRef<Draft | null>(null);
  const initialized = useRef(false);
  if (!initialized.current) {
    initialized.current = true;
    try {
      initial.current = JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      /* A bad draft must not hide the server copy. */
    }
  }
  const [body, setBody] = useState(initial.current?.body ?? note.body);
  const [editing, setEditing] = useState(
    !!initial.current,
  );
  const [state, setState] = useState<
    "saved" | "pending" | "saving" | "error" | "conflict"
  >(
    initial.current && initial.current.body !== note.body
      ? initial.current.revision === note.revision
        ? "pending"
        : "conflict"
      : "saved",
  );
  const [message, setMessage] = useState("");
  const [current, setCurrent] = useState<Note | undefined>(
    initial.current && initial.current.revision !== note.revision
      ? note
      : undefined,
  );
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [preview, setPreview] = useState<Version | null>(null);
  const value = useRef(body);
  const base = useRef({
    body: note.body,
    revision: initial.current?.revision ?? note.revision,
  });
  const busy = useRef(false);
  const alive = useRef(true);
  const blocked = useRef(state === "conflict");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const persist = useCallback(
    (text: string, revision: number) => {
      try {
        localStorage.setItem(key, JSON.stringify({ body: text, revision }));
      } catch {
        setMessage(
          "Local draft storage is unavailable. Keep this tab open until Saved appears.",
        );
      }
    },
    [key],
  );
  const save = useCallback(
    async (overrideRevision?: number) => {
      if (
        busy.current ||
        (blocked.current && overrideRevision === undefined) ||
        (value.current === base.current.body && overrideRevision === undefined)
      )
        return;
      const snapshot = value.current;
      const revision = overrideRevision ?? base.current.revision;
      busy.current = true;
      if (alive.current) setState("saving");
      try {
        const result = await api<Note>(
          `/slides/${note.slide_id}/notes/${note.kind}`,
          json("PUT", { body: snapshot, revision, epoch }),
        );
        base.current = { body: result.body, revision: result.revision };
        blocked.current = false;
        if (value.current === snapshot) {
          // Another tab may have its own pending draft; only remove the draft we saved.
          try {
            const stored = JSON.parse(localStorage.getItem(key) || "null");
            if (stored?.body === snapshot) localStorage.removeItem(key);
          } catch {
            /* Keep any unreadable draft. */
          }
          if (alive.current) {
            setState("saved");
            setMessage("");
            setCurrent(undefined);
          }
        } else {
          persist(value.current, result.revision);
          if (alive.current) setState("pending");
        }
        savedCallback.current();
      } catch (error) {
        if (alive.current) {
          if (error instanceof ApiError && error.status === 409) {
            blocked.current = true;
            setState("conflict");
            setCurrent(error.current);
          } else setState("error");
          setMessage(
            error instanceof Error
              ? error.message
              : "Could not save. Your draft is kept in this browser.",
          );
        }
      } finally {
        busy.current = false;
      }
    },
    [epoch, key, note.slide_id, note.kind, persist],
  );
  useEffect(() => {
    alive.current = true;
    const interval = setInterval(() => {
      if (
        !busy.current &&
        !blocked.current &&
        value.current !== base.current.body
      )
        void save();
    }, 2500);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (value.current !== base.current.body) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      alive.current = false;
      clearInterval(interval);
      clearTimeout(timer.current);
      window.removeEventListener("beforeunload", beforeUnload);
      void save();
    };
  }, [save]);
  useEffect(() => {
    if (
      !busy.current &&
      value.current === base.current.body &&
      note.revision >= base.current.revision
    ) {
      base.current = { body: note.body, revision: note.revision };
      value.current = note.body;
      setBody(note.body);
    }
  }, [note.body, note.revision]);
  function change(text: string) {
    value.current = text;
    setBody(text);
    persist(text, base.current.revision);
    if (!blocked.current)
      setState(text === base.current.body ? "saved" : "pending");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 600);
  }
  async function history() {
    try {
      setVersions(
        await api(`/slides/${note.slide_id}/notes/${note.kind}/history`),
      );
      setPreview(null);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  async function restore(version: Version) {
    if (value.current !== base.current.body) {
      setMessage("Save or resolve your draft before restoring a version.");
      return;
    }
    try {
      const result = await api<Note>(
        `/versions/${version.id}/restore`,
        json("POST", { revision: base.current.revision, epoch }),
      );
      value.current = result.body;
      base.current = { body: result.body, revision: result.revision };
      setBody(result.body);
      setVersions(null);
      setState("saved");
      savedCallback.current();
    } catch (error) {
      setMessage((error as Error).message);
    }
  }
  function useServer() {
    if (!current) return;
    // Preserve discarded draft as a recovery copy rather than destroying it.
    try {
      localStorage.setItem(`${key}:recovered:${Date.now()}`, value.current);
      localStorage.removeItem(key);
    } catch {
      /* Server copy remains safe. */
    }
    base.current = { body: current.body, revision: current.revision };
    value.current = current.body;
    setBody(current.body);
    blocked.current = false;
    setState("saved");
    setMessage("");
    setCurrent(undefined);
  }
  return (
    <section
      className={`note-editor ${note.kind} ${readingMode && note.kind === "personal" && !body.trim() && state === "saved" ? "empty-reading-note" : ""}`}
    >
      <div className="note-heading">
        <span>{note.kind === "personal" ? "MY NOTES" : note.kind === "detail" ? "DETAILED EXPLANATION" : "EXPLANATION"}</span>
        <div className="note-tools">
          {onChat && <button className="chat-trigger" aria-label="Ask about this slide" title="Ask about this slide" onClick={onChat}><MessageCircle size={15}/></button>}
          {onDetails && <button className="chat-trigger" onClick={onDetails} title="Preview long explanation" aria-label="Preview long explanation">↗</button>}
          <span className={`save-state ${state}`} title={message}>
            {state === "saved" ? (
              <Check size={12} />
            ) : state === "saving" || state === "pending" ? (
              <Clock3 size={12} />
            ) : (
              <AlertCircle size={12} />
            )}{" "}
            {state === "saved"
              ? "Saved"
              : state === "pending"
                ? "Unsaved"
                : state === "saving"
                  ? "Saving…"
                  : state === "conflict"
                    ? "Conflict"
                    : "Not saved"}
          </span>
          <button
            className="icon-button"
            aria-label={`View ${note.kind} history`}
            title="Version history"
            onClick={() => void history()}
          >
            <History size={15} />
          </button>
          {note.kind === "personal" ? (
            <button className="personal-edit-button" onMouseDown={e=>e.preventDefault()} disabled={state === "saving"} aria-label={editing ? "Save personal notes" : "Edit personal notes"} onClick={async()=>{
              if(editing){await save();if(value.current === base.current.body && !blocked.current)setEditing(false);}
              else setEditing(true);
            }}>{editing ? <><Check size={13}/> Save</> : <><Pencil size={13}/> Edit</>}</button>
          ) : (
            <button
              className={`icon-button ${editing ? "active" : ""}`}
              aria-label={editing ? "Preview explanation" : "Edit explanation"}
              title={editing ? "Preview" : "Edit explanation"}
              onClick={() => {
                void save();
                setEditing(!editing);
              }}
            >
              {editing ? <Check size={15} /> : <Pencil size={14} />}
            </button>
          )}
        </div>
      </div>
      {editing && !readingMode ? (
        <textarea
          aria-label={
            note.kind === "personal" ? "Personal notes" : note.kind === "detail" ? "Detailed explanation" : "Explanation"
          }
          className={
            note.kind === "personal" ? "personal-input" : "explanation-input"
          }
          value={body}
          onChange={(e) => change(e.target.value)}
          onBlur={() => void save()}
          placeholder={
            note.kind === "personal"
              ? "Add a thought, a question, or something to remember…"
              : "Write your explanation here. Markdown and math are supported."
          }
        />
      ) : body ? (
        <AnnotatedText key={`${note.slide_id}:${note.kind}:${body}`} body={body} note={note} epoch={epoch} enabled={body === note.body && state === "saved"} />
      ) : note.kind === "personal" ? <p className="empty-personal-note">Save useful chat answers here, or choose Edit to write a note.</p> : (
        <div className="empty-explanation">
          <span className="small-spark">✧</span>
          <p>A little clarity goes here.</p>
          <span>
            {readingMode ? (
              "No explanation yet. Exit reading mode to add one."
            ) : (
              <>
                Select this slide and generate an explanation,
                <br />
                or write your own.
              </>
            )}
          </span>
          <button
            className="text-button write-explanation"
            onClick={() => setEditing(true)}
          >
            Write an explanation <Pencil size={12} />
          </button>
        </div>
      )}
      {message && <div className="inline-warning">{message}</div>}
      {state === "error" && (
        <button className="text-button" onClick={() => void save()}>
          Retry saving
        </button>
      )}
      {state === "conflict" && (
        <div className="conflict-box">
          <p>
            Your draft is safe here. Another edit or a restored library changed
            the saved note.
          </p>
          {current ? (
            <>
              <button
                onClick={() => {
                  blocked.current = false;
                  void save(current.revision);
                }}
              >
                Keep my draft
              </button>
              <button onClick={useServer}>Use saved version</button>
              <details>
                <summary>Compare saved version</summary>
                <RichText body={current.body} />
              </details>
            </>
          ) : (
            <button onClick={() => window.location.reload()}>
              Reload library
            </button>
          )}
        </div>
      )}
      {versions && (
        <div className="modal-backdrop" onClick={() => setVersions(null)}>
          <div
            className="modal history-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Version history"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">NOTHING LOST</span>
                <h2>Version history</h2>
              </div>
              <button
                className="icon-button"
                aria-label="Close history"
                onClick={() => setVersions(null)}
              >
                <X />
              </button>
            </div>
            {versions.length === 0 ? (
              <p className="muted">
                Versions appear when you save or generate an explanation.
              </p>
            ) : (
              <div className="history-layout">
                <div className="version-list">
                  {versions.map((v) => (
                    <button
                      className={preview?.id === v.id ? "selected" : ""}
                      key={v.id}
                      onClick={() => setPreview(v)}
                    >
                      <strong>
                        {v.origin === "generation"
                          ? "AI explanation"
                          : v.origin === "restore"
                            ? "Restored version"
                            : "Your edit"}
                      </strong>
                      <span>{new Date(v.created_at).toLocaleString()}</span>
                      {v.model && (
                        <small>
                          {v.model} · {v.reasoning}
                        </small>
                      )}
                    </button>
                  ))}
                </div>
                <div className="version-preview">
                  {preview ? (
                    <>
                      <RichText body={preview.body} />
                      <button
                        className="button primary"
                        disabled={value.current !== base.current.body}
                        onClick={() => void restore(preview)}
                      >
                        <RotateCcw size={15} /> Restore this version
                      </button>
                      {value.current !== base.current.body && (
                        <p className="muted">
                          Save or resolve your current draft first.
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="muted">Choose a version to preview it.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
