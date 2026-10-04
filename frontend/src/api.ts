export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public current?: Note,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "X-Slide-Notes": "1",
      ...(!(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "The local app is not responding." }));
    throw new ApiError(
      typeof error.detail === "string"
        ? error.detail
        : "Please check the values and try again.",
      response.status,
      error.current,
    );
  }
  return response.json();
}
export const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
export interface Note {
  slide_id: string;
  kind: "explanation" | "personal" | "detail";
  body: string;
  revision: number;
  updated_at: string;
}
export interface Slide {
  document_id?: string;
  id: string;
  page_number: number;
  width: number;
  height: number;
  explanation: Note;
  personal: Note;
  detail: Note;
}
export interface Notebook {
  id: string;
  name: string;
  deleted_at: string | null;
}
export interface Document {
  id: string;
  notebook_id: string;
  name: string;
  page_count: number;
  explained_count: number;
  deleted_at: string | null;
  created_at: string;
}
export interface FullDocument extends Document {
  slides: Slide[];
  epoch: string;
}
export interface Status {
  api_key_configured: boolean;
  model: string;
  data_dir: string;
  epoch: string;
  queue_paused: boolean;
  reasoning: Reasoning;
  backup_folder: string;
  last_backup: string | null;
  backup_error: string | null;
}
export type Reasoning = "medium" | "high" | "xhigh";
export interface Job {
  kind: "explanation" | "detail";
  id: string;
  slide_id: string;
  page_number: number;
  status: string;
  error: string | null;
  reasoning: Reasoning;
  created_at: string;
}
