/**
 * Memoar's mark: a thread of turns on a spine, the same shape the session view
 * renders a conversation in. Drawn on a 24 grid with a 2px stroke so it stays
 * legible at 17px, where it lives.
 */
export function MemoarMark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The spine: one conversation, running top to bottom. */}
      <path d="M7 5v14" />
      {/* Two turns on it. Filled, so they read as nodes rather than holes at
          small sizes. */}
      <circle cx="7" cy="8" r="1.9" fill="currentColor" stroke="none" />
      <circle cx="7" cy="17" r="1.9" fill="currentColor" stroke="none" />
      {/* What each turn said. Unequal lengths, because a question and an answer
          are not the same size. */}
      <path d="M12 8h6" />
      <path d="M12 17h4" />
    </svg>
  );
}
