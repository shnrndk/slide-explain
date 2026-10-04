# Local operation and credentials

Slide Explain runs its notebook service on 127.0.0.1. Each user supplies their own OpenAI API key. Keys stay in backend configuration; they are excluded from the interface, source control, desktop bundle, and backups. AI requests send the selected slide image, extracted text, bounded adjacent-slide context, and relevant question/history to OpenAI. Importing and studying saved notes are local operations.

Do not commit `.env`, `config.env`, notebook databases, imported PDFs, or backup archives. Keep the local service bound to localhost. The current application is single-user and does not provide hosted account authentication or tenant isolation.
