/**
 * Which modifier key this platform calls "command". Shortcuts bind both Cmd
 * and Ctrl everywhere; only the hint changes, so a Windows or Linux reader is
 * never told to press a key they do not have.
 */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  // `||`, not `??`: headless browsers report an empty string rather than nothing.
  const platform = data?.platform || navigator.platform || '';
  return /mac|iphone|ipad|ipod/iu.test(platform);
}

/** "⌘K" on Apple platforms, "Ctrl K" elsewhere. */
export function shortcutLabel(key: string): string {
  return isApplePlatform() ? `⌘${key}` : `Ctrl ${key}`;
}
