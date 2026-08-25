/**
 * Initials for an account avatar, derived from the account's own display name.
 * Both places that show an avatar used to render a hardcoded "FK", so the same
 * two letters appeared no matter who was signed in.
 */
export function accountInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/u).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => [...part][0] ?? '').join('');
  return (letters || '?').toLocaleUpperCase();
}
