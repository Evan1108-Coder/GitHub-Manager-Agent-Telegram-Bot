# Test Report

Date: 2026-06-13

## Summary

The bot is now a working v1 personal GitHub agent with natural Telegram chat, setup/onboarding, scheduled jobs, GitHub reads, approval-gated GitHub writes, file upload memory, formatted Telegram responses, and live startup/outbound Telegram verification.

It is still not a magical "all GitHub actions with perfect reasoning" agent. The current implementation covers a practical foundation: it parses many common natural GitHub actions, blocks destructive actions by default, asks approval before writes, and falls back to a model for general conversation. A deeper JSON planner/tool executor is still the main next architecture step.

## Fixes Applied

- Added response telemetry storage and a `telemetry`/`slow replies` view.
- Added delayed progress messages, typing indicators, and friendlier timeout/rate-limit/permission errors.
- Added natural job editing: move time, make daily/weekly, set repo filter.
- Added flexible time parsing for:
  - compound intervals such as "every 1 hour and 37 minutes"
  - one-time dates such as "June 21 at 4:37 PM"
  - casual phrasing such as "June 21, 4 PM 37 minute"
  - "tomorrow" and "next Friday afternoon"
  - "every week Monday"
- Added helper snapshot jobs for "N minutes earlier" metric comparisons.
- Extended scheduled metric checks to stars plus recent workflow failures.
- Added approval execution for core GitHub writes:
  - create/update/comment issue or PR
  - add issue/PR labels
  - update repo description/metadata
  - replace topics
  - update files by full content or exact line
  - create branches
  - open PRs
  - create releases
  - rerun/cancel/dispatch workflows
- Added hard blocking for destructive actions:
  - delete repo
  - transfer repo
  - change visibility
  - delete branch
  - delete file
  - collaborator/member changes
- Added README patch approvals and stale README detection by comparing repo activity against README activity.
- Added uploaded-file search and "create issue from uploaded file" approval flow.
- Added security/dependency alert check using Dependabot alerts where the token has access.
- Added GitHub traffic views/clones to stats where GitHub allows access.
- Added `/settings` and `/reset_setup`.

## Automated Checks

Commands run:

```bash
npm test
npm run smoke
npm audit --audit-level=moderate
npm start
```

Results:

- Unit/integration tests: passed, 33/33.
- GitHub smoke test: passed.
- GitHub API authenticated as the configured user.
- Model detection found MiniMax models from `.env`.
- Cheapest configured model selected: `minimax-m2.5-lightning`.
- npm audit: 0 moderate-or-higher vulnerabilities.
- Live bot polling startup: passed as `@GitHubAgentManagerBot`.
- Telegram outbound message through Bot API: passed.

## Telegram Limitation

I verified real startup and real outbound Telegram delivery. I did not impersonate the user's Telegram account for inbound messages. Telegram's Bot API does not let a bot create fake inbound user messages, and driving the local Telegram desktop app would be more intrusive than useful here. Inbound behavior is covered by handler-level tests.

## Criteria Coverage

### Working

- `.env` is read locally and not committed.
- SQLite database auto-creates required tables.
- First-time setup reads env values and asks user-specific questions.
- Setup accepts casual answers, skips, defaults, and side questions.
- Telegram messages use HTML formatting, emojis, link-safe output, and safe chunking.
- Long tasks show progress/typing instead of silently hanging.
- Runtime model preference affects model selection.
- Supported model providers are detected from configured keys.
- Natural recurring jobs are stored as editable plans.
- Daily, weekly, interval, compound interval, one-time, tomorrow, and next-weekday schedules parse.
- "N minutes earlier" comparisons create helper prefetch jobs.
- Jobs can be listed, paused, resumed, deleted, moved, and changed to daily/weekly.
- GitHub auth, repo reads, issues, PRs, releases, workflow reads, commits, README/file reads work through the client.
- Stats snapshots store stars, forks, views, and clones where available.
- Repo/README presentation audits work.
- Stale README checks compare latest repo commit against README commit.
- Trend digest plumbing works with source fallbacks.
- Uploaded files are stored with extracted text/summary.
- Text, Markdown, CSV, JSON, HTML, PDF, DOCX, PPTX, RTF, PNG, JPG/JPEG, and AVIF are routed.
- Image uploads use vision when the configured model supports vision.
- Core GitHub writes create approval cards with approve/edit/cancel buttons.
- Approved core writes have execution handlers.
- Destructive GitHub operations are blocked by default.
- Approval history and response telemetry can be viewed.
- Token status/rate-limit details can be shown.
- Live bot startup works.
- Outbound Telegram messaging works.

### Partial

- The planner is still pattern-based plus LLM fallback, not a full general JSON planning engine.
- Natural repo resolution is basic. Exact `owner/repo` works best.
- The bot can code/edit files, but it is intentionally not a full coding agent.
- GitHub traffic and Dependabot alerts depend on token permissions and repository settings.
- Historical comparisons are only accurate after snapshots exist.
- Vision depends on a vision-capable configured model; the current local default MiniMax model is not vision-capable.
- Profile README updates only auto-apply inside the configured bot-controlled block.
- Proactive monitoring exists through scheduled jobs and checks, but webhook-based real-time monitoring is not implemented.

### Not Yet Complete

- Full GitHub API coverage for every admin/settings/collaborator operation.
- Webhook-based GitHub event monitoring.
- Full semantic planner that decomposes arbitrary multi-step requests into validated tool JSON.
- Deep code-editing/test-running workflows comparable to a dedicated coding agent.
- OCR for scanned PDFs/screenshots.
- Robust long-term semantic memory retrieval.
- Provider health checks and live pricing refresh.
- Fine-grained token permission introspection beyond GitHub headers/API failures.

## Manual User Test Checklist

1. Start the bot with `npm start`.
2. In Telegram, try:
   - `/start`
   - `show jobs`
   - `move job #1 to 8:15 AM`
   - `set verbosity to quick`
   - `create issue in owner/repo titled "Fix docs" body "Add setup section"`
   - `delete repository owner/repo`
   - `show open PRs in owner/repo`
   - `every Monday at 9 compare stars for owner/repo 5 minutes earlier than now`
3. Upload a supported file, then ask:
   - `create issue from uploaded file in owner/repo`
4. Confirm approval buttons behave correctly before using write actions on important repos.
