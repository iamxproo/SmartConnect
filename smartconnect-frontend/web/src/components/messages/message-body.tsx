import { cn } from '@smartconnect/ui/lib/utils';
import { Fragment, useMemo, type ReactNode } from 'react';
import { parseMessage, type Inline } from '@/lib/message-format';

interface MessageTextProps {
  children: string;
  /** Name for a mentioned person; unknown people read "Former member". */
  nameOf?: (userId: string) => string;
  /** The signed-in person: their mentions stand out. */
  selfId?: string;
}

/**
 * Message text, rendered from the parsed safe Markdown subset (lib/message-format) as React elements: text is always
 * a text node, links are http(s) only with rel="noopener noreferrer", and nothing is ever set as HTML.
 */
export function MessageText({ children, nameOf, selfId }: MessageTextProps) {
  const blocks = useMemo(() => parseMessage(children), [children]);
  const inline = (nodes: Inline[]): ReactNode =>
    nodes.map((node, index) => <Fragment key={index}>{renderInline(node, inline, nameOf, selfId)}</Fragment>);

  return (
    <div className="flex flex-col gap-1">
      {blocks.map((block, index) => {
        if (block.type === 'code') {
          return (
            <pre
              key={index}
              tabIndex={0}
              className="overflow-x-auto rounded-md border border-border bg-surface-hover p-2 text-xs"
            >
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'quote') {
          return (
            <blockquote
              key={index}
              className="border-l-2 border-border pl-3 text-sm break-words whitespace-pre-wrap text-muted-foreground"
            >
              {inline(block.children)}
            </blockquote>
          );
        }
        return (
          <p key={index} className="text-sm break-words whitespace-pre-wrap">
            {inline(block.children)}
          </p>
        );
      })}
    </div>
  );
}

function renderInline(
  node: Inline,
  render: (nodes: Inline[]) => ReactNode,
  nameOf: MessageTextProps['nameOf'],
  selfId: string | undefined,
): ReactNode {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'bold':
      return <strong>{render(node.children)}</strong>;
    case 'italic':
      return <em>{render(node.children)}</em>;
    case 'strike':
      return <s>{render(node.children)}</s>;
    case 'code':
      return <code className="rounded bg-surface-hover px-1 py-0.5 text-[0.9em]">{node.text}</code>;
    case 'link':
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary underline underline-offset-2"
        >
          {node.text}
        </a>
      );
    case 'mention':
      return <MentionChip name={nameOf?.(node.userId) ?? 'Former member'} self={node.userId === selfId} />;
  }
}

export function MentionChip({ name, self }: { name: string; self?: boolean }) {
  return (
    <span className={cn('rounded-sm bg-accent px-1 font-medium text-accent-foreground', self && 'ring-1 ring-ring')}>
      @{name}
    </span>
  );
}
