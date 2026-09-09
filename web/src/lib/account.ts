/**
 * Initials for an account avatar, derived from the account's own display name.
 */
export function accountInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/u).filter(Boolean).slice(0, 2);
  const letters = parts.map((part) => [...part][0] ?? '').join('');
  return (letters || '?').toLocaleUpperCase();
}
