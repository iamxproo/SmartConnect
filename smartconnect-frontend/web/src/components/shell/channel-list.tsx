import { cn } from '@smartconnect/ui/lib/utils';
import { Link } from '@tanstack/react-router';
import { Hash, Lock } from 'lucide-react';
import { RevealItem } from '@/components/motion/reveal';
import { useChannels, useWorkspaces } from '@/lib/queries/workspaces';

/** Channels of the open workspace: public ones, plus private ones the caller is in (the API already filters). */
export function ChannelList({
  orgId,
  orgSlugOrId,
  workspaceId,
  onNavigate,
}: {
  orgId: string;
  orgSlugOrId: string;
  workspaceId: string;
  onNavigate?: () => void;
}) {
  const isMember = useWorkspaces(orgId).data?.find((workspace) => workspace.id === workspaceId)?.myRole;
  const channels = useChannels(orgId, workspaceId, Boolean(isMember));
  // Channels are listed for members only; for anyone else the workspace page offers to join.
  if (!isMember) return null;
  return (
    <nav aria-label="Channels" className="mt-4">
      <h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">Channels</h2>
      {channels.isPending ? <p className="px-2.5 text-xs text-muted-foreground">Loading channels…</p> : null}
      {channels.isError ? (
        <p className="px-2.5 text-xs text-muted-foreground">Channels are not available to you here.</p>
      ) : null}
      {channels.data?.length === 0 ? <p className="px-2.5 text-xs text-muted-foreground">No channels yet.</p> : null}
      <ul className="flex flex-col gap-0.5">
        {channels.data?.map((channel, index) => {
          const Icon = channel.type === 'private' ? Lock : Hash;
          return (
            <RevealItem key={channel.id} index={index}>
              <Link
                to="/o/$orgSlugOrId/w/$workspaceId/c/$channelId"
                params={{ orgSlugOrId, workspaceId, channelId: channel.id }}
                onClick={onNavigate}
                className={cn(
                  'flex h-8 items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground',
                  'transition-colors duration-(--sc-duration-fast) ease-standard hover:bg-surface-hover hover:text-foreground',
                  'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  'data-[status=active]:bg-surface-selected data-[status=active]:font-medium data-[status=active]:text-foreground',
                  !channel.isMember && 'italic',
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{channel.name}</span>
                {!channel.isMember ? <span className="sr-only">, not joined</span> : null}
              </Link>
            </RevealItem>
          );
        })}
      </ul>
    </nav>
  );
}
