import { Button } from '@smartconnect/ui/components/button';
import { Paperclip, SendHorizontal } from 'lucide-react';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { describeError } from '@/lib/api/messages';
import { mentionsToTokens, type Mentionable } from '@/lib/message-format';
import type { AttachmentDraft, DraftAttachment } from '@/lib/use-attachment-draft';
import { AttachmentChips } from './attachment-chips';
import { MentionTextarea } from './mention-textarea';

export const MAX_MESSAGE_LENGTH = 40_000;

/**
 * Enter sends, Shift+Enter adds a line. Blank and over-long bodies are never sent. "@Name" for the people in
 * `mentionables` is sent as `<@id>`. When `onSend` returns a promise the text is kept until it succeeds. With a
 * `draft` the composer can attach files (a message may be only files); sending waits for uploads to finish.
 */
export function Composer({
  label,
  onSend,
  disabled,
  mentionables = [],
  draft,
}: {
  /** Accessible name and placeholder, e.g. "Message #general". */
  label: string;
  onSend: (body: string, attachments: DraftAttachment[]) => void | Promise<unknown>;
  disabled?: boolean;
  mentionables?: readonly Mentionable[];
  draft?: AttachmentDraft;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [value, setValue] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = mentionsToTokens(value.trim(), mentionables);
  const tooLong = body.length > MAX_MESSAGE_LENGTH;
  const attached = draft?.attached ?? [];
  const uploading = draft?.busy ?? false;
  const blocked = (!body && attached.length === 0) || tooLong || disabled || sending || uploading;

  async function send() {
    if (blocked) return;
    setError(null);
    const result = onSend(body, attached);
    if (!(result instanceof Promise)) {
      draft?.clear();
      return setValue('');
    }
    setSending(true);
    try {
      await result;
      setValue('');
      draft?.clear();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter while an input method is composing text confirms the composition instead.
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      className="flex flex-col gap-1"
    >
      {draft ? <AttachmentChips draft={draft} /> : null}
      <div className="flex items-end gap-2">
        {draft ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Attach files"
              disabled={disabled}
              onClick={() => picker.current?.click()}
            >
              <Paperclip aria-hidden="true" />
            </Button>
            <input
              ref={picker}
              type="file"
              multiple
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose files to attach"
              onChange={(event) => {
                draft.add([...(event.target.files ?? [])]);
                event.target.value = ''; // the same file can be chosen again after a failure
              }}
            />
          </>
        ) : null}
        <MentionTextarea
          aria-label={label}
          aria-invalid={tooLong ? true : undefined}
          aria-describedby={hintId}
          rows={2}
          value={value}
          placeholder={label}
          disabled={disabled}
          mentionables={mentionables}
          onValueChange={setValue}
          onKeyDown={onKeyDown}
          className="max-h-40 resize-y"
        />
        <Button type="submit" size="icon" aria-label="Send message" disabled={blocked}>
          <SendHorizontal aria-hidden="true" />
        </Button>
      </div>
      <p
        id={hintId}
        role={error ? 'alert' : undefined}
        className={tooLong || error ? 'text-xs text-danger' : 'text-xs text-muted-foreground'}
      >
        {error ??
          (uploading
            ? 'Uploading files. You can send when they are done.'
            : tooLong
              ? `Messages can be at most ${MAX_MESSAGE_LENGTH.toLocaleString('en-US')} characters (${body.length.toLocaleString('en-US')} now).`
              : 'Enter to send, Shift+Enter for a new line.')}
      </p>
    </form>
  );
}
