const ADMIN_ROLES = new Set(['admin', 'super_admin']);

function isAdminRole(role) {
  return isBuiltInAdminRole(role);
}

function isBuiltInAdminRole(role) {
  return ADMIN_ROLES.has(String(role || '').trim().toLowerCase());
}

module.exports = { ADMIN_ROLES, isAdminRole, isBuiltInAdminRole };
