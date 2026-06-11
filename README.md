# GitHub Manager Agent Telegram Bot

A personal Telegram GitHub agent that keeps your repos, profile, docs, and project presence sharp through natural chat, smart low-noise monitoring, scheduled reminders, meaningful alerts, and approved GitHub actions.

## What It Does

- Chats naturally in Telegram instead of forcing fixed commands.
- Reads GitHub profile, repos, commits, issues, PRs, releases, Actions, traffic where available, and repo files.
- Reviews READMEs, repo descriptions, profile sections, and public project presentation.
- Schedules flexible jobs as editable plans, not hard-coded commands.
- Sends low-noise proactive alerts for meaningful changes.
- Supports Telegram replies, forwarded messages, file uploads, progress updates, and inline approval buttons.
- Uses SQLite for memory, settings, scheduled jobs, snapshots, and approvals.
- Supports multiple model providers through `.env`.

## Setup

```bash
npm install
cp .env.example .env
npm start
```

Fill `.env` with your Telegram bot token, GitHub token, and at least one model provider key. Do not commit `.env`.

Recommended GitHub token: a dedicated personal access token for this bot. Start broad enough for your intended use, but avoid `delete_repo` unless you truly need it.

## Default Jobs

Default jobs are optional starter automations. The user can change, pause, delete, or replace them in natural language.

- 06:00 short builder trend digest
- 06:30 GitHub profile/public presence update
- 22:30 daily GitHub work and improvement summary
- 00:00 GitHub stats/popularity report

For general users, onboarding asks whether to enable them. For a local personal install, `ENABLE_DEFAULT_JOBS=true` enables them automatically after setup.

## Safety

Read-only work can run immediately. Public-facing writes, uncertain edits, destructive operations, and large changes require approval. Low-risk factual updates inside configured bot-controlled sections can auto-apply when enabled.

## Commands

Commands exist for convenience, but natural language is the main interface.

- `/start` - start setup or show status
- `/help` - show examples
- `/status` - show configuration and job status
- `/models` - show available models
- `/jobs` - list scheduled jobs

