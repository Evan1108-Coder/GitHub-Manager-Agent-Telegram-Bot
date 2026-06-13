# Test Report

Date: 2026-06-13

## Summary

The bot works as a first usable v1 personal GitHub agent, but it is not yet a complete "all GitHub actions" agent. The strongest working areas are setup, Telegram startup, outbound Telegram messaging, GitHub read access, scheduled job storage, repo/README presentation audits, trend digest plumbing, stats snapshots, and natural recurring task creation.

The most important gaps found during this audit were fixed:

- Runtime model switching was saved but not used by model selection.
- Default jobs enabled during onboarding were not seeded until restart.
- Scheduling was based on local machine time rather than the configured timezone.
- "Every 1 hour and 37 minutes" and "June 21 at 4:37 PM" style schedules were not parsed.
- "N minutes earlier" metric requests were stored as text only; now they create a helper snapshot job.
- Jobs could be listed but not paused/resumed/deleted naturally.

Additional UX issue reported after live use:

- Some messages could take far too long with no visible feedback, especially when an LLM provider was slow.

Fixes applied:

- Added typing indicators for long tasks.
- Added delayed progress messages for generic AI answers.
- Added a configurable model timeout (`LLM_TIMEOUT_MS`, default 35s).
- Added friendly timeout/permission/rate-limit error messages.
- Reduced generic answer token budget.
- Made daily GitHub summary repo checks concurrent with a limit instead of fully sequential.
- Improved Telegram copy with emoji, bold section headers, and clearer status messages.

## First-Round User Simulation

I tested the bot as a first-time user conceptually and through handler-level simulations:

- New user setup reads `.env` first.
- Setup can answer side questions such as "what is a profile repo?" and returns to setup.
- Setup accepts casual answers, skips, and defaults.
- Natural job creation works for a complex request:
  - "every 97 minutes tell me the stars of example-user/repo-a plus example-user/repo-b"
- Complex timing logic now creates helper jobs:
  - "every Monday at 9 compare stars for example-user/repo-a 5 minutes earlier than now"
- Job listing works.
- Job pausing works through natural language:
  - "pause job 1"

## Live Checks

Commands run:

```bash
npm test
npm run smoke
npm audit --audit-level=moderate
npm start
```

Results:

- Unit/integration tests: passed, 15/15.
- GitHub smoke test: passed.
- GitHub API authenticated as the configured user.
- Model detection found MiniMax models from `.env`.
- Cheapest configured model selected: `minimax-m2.5-lightning`.
- npm audit: 0 moderate-or-higher vulnerabilities.
- Live bot startup: passed.
- Telegram outbound message through Bot API: passed.
 - UX patch smoke test: passed.

## Telegram User Chat Limitation

I verified outbound bot messaging through Telegram's Bot API and live bot startup/polling. I did not impersonate the user's Telegram account because the Bot API cannot send inbound user messages to a bot. Telegram.app is installed locally, but driving a logged-in desktop Telegram client reliably would require GUI automation permissions and may be intrusive. Inbound behavior is covered by direct handler integration tests.

Manual user test still recommended:

1. Run `npm start`.
2. Open Telegram and message the bot:
   - `/start`
   - `show jobs`
   - `audit my repos`
   - `every 1 hour and 37 minutes tell me the stars of Evan1108-Coder/TrendForge-Telegram-Bot`
   - `pause job 1`

## Criteria Coverage

### Working

- Telegram bot starts.
- Telegram outbound messages work.
- Long tasks send clearer acknowledgement/progress messages.
- Generic AI answers send a progress message if the model is slow.
- Model calls now have a practical timeout instead of leaving chat stuck.
- HTML formatting and message splitting are implemented.
- `.env` is ignored and `.env.example` exists.
- SQLite database auto-creates.
- Setup reads `.env`.
- Setup supports side questions.
- Setup supports skip/default style answers.
- GitHub auth works.
- GitHub repo/user API reads work.
- GitHub rate-limit headers are tracked.
- Repo presentation audit exists.
- README quality audit exists.
- Suspicious/low-quality commit message detection exists.
- Default jobs exist and are editable scheduled jobs.
- Natural recurring job creation works.
- Daily, weekly, interval, compound interval, and one-time month/date schedules parse.
- Timezone-aware next-run calculation exists.
- "N minutes earlier" metric comparisons create helper snapshot jobs.
- Jobs can be listed.
- Jobs can be paused, resumed, and deleted by natural language.
- Stats snapshots are stored.
- Trend sources are fetched with fallbacks.
- File extraction supports text, PDF, DOCX, PPTX, RTF, HTML/JSON/CSV/Markdown/text.
- Image uploads route to vision-capable model handling when configured.
- Model provider detection works.
- Runtime model preference now affects selection.
- Friendly user-facing errors exist for timeout, permission, and rate-limit failures.
- Tests and smoke script exist.
- npm audit is clean.

### Partial

- Natural language planning is pattern-based with LLM fallback, not a full general planner yet.
- Approval storage and inline approval callbacks exist, but most write actions do not yet have full execution handlers.
- Profile updates only support a controlled stats block.
- GitHub write support is present at the client layer, but not exposed for every GitHub operation yet.
- File vision depends on a configured vision-capable model; the current local MiniMax default is not vision-capable.
- Traffic/views depend on GitHub token permissions and GitHub API availability.
- Dependabot/security alert checks depend on token permission and repository settings.
- Proactive monitoring exists as scheduled jobs, but continuous intelligent monitoring policies are still basic.
- Historical comparisons are accurate after snapshots exist; the bot correctly cannot know old data it never captured.

### Not Yet Complete

- Full "all GitHub actions" coverage.
- Full diff preview and approval execution pipeline for every write.
- Branch/PR creation flow exposed through natural chat.
- Release creation flow exposed through natural chat.
- Workflow dispatch/rerun/cancel exposed through natural chat.
- Issue creation/update exposed through approval UI.
- Repo settings/collaborator/admin actions.
- Deep code editing with test execution.
- Webhook-based GitHub event monitoring.
- OCR for scanned PDFs/images.
- Robust semantic memory retrieval.
- Full automatic stale README detection based on commit diffs.
- Full token-expiration proactive reminder beyond surfacing expiration header when GitHub provides it.

## Fixes Applied During This Audit

- Added runtime model preference support in model selection.
- Added timezone-aware daily/weekly schedule calculations.
- Added compound interval parsing.
- Added one-time date parsing for requests such as "June 21 at 4:37 PM".
- Added helper snapshot jobs for "N minutes earlier" star comparison plans.
- Added `snapshot_metric` job execution.
- Added natural job pause/resume/delete.
- Seed default jobs immediately after onboarding completion.
- Added tests for the new behavior.
