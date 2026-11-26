import { useId } from 'react';

/**
 * GitHub's mark, for the button that signs in with it. Inline because lucide
 * dropped brand icons in 1.0.
 */
export function GithubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.36 1.09 2.94.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
    </svg>
  );
}

/**
 * The memoar Thread mark: an m drawn as one hollow line through five nodes,
 * in the accent gradient. The same geometry as public/memoar.svg. Never
 * filled, never recoloured, never drawn below 16px.
 */
export function ThreadMark({ size = 22 }: { size?: number }) {
  const id = useId();
  const gradient = `thread-${id}`;
  return (
    <svg width={Math.max(16, size)} height={Math.max(16, size) * 30 / 28} viewBox="-2 -2 28 30" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2775F7" />
          <stop offset="0.65" stopColor="#26C5CF" />
          <stop offset="1" stopColor="#85E5BA" />
        </linearGradient>
      </defs>
      <polyline points="3,24 3,4 12,15 21,4 21,24" stroke={`url(#${gradient})`} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx="3" cy="24" r="2" fill="#2775F7" />
      <circle cx="3" cy="4" r="2" fill="#2775F7" />
      <circle cx="12" cy="15" r="1.6" fill="#26C5CF" />
      <circle cx="21" cy="4" r="2" fill="#26C5CF" />
      <circle cx="21" cy="24" r="2" fill="#85E5BA" />
    </svg>
  );
}

/** almyty's bolt, as in its own asset. Only ever in the endorsement line. */
export function AlmytyBolt({ size = 11 }: { size?: number }) {
  const id = useId();
  const gradient = `bolt-${id}`;
  return (
    <svg width={size} height={size * 30 / 26} viewBox="-2 -2 26 30" fill="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gradient} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <polygon points="10,0 20,0 12,12 19,12 6,26 12,12 4,12" fill="none" stroke={`url(#${gradient})`} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="10" cy="0" r="2" fill="#a78bfa" />
      <circle cx="20" cy="0" r="2" fill="#8b5cf6" />
      <circle cx="12" cy="12" r="1.5" fill="#7c3aed" />
      <circle cx="6" cy="26" r="2" fill="#22d3ee" />
    </svg>
  );
}

/** "memoar" set as the wordmark, with the mark before it. */
export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size - 1 }}>
      <ThreadMark size={size} />
      <span>memoar</span>
    </span>
  );
}

/** "memoar by almyty", the endorsement line. */
export function Endorsement() {
  return (
    <p className="endorsement">memoar by <AlmytyBolt /> almyty</p>
  );
}
