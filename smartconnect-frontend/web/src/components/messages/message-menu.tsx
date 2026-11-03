import { Button } from '@smartconnect/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@smartconnect/ui/components/dropdown-menu';
import { Bookmark, BookmarkMinus, Ellipsis, Link2, MessageSquareReply, Pencil, SmilePlus, Trash2 } from 'lucide-react';

export interface MessageMenuActions {
  /** Reply in thread; absent for replies and where threads are unavailable. */
  onReply?: () => void;
  onReact?: () => void;
  onSave: () => void;
  saved: boolean;
  onCopyLink: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}

/** The message actions menu: opens with Enter, Space or the arrow keys from the button; Escape closes it. */
export function MessageMenu({
  actions,
  label,
  onCloseAutoFocus,
}: {
  actions: MessageMenuActions;
  label: string;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-7" aria-label={label}>
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"

        className="w-52"
        onCloseAutoFocus={onCloseAutoFocus}
      >
        {actions.onReply ? (
          <DropdownMenuItem onSelect={actions.onReply}>
            <MessageSquareReply aria-hidden="true" />
            Reply in thread
          </DropdownMenuItem>
        ) : null}
        {actions.onReact ? (
          <DropdownMenuItem onSelect={actions.onReact}>
            <SmilePlus aria-hidden="true" />
            Add reaction
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={actions.onSave}>
          {actions.saved ? <BookmarkMinus aria-hidden="true" /> : <Bookmark aria-hidden="true" />}
          {actions.saved ? 'Remove from saved' : 'Save message'}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={actions.onCopyLink}>
          <Link2 aria-hidden="true" />
          Copy link
        </DropdownMenuItem>
        {actions.onEdit || actions.onDelete ? <DropdownMenuSeparator /> : null}
        {actions.onEdit ? (
          <DropdownMenuItem onSelect={actions.onEdit}>
            <Pencil aria-hidden="true" />
            Edit
          </DropdownMenuItem>
        ) : null}
        {actions.onDelete ? (
          <DropdownMenuItem onSelect={actions.onDelete}>
            <Trash2 aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
