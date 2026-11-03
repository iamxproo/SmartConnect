import { Button } from '@smartconnect/ui/components/button';
import { useRef, useState, type Ref } from 'react';
import { describeError } from '@/lib/api/messages';
import type { Message } from '@/lib/api/types';
import { formatRelative } from '@/lib/relative-time';
import { mentionsToTokens, tokensToMentions, type Mentionable } from '@/lib/message-format';
import { MAX_MESSAGE_LENGTH } from './composer';
import { MentionTextarea } from './mention-textarea';
import { MessageText } from './message-body';
import { MessageAttachments } from './message-attachments';
import { MessageMenu } from './message-menu';
import { MessageRow } from './message-row';
import { EmojiPicker, ReactionBar } from './reactions';

/** What the thread needs of a message, whether it belongs to a channel or to a direct or group conversation. */
export type ThreadMessage = Omit<Message, 'channelId'>;

/** What a person can do with messages here; the same for the timeline and for a thread panel. */
export interface ItemActions {
  /** May add reactions (post here). */
  canReact: boolean;
  react: (id: string, emoji: string, on: boolean) => void;
  save: (id: string, saved: boolean) => void;
  copyLink: (id: string) => void;
  edit: (id: string, body: string) => Promise<unknown>;
  remove: (message: ThreadMessage) => void;
}

interface MessageItemProps {
  message: ThreadMessage;
  nameOf: (userId: string | null) => string;
  selfId: string;
  mentionables: readonly Mentionable[];
  actions: ItemActions;
  canEdit: boolean;
  canDelete: boolean;
  /** Opens the thread; absent inside the thread panel. */
  onOpenThread?: (message: ThreadMessage) => void;
  isNew?: boolean;
  divider?: Ref<HTMLDivElement>;
  /** Gives the row its permalink id; false where the same message is shown twice (thread panel). */
  anchor?: boolean;
  /** Needed to show attached files (they are fetched through the organization's files). */
  orgId?: string;
  /** The message a jump landed on (context panel). */
  highlight?: boolean;
}

/** One confirmed message: text, reactions, thread summary and its actions (edit in place included). */
export function MessageItem({
  message,
  nameOf,
  selfId,
  mentionables,
  actions,
  canEdit,
  canDelete,
  onOpenThread,
  isNew,
  divider,
  anchor = true,
  orgId,
  highlight,
}: MessageItemProps) {
  const [editing, setEditing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // What a chosen menu action does once the menu has handed focus back (else the two would fight over focus).
  const afterMenu = useRef<(() => void) | null>(null);
  const body = message.body;
  const deleted = message.deletedAt !== null || body === null;
  const system = message.type === 'system';
  const interactive = !deleted && !system;
  const thread = message.thread;

  const menu = interactive ? (
    <>
      {actions.canReact ? (
        <EmojiPicker
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onPick={(emoji) => actions.react(message.id, emoji, true)}
        />
      ) : null}
      <MessageMenu
        label="Message actions"
        onCloseAutoFocus={(event) => {
          const next = afterMenu.current;
          afterMenu.current = null;
          if (!next) return;
          event.preventDefault();
          next();
        }}
        actions={{
          onReply:
            onOpenThread && !deleted
              ? () => {
                  afterMenu.current = () => onOpenThread(message);
                }
              : undefined,
          onReact: actions.canReact
            ? () => {
                afterMenu.current = () => setPickerOpen(true);
              }
            : undefined,
          saved: message.bookmarked,
          onSave: () => actions.save(message.id, !message.bookmarked),
          onCopyLink: () => actions.copyLink(message.id),
          onEdit: canEdit ? () => setEditing(true) : undefined,
          onDelete: canDelete ? () => actions.remove(message) : undefined,
        }}
      />
    </>
  ) : undefined;

  return (
    <MessageRow
      messageId={anchor ? message.id : undefined}
      senderName={system ? 'System' : nameOf(message.senderUserId)}
      createdAt={message.createdAt}
      edited={message.editedAt !== null && !deleted}
      isNew={isNew}
      divider={divider}
      actions={menu}
      highlight={highlight}
    >
      {deleted ? (
        <p className="text-sm text-muted-foreground italic">Message deleted</p>
      ) : system ? (
        <p className="text-sm text-muted-foreground italic">{body}</p>
      ) : editing ? (
        <EditBox
          body={body}
          mentionables={mentionables}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            await actions.edit(message.id, body);
            setEditing(false);
          }}
        />
      ) : (
        <MessageText selfId={selfId} nameOf={(userId) => nameOf(userId)}>
          {body}
        </MessageText>
      )}
      {orgId && interactive && message.attachments?.length ? (
        <MessageAttachments orgId={orgId} attachments={message.attachments} />
      ) : null}
      {interactive && !editing ? (
        <ReactionBar
          reactions={message.reactions}
          canReact={actions.canReact}
          onToggle={(emoji, on) => actions.react(message.id, emoji, on)}
        />
      ) : null}
      {onOpenThread && thread && thread.replyCount > 0 ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-fit gap-2 px-1.5 text-primary"
          onClick={() => onOpenThread(message)}
        >
          {thread.replyCount} {thread.replyCount === 1 ? 'reply' : 'replies'}
          {thread.lastReplyAt ? (
            <span className="font-normal text-muted-foreground">last reply {formatRelative(thread.lastReplyAt)}</span>
          ) : null}
        </Button>
      ) : null}
    </MessageRow>
  );
}

function EditBox({
  body,
  mentionables,
  onSave,
  onCancel,
}: {
  body: string;
  mentionables: readonly Mentionable[];
  onSave: (body: string) => Promise<unknown>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => tokensToMentions(body, mentionables));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const converted = mentionsToTokens(draft.trim(), mentionables);
  const tooLong = converted.length > MAX_MESSAGE_LENGTH;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await onSave(converted);
    } catch (failure) {
      setError(describeError(failure));
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <MentionTextarea
        aria-label="Edit message"
        autoFocus
        rows={2}
        value={draft}
        mentionables={mentionables}
        onValueChange={setDraft}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
        }}
      />
      {tooLong || error ? (
        <p role="alert" className="text-xs text-danger">
          {tooLong ? `Messages can be at most ${MAX_MESSAGE_LENGTH.toLocaleString('en-US')} characters.` : error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" disabled={!draft.trim() || tooLong || saving} onClick={() => void save()}>
          Save
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
