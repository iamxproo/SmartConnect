import type { User } from '@/lib/api/types';

/**
 * Platform administration (ADR 0015). This only decides what the web app shows: every admin API checks the role
 * itself on each request, so hiding a page is never the protection.
 */
export const isSuperAdmin = (user: User): boolean => user.platformRoles?.includes('super_admin') ?? false;
