// Code-defined permission catalogue (blueprint gap G-05). Roles store permission keys; `*` grants all. Anything not
// in the catalogue grants nothing. Organization membership alone grants no access to private workspaces, teams or
// channels: those are governed by their own memberships.
export const PERMISSIONS = [
  'organization.update',
  'members.invite',
  'members.manage',
  'workspaces.create',
  'departments.manage',
  'teams.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const OWNER_ROLE_KEY = 'owner';

/** Created with every organization. Only owners may grant or remove the owner role. */
export const SYSTEM_ROLES = [
  { key: OWNER_ROLE_KEY, name: 'Owner', description: 'Full control of the organization', permissions: ['*'] },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Manages members, structure and workspaces',
    permissions: [...PERMISSIONS],
  },
  { key: 'member', name: 'Member', description: 'Regular employee', permissions: [] as string[] },
];

export function hasPermission(granted: readonly string[], permission: Permission): boolean {
  return granted.includes('*') || granted.includes(permission);
}
