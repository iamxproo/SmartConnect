import { Alert } from '@smartconnect/ui/components/alert';
import { Button } from '@smartconnect/ui/components/button';
import { cn } from '@smartconnect/ui/lib/utils';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { ArrowLeft, MessagesSquare, SearchX, Users } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NotificationLevelMenu } from '@/components/activity/notification-level-menu';
import { MessageThread } from '@/components/messages/conversation';
import { ConversationList } from '@/components/messages/conversation-list';
import { GROUP_PANEL_ID, GroupPanel } from '@/components/messages/group-panel';
import { EmptyState } from '@/components/states/empty-state';
import { QueryState } from '@/components/states/query-state';
import { ApiError } from '@/lib/api/errors';
import type { Conversation } from '@/lib/api/types';
import { useUser } from '@/lib/auth';
import {
  conversationName,
  InboxLiveContext,
  isNotFound,
  useConversation,
  useConversationMessages,
  useDeleteConversationMessage,
  useEditConversationMessage,
  useInboxWatch,
  useMarkRead,
  useMemberNames,
  useSendConversationMessage,
} from '@/lib/queries/conversations';
import { conversationScope } from '@/lib/queries/message-actions';
import { useRequiredOrg } from '@/lib/queries/orgs';
import { usePageVisible } from '@/lib/page-visible';
import { useFocusedMessage } from '@/lib/use-focused-message';

/** The conversation list beside the open conversation; on narrow screens only one of the two at a time. */
export function MessagesLayout() {
  const org = useRequiredOrg();
  const { conversationId } = useParams({ strict: false });
  const live = useInboxWatch(org.id);
  return (
    <InboxLiveContext value={live}>
      <div className="flex h-[calc(100dvh-3.5rem)] min-h-96">
        <div
          className={cn('w-full shrink-0 border-r border-border md:w-80', conversationId ? 'hidden md:block' : 'block')}
        >
          <ConversationList activeId={conversationId} />
        </div>
        <div className={cn('relative min-w-0 flex-1 flex-col', conversationId ? 'flex' : 'hidden md:flex')}>
          <Outlet />
        </div>
      </div>
    </InboxLiveContext>
  );
}

export function MessagesEmptyPage() {
  return (
    <EmptyState
      icon={MessagesSquare}
      title="Select a conversation"
      description="Choose a conversation from the list, or start a new message or group."
    />
  );
}

export function ConversationPage() {
  const org = useRequiredOrg();
  const { conversationId } = useParams({ from: '/app/o/$orgSlugOrId/messages/$conversationId' });
  const conversation = useConversation(org.id, conversationId);

  // A removed conversation and a guessed id look the same, by design.
  if (isNotFound(conversation.error)) {
    return (
      <EmptyState
        icon={SearchX}
        title="Conversation not available"
        description="This conversation doesn't exist, or you are no longer part of it."
        action={
          <Button asChild variant="outline">
            <Link to="/o/$orgSlugOrId/messages" params={{ orgSlugOrId: org.slug }}>
              Back to conversations
            </Link>
          </Button>
        }
      />
    );
  }
  return (
    <QueryState query={conversation} label="the conversation">
      {(data) => <ConversationView key={data.id} conversation={data} />}
    </QueryState>
  );
}

function ConversationView({ conversation }: { conversation: Conversation }) {
  const org = useRequiredOrg();
  const user = useUser();
  const isGroup = conversation.kind === 'group';
  const nameOf = useMemberNames(
    org.id,
    useMemo(() => conversation.participants.map((p) => p.userId), [conversation.participants]),
  );
  const title = conversationName(conversation, user.id, nameOf);
  const [panelOpen, setPanelOpen] = useState(false);
  const detailsButton = useRef<HTMLButtonElement>(null);
  const [inactive, setInactive] = useState(false);
  const focus = useFocusedMessage();

  const messages = useConversationMessages(org.id, conversation.id);
  const scope = useMemo(() => conversationScope(org.id, conversation.id), [org.id, conversation.id]);
  const mentionables = useMemo(
    () => conversation.participants.map((p) => ({ userId: p.userId, name: nameOf(p.userId) })),
    [conversation.participants, nameOf],
  );
  const send = useSendConversationMessage(org.id, conversation.id);
  const edit = useEditConversationMessage(org.id, conversation.id);
  const remove = useDeleteConversationMessage(org.id, conversation.id);

  // Mark as read: the newest message from someone else, once per message, while the tab is visible.
  const visible = usePageVisible();
  const markRead = useMarkRead(org.id, conversation.id).mutate;
  const marked = useRef(conversation.lastReadMessageId);
  const newest = messages.data?.pages[0]?.data[0];
  useEffect(() => {
    // Your own messages already moved your cursor on the server.
    if (!visible || !newest || newest.senderUserId === user.id || marked.current === newest.id) return;
    marked.current = newest.id;
    markRead(newest.id);
  }, [visible, newest, user.id, markRead]);

  function closePanel() {
    setPanelOpen(false);
    detailsButton.current?.focus();
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border p-3">
        <Button asChild variant="ghost" size="icon" className="md:hidden">
          <Link to="/o/$orgSlugOrId/messages" params={{ orgSlugOrId: org.slug }} aria-label="Back to conversations">
            <ArrowLeft aria-hidden="true" />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-md font-semibold">{title}</h2>
          {isGroup ? <p className="text-xs text-muted-foreground">{conversation.participants.length} people</p> : null}
        </div>
        <NotificationLevelMenu location={{ kind: conversation.kind, conversationId: conversation.id }} />
        {isGroup ? (
          <Button
            ref={detailsButton}
            variant="outline"
            size="sm"
            aria-expanded={panelOpen}
            aria-controls={GROUP_PANEL_ID}
            onClick={() => (panelOpen ? closePanel() : setPanelOpen(true))}
          >
            <Users aria-hidden="true" />
            Details
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <MessageThread
          fill
          label={`Messages with ${title}`}
          messages={messages}
          scope={scope}
          orgId={org.id}
          permalink={(id) => `${window.location.origin}${window.location.pathname}#message-${id}`}
          mentionables={mentionables}
          nameOf={(userId) => (userId ? nameOf(userId) : 'System')}
          canModerate={isGroup && conversation.myRole === 'admin'}
          focusMessageId={focus.messageId}
          onFocusClear={focus.clear}
          onSend={(body, clientMessageId, attachmentFileIds) =>
            send.mutateAsync({ body, clientMessageId, attachmentFileIds })
          }
          onSendFailed={(error) => {
            if (error instanceof ApiError && error.code === 'participant_inactive') setInactive(true);
          }}
          onEdit={(id, body) => edit.mutateAsync({ id, body })}
          onDelete={(id) => remove.mutateAsync(id)}
          compose={{ label: `Message ${title}`, disabled: inactive }}
          notice={
            inactive ? (
              <Alert tone="danger" role="alert">
                {isGroup
                  ? "You can't send messages here."
                  : `${title} is no longer in this organization, so you can't send messages here. You can still read the history.`}
              </Alert>
            ) : null
          }
        />
      </div>
      <AnimatePresence>
        {panelOpen ? <GroupPanel conversation={conversation} nameOf={nameOf} onClose={closePanel} /> : null}
      </AnimatePresence>
    </>
  );
}
