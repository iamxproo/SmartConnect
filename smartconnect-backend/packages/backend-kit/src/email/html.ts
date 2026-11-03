// HTML escaping for email templates (ADR 0012). Every value that is not a literal of the template (a person's name, an
// organization or role name, anything someone typed) goes through escapeHtml before it is placed in markup, as text
// or inside a quoted attribute. Text is never turned into links: the only links in emails are built by the services
// from configuration (WEB_APP_URL).

const ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char]!);
}
