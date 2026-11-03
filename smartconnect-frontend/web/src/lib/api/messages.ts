import { ApiError } from './errors';

// Human wording for stable error codes (docs/api/endpoints.md). The server's own messages may change, so UI
// text never depends on them for known codes.
const BY_CODE: Record<string, string> = {
  invalid_credentials: 'The email or password is incorrect.',
  invalid_verification_token:
    'This verification link is invalid or has expired. Request a new one from the banner after signing in.',
  invalid_reset_token: 'This reset link is invalid or has expired. Request a new one.',
  invitation_invalid:
    'This invitation is invalid, has expired or was withdrawn. Ask an administrator to send a new one.',
  invitation_email_mismatch: 'This invitation was sent to a different email address. Sign in with the invited address.',
  email_not_verified: 'Verify your email address first. Use the link in the email we sent you.',
  already_member: 'This person is already a member of the organization.',
  organization_creation_not_allowed:
    'Your account is not authorized to create organizations. Companies are created by authorized administrators; ask to be invited to yours.',
  slug_taken: 'That address is already taken. Choose another.',
  invitation_pending: 'An invitation is already pending for this email address. Resend it instead.',
  last_admin: 'You are the last administrator. Make someone else an administrator first.',
  channel_name_taken: 'A channel with that name already exists in this workspace.',
  not_a_channel_member: 'Join this channel to post in it.',
  channel_archived: 'This channel is archived and read-only.',
  message_deleted: 'This message was deleted.',
  participant_inactive: 'The other person is no longer in this organization, so you can no longer send messages here.',
  conversation_full: 'This group is full (50 people).',
  cannot_message_self: "You can't start a conversation with yourself.",
  user_not_in_organization: 'That person is not an active member of this organization.',
  not_a_group: 'Only groups can be changed.',
  department_not_empty: 'This department is not empty. Move or delete what it contains first.',
  platform_admin_required: 'This account is not a platform administrator.',
  password_change_required: 'Choose your own password before using platform administration.',
};

/** Message for any failed action. `overrides` lets one screen word a code for its own context. */
export function describeError(error: unknown, overrides: Record<string, string> = {}): string {
  if (!(error instanceof ApiError)) return "Can't reach SmartConnect. Check your connection and try again.";
  const known = overrides[error.code] ?? BY_CODE[error.code];
  if (known) return known;
  if (error.status === 403) return "You don't have permission to do this.";
  if (error.status === 404) return "This item doesn't exist, or you don't have access to it.";
  if (error.status === 429) return 'Too many attempts. Wait a moment and try again.';
  if (error.status >= 500) return 'SmartConnect is having trouble right now. Try again shortly.';
  return error.detail ?? 'Something went wrong. Try again.';
}
