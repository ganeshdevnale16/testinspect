// Roles and what each can do.
// Platform roles (your own team) have no tenant. Client roles always belong to one tenant.

export const PLATFORM_ROLES = {
  super_admin: { label: 'Super admin', description: 'Full control of the platform, all clients, plans and keys' },
  platform_support: { label: 'Support', description: 'Can open client accounts to help them (read only) and view usage' },
};

export const TENANT_ROLES = {
  tenant_admin: { label: 'Admin', description: 'Manages users, sites, AI keys, settings and everything below' },
  manager: { label: 'Manager', description: 'Reviews inspections, manages checklists, assets, schedules and actions' },
  inspector: { label: 'Inspector', description: 'Runs inspections and closes the actions assigned to them' },
  viewer: { label: 'Viewer / auditor', description: 'Read-only access to inspections, actions and reports' },
};

const ALL = Object.keys(TENANT_ROLES);
const PERMS = {
  'inspect.run': ['tenant_admin', 'manager', 'inspector'],
  'inspection.view': ALL,
  'inspection.view_all': ['tenant_admin', 'manager', 'viewer'],
  'inspection.review': ['tenant_admin', 'manager'],
  'inspection.delete': ['tenant_admin'],
  'template.view': ALL,
  'template.manage': ['tenant_admin', 'manager'],
  'asset.view': ALL,
  'asset.manage': ['tenant_admin', 'manager'],
  'site.view': ALL,
  'site.manage': ['tenant_admin'],
  'schedule.manage': ['tenant_admin', 'manager'],
  'action.view': ALL,
  'action.manage': ['tenant_admin', 'manager'],
  'action.update_own': ['tenant_admin', 'manager', 'inspector'],
  'report.view': ['tenant_admin', 'manager', 'viewer'],
  'user.view': ['tenant_admin', 'manager'],
  'user.manage': ['tenant_admin'],
  'settings.manage': ['tenant_admin'],
  'ai.manage': ['tenant_admin'],
  'audit.view': ['tenant_admin'],
  'console.open': ['tenant_admin', 'manager', 'viewer'],
};

export const isPlatformRole = (r) => r in PLATFORM_ROLES;
export const isTenantRole = (r) => r in TENANT_ROLES;

// role = the effective role inside the current tenant
export function can(role, perm) {
  return Boolean(PERMS[perm]?.includes(role));
}
export function permissionsOf(role) {
  return Object.keys(PERMS).filter((p) => can(role, p));
}
