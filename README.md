# Slide Explain — Mac desktop app

Study a PDF with each slide on the left and an explanation on the right. Slide Explain keeps your notebooks, notes, chat conversations, and explanation history on your Mac. You supply your own OpenAI API key; API usage is billed to your account.

## Download and install

1. Download `Slide-Explain-0.1.0-macos-arm64.zip` from the [GitHub releases page](https://github.com/shnrndk/slide-explain/releases/latest).
2. Unzip it and drag **Slide Explain.app** into **Applications**.
3. Open the app. Choose **Notebook → Configure API key…**, enter your OpenAI API key, then quit and reopen the app.
4. Create a notebook and import a PDF. Export PowerPoint or Keynote slides to PDF before importing.

**Supported desktop:** Apple Silicon Macs (M1 or newer). This release does not include Intel Mac, Windows, or Linux desktop builds. The downloaded app bundles Python, PDF rendering, and the interface, so users do not need Node, Python, or a terminal to run it.

The first release is ad-hoc signed and **not Apple-notarized**. macOS may block the first launch; review [Apple’s instructions for opening an app from an unidentified developer](https://support.apple.com/en-us/102445). The ZIP and its SHA-256 checksum are published together.

Reading, importing, editing, and backups work offline after installation. Generating explanations, detailed answers, and chat replies requires internet and access to the configured model. The default is `gpt-6-luna` with high reasoning; medium and extra high settings are available. Model availability depends on your OpenAI account.

## Build the desktop app from source

Build on an **Apple Silicon Mac**. Install these development tools first:

- Git and Apple’s command-line tools: `xcode-select --install` if they are not installed.
- **Node 22.21.1**, or a newer Node 22. If you use nvm, run `nvm install 22.21.1` and `nvm use 22.21.1`.
- **uv**, using [the official installation instructions](https://docs.astral.sh/uv/getting-started/installation/). uv installs the pinned **Python 3.12.13** runtime and locked dependencies.

```sh
git clone https://github.com/shnrndk/slide-explain.git
cd slide-explain
./scripts/build-desktop.sh
```

The script installs the locked Python dependencies including the desktop extras, installs the frontend with `npm ci`, builds the interface, and bundles the native app with PyInstaller. The first build needs internet to download development dependencies. **An API key is not required to build.**

The finished app is:

```text
dist/Slide Explain.app
```

Open that app in Finder, or run:

```sh
open "dist/Slide Explain.app"
```

Configure your key through the app’s **Notebook** menu. No `.env` file, API key, or personal notebook is included in the bundle. Local changes to the app or interface require rebuilding the app.

### Build a distributable ZIP

```sh
./scripts/package-desktop.sh
```

This builds the app, runs a packaged smoke check with an empty temporary library, verifies the signature, and writes:

```text
dist/Slide-Explain-0.1.0-macos-arm64.zip
dist/SHA256SUMS.txt
```

The ZIP contains **Slide Explain.app**. Verify a downloaded ZIP with:

```sh
shasum -a 256 -c SHA256SUMS.txt
```

Run that command in the folder containing both the ZIP and `SHA256SUMS.txt`. Ad-hoc signing verifies bundle integrity but does not provide Apple Developer ID signing or notarization.

## Use the app

- Import PDFs up to 100 MB / 500 pages. Password-protected PDFs must be unlocked first.
- Explain all, selected, or missing slides. The queue runs at most two AI requests together; pause, cancel, and retry controls are available.
- Use **Reading mode** for a focused view and the moon/sun button for dark mode.
- Use **Explain in detail** for a separate saved explanation. The small speech bubble opens a saved chat about the current slide.
- Select useful text in a chat reply and choose **Add to my notes**. Personal notes open for reading; choose **Edit**, then **Save** to change them.
- Select saved explanation or note text to highlight it in yellow, green, blue, or pink, or underline it. Markings are saved locally.
- Edit explanations using the pencil button. Markdown, code blocks, and mathematical notation are supported. Autosave, pending draft recovery, conflict checks, and history protect edits.
- Deleted documents and notebooks go to recoverable trash.

Closing the desktop app stops its owned backend. The app warns about unfinished generation or unsaved edits; interrupted requests are preserved for explicit retry. If an already-running local browser backend owns the same library, the desktop app uses that backend and leaves it running when you quit.

## Your data and backups

New installations save to:

```text
~/Library/Application Support/Slide Explain/
  config.env          # private API-key configuration
  notes.sqlite3       # notebooks, notes, history, chats, jobs, settings
  assets/<id>/        # original.pdf and rendered slide images
  backups/            # complete portable ZIP backups
```

Existing **Slide Notes** installations continue using their original Application Support folder automatically. Installing a new app bundle does not replace your library. `SLIDE_EXPLAIN_DATA_DIR` can override the directory; the old `SLIDE_NOTES_DATA_DIR` setting remains supported. Native window drafts and preferences retain their compatible storage identifiers.

Use **Settings & backups → Back up now** to create a complete downloadable backup. Backups include original PDFs, slide images, notes, conversations, explanation history, markings, and readable Markdown exports. They exclude API keys. Daily backups retain seven recent days and four recent weeks; an optional second folder can hold another copy.

Restore validates archive checksums, database integrity, and assets, then makes a safety backup. Pause generation and allow active requests to finish before restoring. SQLite transactions, foreign keys, WAL journaling, and full durability protect saved records. Keep the live data directory on a local disk and run one backend per library.

## Development and tests

```sh
uv sync --frozen --extra desktop
uv run pytest -q
cd frontend
npm ci
npm test
npm run build
```

A packaged smoke check imports and renders a generated two-page PDF without using an API key or changing your library:

```sh
SLIDE_EXPLAIN_DATA_DIR="$(mktemp -d)" \
  "dist/Slide Explain.app/Contents/MacOS/Slide Explain" --check
```

For optional local browser development, copy `.env.example` to `.env`, set your own key, and run `./start.command`. Open `http://127.0.0.1:8000`; keep the terminal open. You can run `npm run dev` inside `frontend` against that backend. This browser launcher is a development alternative to the packaged Mac app.

## Source layout

- `desktop/`: native Mac window, key configuration, backend lifecycle, and PyInstaller specification.
- `frontend/src/`: study interface, editors, annotations, and chat.
- `backend/`: local API, SQLite storage, PDF import, AI queue, and backup/restore.
- `scripts/build-desktop.sh`: builds the standalone Mac app.
- `scripts/package-desktop.sh`: verifies and packages a release ZIP.
- `tests/`: integration tests using generated PDFs and mocked API responses.

Version 0.1.0 is a single-user local desktop app with PDF imports. Cloud accounts, synchronization, handwriting, and drawing on slide images are outside this release.

![Slide beside its editable explanation](docs/preview.jpg)

The preview uses a generated test PDF and a manually entered sample explanation.

## Explanation length

Choose **Brief**, **Medium**, or **Long** in the document toolbar. Brief is the default and preserves essential definitions, conditions, formulas, and caveats. Medium uses the original balanced style. Length is separate from reasoning effort and applies to new generation requests. Existing explanations stay as saved.

The small **↗** button beside an explanation opens its saved long preview (and generates one if needed). Choose **Use for this slide** to replace the main explanation. Earlier text and its markings remain recoverable through history; personal notes are unchanged. Markings on the accepted long explanation are copied to the main view. Save any pending edits first.

Markdown supports headings, lists, blockquotes, tables, inline code, fenced code blocks with a language label and Copy button, and math. Highlights and underlines are included in backup archives and restored with their exact text.

## Resume reading and regeneration confirmation

Reading progress is saved per document in SQLite, including the slide and position within it. Returning to a document resumes that position; reopening the app returns to the last document. Progress is included in backups.

Generating an explanation again asks for confirmation when it would replace saved text, including long previews and batch regeneration. Cancel leaves the current explanation untouched. Prior text and markings remain in History after replacement.
