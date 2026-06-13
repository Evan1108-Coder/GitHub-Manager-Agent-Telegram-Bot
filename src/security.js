const DANGEROUS_ACTIONS = new Set([
  'delete_repo',
  'transfer_repo',
  'change_visibility',
  'delete_branch',
  'delete_file',
  'force_push',
  'add_collaborator',
  'remove_collaborator',
]);

function classifyAction(payload) {
  if (!payload || !payload.type) return { level: 'blocked', reason: 'Invalid action payload.' };
  if (DANGEROUS_ACTIONS.has(payload.type)) return { level: 'blocked', reason: `${payload.type} is blocked by default.` };
  if (payload.type.includes('workflow') || payload.type.includes('release')) {
    return { level: 'strict_approval', reason: 'Workflow/release actions affect public or operational state.' };
  }
  if (payload.type.includes('update') || payload.type.includes('create') || payload.type.includes('comment') || payload.type.includes('replace') || payload.type.startsWith('add_')) {
    return { level: 'approval', reason: 'GitHub write action.' };
  }
  return { level: 'read', reason: 'Read-only action.' };
}

module.exports = { DANGEROUS_ACTIONS, classifyAction };
