# Changelog

## 1.0.0

First stable release. Hardening pass across parsing, safety, routing, output
quality, and file handling, verified with live LLM (MiniMax) and live GitHub
runs in addition to the unit suite (50 tests, 0 vulnerabilities).

### Output quality
- LLM replies are now rendered from Markdown into Telegram-safe HTML
  (`**bold**`, headings, `code`, code blocks, links, bullets) instead of showing
  raw Markdown symbols. A tag-balancer guarantees Telegram never rejects a
  message, even on malformed Markdown.
- Stripped reasoning/tool-call markup (`<think>…`, `<minimax:tool_call>`,
  `<invoke>`, `<parameter>`) that some models leak into plain replies, and told
  the model it has no callable tools.
- Empty model responses now show a helpful prompt instead of a blank bubble.

### Routing
- The broad `status`/`settings`/`config` catch-all no longer shadows more
  specific intents. "github token status", "status of trends", and
  "config my stats" now reach the correct handler.

### Safety (parser)
- Destructive intent (repo delete/transfer, visibility changes, branch/file
  delete, collaborator changes) is blocked even when phrased without an explicit
  `owner/repo`, and visibility blocks are word-order independent while still
  letting benign issue/release/description text mention "public/private".
- Approval previews truncate the raw diff before HTML-escaping so a long diff
  can no longer cut an HTML entity in half and break the approval card.
- Issue titles are no longer accidentally populated from a pasted URL.

### Files
- Upgraded `pdf-parse` to 2.x, which reads PDFs that the old version rejected
  with "bad XRef entry". Unreadable files (scanned, encrypted, unsupported) now
  return a friendly message instead of a raw library error.

### Scheduling
- Zero/negative interval schedules ("every 0 minutes") are rejected so they
  can't spawn a runaway job.
- A failing scheduled job no longer blocks the other jobs due at the same time.
