# Improvement Backlog

This list is intentionally honest. The current bot is a working v1, not the final "does every GitHub thing" agent.

## Highest Priority

1. Add real response-time telemetry.
   - Store per-message start/end time.
   - Identify which tool/model/API caused slow replies.
   - Send a warning when a provider repeatedly exceeds a threshold.

1. Build a real tool-planning layer.
   - Current behavior uses useful patterns plus LLM fallback.
   - Needed: structured plan JSON, validation, tool selection, execution, and recovery.

2. Complete the write-action approval pipeline.
   - Add diff generation.
   - Add exact action summaries.
   - Add approve/edit/cancel buttons.
   - Execute approved payloads.
   - Verify post-write state.

3. Expose core GitHub writes through natural chat.
   - Create/update issues.
   - Edit files by path.
   - Edit specific lines.
   - Update repo descriptions/topics.
   - Create branches.
   - Open PRs.
   - Draft releases.

4. Add robust repo/entity resolution.
   - Resolve "repo A", "this repo", "my newest repo", "the one I replied to".
   - Rank likely matches and ask only when ambiguity matters.

5. Add real stale-doc detection.
   - Compare recent commits to README content.
   - Detect when behavior/features changed but docs did not.
   - Suggest or draft README updates.

6. Add proactive monitoring policies.
   - Star/fork spikes.
   - Workflow failures.
   - Security/dependency alerts.
   - New issues/PRs/comments needing response.
   - Suspicious commits.
   - Outdated repo descriptions.
   - Low-noise thresholds and cooldowns.

## Scheduling Improvements

1. Support more natural time phrases.
   - "next Friday afternoon"
   - "first Monday of every month"
   - "weekdays only"
   - "except weekends"
   - "until July"

2. Support scheduled model changes.
   - "Use Claude Sonnet for audits tomorrow, then switch back."

3. Add job editing.
   - "Move job 3 to 8 AM."
   - "Make job 2 weekly."
   - "Only run this for TrendForge."

4. Add job run previews.
   - Show what a job will do before enabling it.

## GitHub Coverage

1. Add PR operations.
   - List PRs.
   - Review PR status.
   - Draft PR descriptions.
   - Create PRs from branches.
   - Comment/update/close PRs with approval.

2. Add GitHub Actions operations.
   - Explain failed runs.
   - Fetch logs.
   - Rerun workflows with approval.
   - Dispatch workflows with approval.

3. Add release operations.
   - Draft release notes from commits.
   - Create releases with approval.

4. Add issue workflows.
   - Create issues from files/audits.
   - Label issues.
   - Close/update/comment with approval.

5. Add repository metadata workflows.
   - Descriptions.
   - Topics.
   - Homepage.
   - Visibility/settings only with strict confirmation.

## README / Presentation Improvements

1. Add README scoring.
   - First-screen clarity.
   - Setup quality.
   - Demo/screenshot quality.
   - Use-case clarity.
   - Portfolio value.

2. Add README patch generation.
   - Controlled sections.
   - Diff preview.
   - Approval.

3. Add repo-description rewrite suggestions.
   - More persuasive, accurate, and concise.
   - Avoid fake claims.

4. Add profile README controlled blocks.
   - Stats.
   - Active projects.
   - Tech stack.
   - Current focus.

## Telegram UX

1. Add inline buttons for common results.
   - Draft fix.
   - Create issue.
   - Ignore.
   - Remind later.
   - Show details.

2. Add compact cards for repo audits.

3. Add progress updates for every long-running multi-tool task.

4. Add better error messages for model/provider failures.

5. Add manual `/reset-setup` and `/settings`.

6. Add editable progress messages.
   - Instead of sending multiple messages, update one "working" message when Telegram allows it.

7. Add per-task verbosity controls.
   - Quick
   - Normal
   - Detailed

8. Add provider latency warnings.
   - If a model is slow, tell the user and suggest a faster configured model.

## File Support

1. Add OCR for scanned PDFs and screenshots.

2. Add table extraction for CSV/PDF/DOCX.

3. Add uploaded file to issue/README workflows.

4. Add file memory search.

## Model System

1. Verify real provider model IDs before calling.

2. Add a configurable pricing file.

3. Add provider health checks.

4. Add per-task model routing.
   - Cheap model for summaries.
   - Stronger model for README/code diffs.
   - Vision model for images.

5. Add fallback policy.
   - Ask before falling back for important tasks.
   - Auto-fallback for low-risk summaries.

## Security

1. Add explicit dangerous-action blocklist.
   - Delete repo.
   - Transfer repo.
   - Change visibility.
   - Delete branches/files.

2. Add approval TTLs.

3. Add audit log view.

4. Add token permission check summary.

5. Avoid sending large uploaded files or secrets to LLM prompts unless needed.

## Testing

1. Add mock Telegram update tests for more realistic inbound messages.

2. Add GitHub API mock tests for repo audits and writes.

3. Add file fixture tests for PDF/DOCX/PPTX/RTF.

4. Add scheduler execution tests for helper snapshot jobs.

5. Add live manual test checklist.
