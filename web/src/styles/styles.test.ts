import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(dirname(fileURLToPath(import.meta.url)));

const STYLES = join(SRC, 'styles');

/** The rules only. A class named in a comment is not a class that is styled. */
function stylesheet(): string {
  return readdirSync(STYLES)
    .filter((name) => name.endsWith('.css'))
    .map((name) => readFileSync(join(STYLES, name), 'utf8'))
    .join('\n')
    .replaceAll(/\/\*[\s\S]*?\*\//gu, ' ');
}


function sources(): Array<{ path: string; text: string }> {
  const found: Array<{ path: string; text: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) found.push({ path, text: readFileSync(path, 'utf8') });
    }
  };
  walk(SRC);
  return found;
}

/**
 * Classes named for where they sit rather than for how they look: a page
 * marker, or a box whose appearance comes from the rule that positions it
 * inside its parent. Everything else has to have a rule of its own.
 */
const POSITIONAL = new Set([
  'collections-page', 'import-page', 'machines-page', 'memory-page', 'not-found-page',
  'settings-page', 'sharing-page', 'timeline-page', 'workspace-page',
  'mcp-section', 'conversation-column', 'overview-card',
  'actions', 'custom-rule-add',
]);

describe('a class the reader can see', () => {
  it('has a rule somewhere in the stylesheets', () => {
    // `.empty-note` was the most-used empty state in the product — nine call
    // sites — and had no rule at all, so it rendered as flush-left body copy.
    // So did `.form-error`, `.field-empty`, `.collection-empty`,
    // `.settings-note` and `.share-link-result`.
    const declared = new Set([...stylesheet().matchAll(/\.([a-zA-Z][\w-]*)/gu)].map((match) => match[1]!));
    const missing: string[] = [];
    for (const { path, text } of sources()) {
      for (const match of text.matchAll(/className="([^"{]*)"/gu)) {
        for (const token of match[1]!.split(/\s+/u).filter(Boolean)) {
          if (!declared.has(token) && !POSITIONAL.has(token)) missing.push(`${token} (${path})`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('gives every failure the failure style, rather than body copy', () => {
    // Four of these were an unclassed <p role="alert">: a failed conversion
    // and a failed pack build read as ordinary prose.
    const unstyled: string[] = [];
    for (const { path, text } of sources()) {
      text.split('\n').forEach((line, index) => {
        // The opening tag itself, so prose about role="alert" is not mistaken
        // for one.
        if (!/<[a-zA-Z][^>]*role="alert"/u.test(line)) return;

        if (/className=(?:"[^"]*"|\{)/u.test(line)) return;
        unstyled.push(`${path}:${index + 1}`);
      });
    }
    expect(unstyled).toEqual([]);
  });
});
