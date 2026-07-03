const { getSecurityGateConfig } = require('./config');

// The env var that unlocks danger-zone repo actions, and the credential that the
// most destructive ones additionally require. Kept as constants so the messages
// the user sees always name the exact variable to set.
const FLAG_ENV = 'ALLOW_DESTRUCTIVE_REPO_ACTIONS';
const PASSWORD_ENV = 'GITHUB_PASSWORD';

// Danger-zone actions — the "GitHub repo settings" operations Evan called out
// (visibility, deletion, transfer, collaboration, archive) plus other
// irreversible writes. Every one is:
//   • blocked by default (flag OFF),
//   • when the flag is ON, still confirmed explicitly EVERY time,
//   • and the `needsPassword` ones also require GITHUB_PASSWORD to be set.
const DANGEROUS_ACTIONS = {
  change_visibility: { label: 'change repository visibility', needsPassword: false },
  archive_repo: { label: 'archive a repository', needsPassword: false },
  unarchive_repo: { label: 'unarchive a repository', needsPassword: false },
  add_collaborator: { label: 'add a collaborator', needsPassword: false },
  remove_collaborator: { label: 'remove a collaborator', needsPassword: false },
  delete_branch: { label: 'delete a branch', needsPassword: false },
  delete_file: { label: 'delete a file', needsPassword: false },
  force_push: { label: 'force-push to a branch', needsPassword: false },
  delete_repo: { label: 'delete a repository', needsPassword: true },
  transfer_repo: { label: 'transfer repository ownership', needsPassword: true },
};

function isDangerousType(type) {
  return Object.prototype.hasOwnProperty.call(DANGEROUS_ACTIONS, type);
}

function cap(text) {
  const s = String(text || '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Classify an action. For dangerous actions the decision is made against the
// CURRENT gate (read fresh from .env by default) so it hot-reloads: pass a `gate`
// object to override (tests, or to re-check with an already-fetched snapshot).
function classifyAction(payload, gate) {
  if (!payload || !payload.type) return { level: 'blocked', reason: 'Invalid action payload.' };

  if (isDangerousType(payload.type)) {
    const meta = DANGEROUS_ACTIONS[payload.type];
    const g = gate || getSecurityGateConfig();

    if (!g.allowDestructive) {
      return {
        level: 'blocked',
        dangerous: true,
        gated: true,
        needsPassword: meta.needsPassword,
        actionType: payload.type,
        actionLabel: meta.label,
        envVar: FLAG_ENV,
        passwordEnv: meta.needsPassword ? PASSWORD_ENV : null,
        reason: `${cap(meta.label)} is a destructive repo action and is disabled by default.`,
      };
    }

    if (meta.needsPassword && !g.dangerPassword) {
      return {
        level: 'blocked',
        dangerous: true,
        gated: true,
        needsPassword: true,
        missingPassword: true,
        actionType: payload.type,
        actionLabel: meta.label,
        envVar: FLAG_ENV,
        passwordEnv: PASSWORD_ENV,
        reason: `${cap(meta.label)} additionally requires a confirmation password.`,
      };
    }

    return {
      level: 'destructive_confirm',
      dangerous: true,
      gated: true,
      needsPassword: meta.needsPassword,
      actionType: payload.type,
      actionLabel: meta.label,
      reason: `${cap(meta.label)} is enabled, but must be confirmed explicitly every time.`,
    };
  }

  if (payload.type.includes('workflow') || payload.type.includes('release')) {
    return { level: 'strict_approval', reason: 'Workflow/release actions affect public or operational state.' };
  }
  if (payload.type.includes('update') || payload.type.includes('create') || payload.type.includes('comment') || payload.type.includes('replace') || payload.type.startsWith('add_')) {
    return { level: 'approval', reason: 'GitHub write action.' };
  }
  return { level: 'read', reason: 'Read-only action.' };
}

module.exports = {
  DANGEROUS_ACTIONS,
  FLAG_ENV,
  PASSWORD_ENV,
  isDangerousType,
  classifyAction,
  getSecurityGateConfig,
};
