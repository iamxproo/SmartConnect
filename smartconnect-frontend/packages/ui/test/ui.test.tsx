import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Alert } from '../src/components/alert.js';
import { Button } from '../src/components/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../src/components/dialog.js';
import { Input, Select } from '../src/components/input.js';
import { cn } from '../src/lib/utils.js';

describe('cn()', () => {
  it('lets later utilities override conflicting earlier ones', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    expect(cn('text-sm', 'text-md')).toBe('text-md');
  });

  it('keeps the custom text-md size next to a text colour (both survive)', () => {
    expect(cn('text-md', 'text-foreground')).toBe('text-md text-foreground');
  });

  it('drops falsy values', () => {
    expect(cn('a', false, undefined, null, 'b')).toBe('a b');
  });
});

describe('Button', () => {
  it('defaults to type="button" so it never submits a form by accident', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'button');
  });

  it('keeps an explicit submit type', () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('type', 'submit');
  });

  it('renders its child element with asChild (e.g. a link styled as a button)', () => {
    render(
      <Button asChild variant="link">
        <a href="/docs">Docs</a>
      </Button>,
    );
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).toHaveAttribute('data-slot', 'button');
    expect(link).not.toHaveAttribute('type');
  });
});

describe('Dialog', () => {
  it('is a labelled modal that closes with Escape and returns focus to its trigger', async () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Invite</DialogTitle>
          <DialogDescription>Send an invitation.</DialogDescription>
          <Input aria-label="Email" />
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Open' });
    fireEvent.pointerDown(trigger);
    fireEvent.click(trigger);
    trigger.focus();
    const dialog = await screen.findByRole('dialog', { name: 'Invite' });
    expect(dialog).toHaveAccessibleDescription('Send an invitation.');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe('Input, Select and Alert', () => {
  it('expose invalid state to assistive technology', () => {
    render(
      <>
        <Input aria-label="Name" aria-invalid="true" />
        <Select aria-label="Role">
          <option>Member</option>
        </Select>
        <Alert role="alert" tone="danger">
          Failed
        </Alert>
      </>,
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toBeInvalid();
    expect(screen.getByRole('combobox', { name: 'Role' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
  });
});
