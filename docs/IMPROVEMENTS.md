# Improvement Backlog

This list is intentionally honest. The current bot is a working v1 foundation, not the final "handles every possible GitHub request perfectly" agent.

## Recently Completed

- Basic response telemetry and `telemetry` view.
- Formatted Telegram messages with safer splitting.
- Long-task typing/progress updates and friendlier errors.
- Natural job creation, listing, pause/resume/delete, and basic edits.
- Flexible schedule parsing for compound intervals, one-time dates, tomorrow, next weekday, and weekly variants.
- Helper prefetch jobs for "N minutes earlier" metric checks.
- Approval cards with approve/edit/cancel buttons.
- Execution handlers for core GitHub writes: issues, labels, repo metadata, topics, files, branches, PRs, releases, and workflows.
- Dangerous-action blocking for repo deletion, transfers, visibility changes, branch/file deletion, and collaborator changes.
- Uploaded-file memory, search, and issue creation from latest upload.
- Stale README detection and README patch approvals.
- Dependabot/security alert check where token permissions allow it.
- GitHub views/clones in stats where GitHub allows traffic access.

## Highest Priority

1. Build a real structured planning layer.
   - LLM returns validated JSON plans.
   - Code validates tools, arguments, permissions, risk, and required approvals.
   - Executor can recover from partial failures and ask clarifying questions only when needed.

2. Add stronger repo/entity resolution.
   - Resolve "this repo", "repo A", "my newest repo", "the project I replied to", and ambiguous names.
   - Rank likely matches and ask only when ambiguity matters.

3. Add provider health and model routing.
   - Track provider latency/failures.
   - Route cheap summaries to cheap models.
   - Route README/code diffs to stronger models when available.
   - Route image tasks to vision models.
   - Warn when the selected model is repeatedly slow.

4. Improve proactive monitoring policies.
   - Star/fork spikes.
   - Workflow failures.
   - Security/dependency alerts.
   - New issues/PRs/comments needing response.
   - Suspicious commits.
   - Outdated repo descriptions.
   - Low-noise thresholds and cooldowns.

## GitHub Coverage

1. Add webhook-based monitoring.
   - React to pushes, issues, PRs, releases, workflows, and stars without polling everything.

2. Expand PR operations.
   - Summarize PR diffs.
   - Draft PR descriptions from commits.
   - Comment/update/close PRs more naturally.
   - Explain review status/check failures.

3. Expand GitHub Actions operations.
   - Fetch failed job logs.
   - Summarize the likely failure cause.
   - Suggest next action or create an issue from the failure.

4. Expand release workflows.
   - Draft release notes from commits/issues.
   - Compare tags.
   - Suggest semantic version bumps.

5. Add more repo metadata workflows.
   - Homepage.
   - Settings.
   - Pages.
   - Environments/secrets only with strict manual setup and approval.

## README / Presentation Improvements

1. Add README scoring.
   - First-screen clarity.
   - Setup quality.
   - Demo/screenshot quality.
   - Use-case clarity.
   - Portfolio value.

2. Generate better README patches.
   - Use actual repo files and package metadata.
   - Avoid placeholder text when enough facts are available.
   - Keep diffs small and approval-friendly.

3. Add repo-description rewrite suggestions.
   - More persuasive, accurate, and concise.
   - Avoid fake claims.
   - Compare description against the actual repo content.

4. Expand profile README controlled blocks.
   - Stats.
   - Active projects.
   - Tech stack.
   - Current focus.
   - Recently shipped.

## Telegram UX

1. Add inline buttons for common result actions.
   - Draft fix.
   - Create issue.
   - Ignore.
   - Remind later.
   - Show details.

2. Add editable progress messages.
   - Update one "working" message where Telegram allows it.

3. Add per-task verbosity.
   - Quick/normal/detailed setting exists.
   - Next step: make all renderers and planners consistently honor it.

4. Add better approval editing.
   - Current edit flow asks the user to send a corrected instruction.
   - Better flow: let the user reply to an approval with changes and preserve context.

## File Support

1. Add OCR for scanned PDFs and screenshots.

2. Add table extraction for CSV/PDF/DOCX.

3. Add uploaded file to README patch workflows.

4. Add semantic file memory search.

## Model System

1. Verify real provider model IDs before calling.

2. Add a configurable pricing file and optional live pricing refresh.

3. Add fallback policy.
   - Ask before falling back for important write/diff tasks.
   - Auto-fallback for low-risk summaries.

4. Add token budgeting.
   - Refuse overly broad tasks or ask to narrow scope before spending too much.
   - Summarize large context in stages.

## Security

1. Add fine-grained token permission diagnostics.
   - Show which features are likely available from the token.
   - Explain missing scopes/actions clearly.

2. Add approval TTL configuration.

3. Add never-edit policies to every write path.

4. Avoid sending large uploaded files or possible secrets to LLM prompts unless needed.

5. Add optional dry-run mode for all writes.

## Testing

1. Add GitHub API mock tests for write execution.

2. Add file fixture tests for PDF/DOCX/PPTX/RTF.

3. Add scheduler execution tests for helper snapshot jobs.

4. Add approval callback tests with mocked GitHub client.

5. Add live manual test checklist for releases.
