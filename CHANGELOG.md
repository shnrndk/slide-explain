# Changelog

## 0.4.0 — Unreleased

- Add image upload, paste/drop and saved-image reuse in personal notes.
- Add click-to-load YouTube videos and offline Mermaid diagrams with common templates.
- Preserve note images with history and include attachments, diagram source and video links in validated backups.
- Keep annotation text offsets stable when diagrams render or video players open.

## 0.3.0 — Unreleased

- Select, highlight, and underline text on PDF pages and in the enlarged slide view.
- Moved slide enlargement to a small button beside each slide.
- Persist PDF text positions and markings in database migration 6 and complete backups.
- Load text layers lazily; scanned pages show an OCR hint.


## 0.2.1 — Unreleased

- Added a live Markdown preview and formatting hint while editing personal notes.
- Enlarged the note editor for multiline Markdown, code, and math. Saved notes remain selectable for highlighting and underlining.

## 0.2.0 — 2026-10-04

- Added Brief, Medium, and Long explanation lengths; Brief is the default.
- Added a small long-preview button and a “Use for this slide” action. Earlier explanations and their highlights stay recoverable in History.
- Added labeled Markdown code blocks with a Copy button.
- Save the last document, slide, and reading position in the database. Reopening a document or the app resumes reading; backups include this progress.
- Ask for confirmation before regeneration replaces saved explanations, including long previews and batch requests. Personal notes remain unchanged.
- Fixed stale desktop interface caching so rebuilt apps display the updated controls.

The macOS download supports Apple Silicon Macs. It is ad-hoc signed and not Apple-notarized. Existing local libraries and API-key configuration are preserved when replacing the app.
