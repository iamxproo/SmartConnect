import { linkOptions } from '@tanstack/react-router';
import {
  Bookmark,
  Boxes,
  Folder,
  House,
  MailPlus,
  MessagesSquare,
  Settings,
  Network,
  UserRound,
  UsersRound,
  Video,
  type LucideIcon,
} from 'lucide-react';

// Single source for the organization-scoped sidebar entries and the placeholder pages. Sections whose backend
// does not exist yet are honest placeholders that state which roadmap phase delivers them (docs/product/roadmap.md).

export interface Section {
  title: string;
  icon: LucideIcon;
  /** What the section will contain, phrased so "<summary> arrive in <phase>" reads correctly. */
  summary: string;
  phase: string;
}

export const sections: Record<'meetings' | 'files', Section> = {
  meetings: { title: 'Meetings', icon: Video, summary: 'Calls, group meetings and screen sharing', phase: 'Phase 4' },
  files: { title: 'Files', icon: Folder, summary: 'File sharing, previews and storage', phase: 'Phase 3' },
};

export interface NavMeta {
  label: string;
  icon: LucideIcon;
  /** false = placeholder destination (shown with a "Soon" badge). */
  available: boolean;
  /** Entry is hidden unless the member holds this permission (UX only; the server enforces it). */
  permission?: string;
  exact?: boolean;
}

export function primaryNavigation(orgSlugOrId: string) {
  const params = { orgSlugOrId };
  const meta = (label: string, icon: LucideIcon, rest: Partial<NavMeta> = {}): NavMeta => ({
    label,
    icon,
    available: true,
    ...rest,
  });
  return linkOptions([
    { to: '/o/$orgSlugOrId', params, ...meta('Overview', House, { exact: true }) },
    { to: '/o/$orgSlugOrId/workspaces', params, ...meta('Workspaces', Boxes) },
    { to: '/o/$orgSlugOrId/messages', params, ...meta('Direct messages', MessagesSquare) },
    { to: '/o/$orgSlugOrId/files', params, ...meta('Files', Folder) },
    { to: '/o/$orgSlugOrId/saved', params, ...meta('Saved', Bookmark) },
    { to: '/o/$orgSlugOrId/members', params, ...meta('Members', UserRound) },
    { to: '/o/$orgSlugOrId/departments', params, ...meta('Departments', Network) },
    { to: '/o/$orgSlugOrId/teams', params, ...meta('Teams', UsersRound) },
    { to: '/o/$orgSlugOrId/invitations', params, ...meta('Invitations', MailPlus, { permission: 'members.invite' }) },
    { to: '/o/$orgSlugOrId/settings', params, ...meta('Settings', Settings, { permission: 'organization.update' }) },
  ]);
}

export function placeholderNavigation(orgSlugOrId: string) {
  const params = { orgSlugOrId };
  const meta = ({ title, icon }: Section): NavMeta => ({ label: title, icon, available: false });
  return linkOptions([{ to: '/o/$orgSlugOrId/meetings', params, ...meta(sections.meetings) }]);
}
