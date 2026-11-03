import { screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

/** Opens the "Message actions" menu of a message row and returns what it offers. */
export async function openActions(user: UserEvent, row: HTMLElement): Promise<HTMLElement> {
  await user.click(within(row).getByRole('button', { name: 'Message actions' }));
  return screen.findByRole('menu', { name: 'Message actions' });
}

/** The labels of the actions a message row offers (the menu is closed again afterwards). */
export async function actionsOf(user: UserEvent, row: HTMLElement): Promise<string[]> {
  const menu = await openActions(user, row);
  const labels = within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent ?? '');
  await user.keyboard('{Escape}');
  return labels;
}

/** Chooses one action from the menu of a message row, by its label. */
export async function chooseAction(user: UserEvent, row: HTMLElement, label: string): Promise<void> {
  const menu = await openActions(user, row);
  await user.click(within(menu).getByRole('menuitem', { name: label }));
}
