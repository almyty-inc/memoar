import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/*
  The core build and the languages coding sessions are mostly made of. The
  full build is ten times the size and highlights COBOL.
*/
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('go', go);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

const ALIASES: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  py: 'python', rs: 'rust', yml: 'yaml', md: 'markdown',
  html: 'xml', svg: 'xml', patch: 'diff', jsonl: 'json',
};

/** The registered language for a fence name or a file extension, if any. */
export function resolveLanguage(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const key = name.toLocaleLowerCase();
  const resolved = ALIASES[key] ?? key;
  return hljs.getLanguage(resolved) ? resolved : undefined;
}

export function languageForPath(path: string): string | undefined {
  const extension = /\.([a-z0-9]+)$/iu.exec(path)?.[1];
  if (path.endsWith('Dockerfile')) return 'bash';
  return resolveLanguage(extension);
}

/**
 * Highlighted HTML for a piece of code. highlight.js escapes the source, so
 * the result is safe to set as markup. Long inputs are left plain: a 2 MB tool
 * result is not worth freezing the tab over.
 */
export function highlight(code: string, language: string | undefined): string | null {
  const resolved = resolveLanguage(language);
  if (!resolved || code.length > 200_000) return null;
  try {
    return hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
