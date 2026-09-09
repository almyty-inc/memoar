/**
 * Memoar's mark: a thread of turns on a spine, the same shape the session view
 * renders a conversation in. Drawn on a 24 grid with a 2px stroke so it stays
 * legible at 17px, where it lives.
 */
/**
 * GitHub's mark, for the button that signs in with it. Inline because lucide
 * dropped brand icons in 1.0, and a provider button without its provider's mark
 * is harder to recognise than it should be.
 */
export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

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
