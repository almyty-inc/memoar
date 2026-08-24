import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HighlightText } from './ui';

function marks(): string[] {
  return screen.queryAllByText((_, element) => element?.tagName === 'MARK').map((element) => element.textContent ?? '');
}

describe('HighlightText', () => {
  it('highlights each term of a multi-word query independently', () => {
    // The whole phrase rarely appears verbatim in an excerpt; matching only the
    // full phrase meant multi-word searches highlighted nothing at all.
    // "reference" is highlighted inside "references" on purpose: Postgres stems
    // when it matches the row, so the highlight should follow the same rule.
    render(<HighlightText text="The parser dropped parent references here" query="parent reference" />);
    expect(marks()).toEqual(['parent', 'reference']);
    expect(screen.getByText(/dropped/)).toBeDefined();
  });

  it('highlights every occurrence, case-insensitively', () => {
    render(<HighlightText text="Parent and parent and PARENT" query="parent" />);
    expect(marks()).toEqual(['Parent', 'parent', 'PARENT']);
  });

  it('renders the text untouched for an empty or punctuation-only query', () => {
    const { container } = render(<HighlightText text="nothing to highlight" query="   " />);
    expect(container.querySelectorAll('mark')).toHaveLength(0);
    expect(container.textContent).toBe('nothing to highlight');
  });

  it('treats regex metacharacters in the query as literals', () => {
    const { container } = render(<HighlightText text="a+b costs $5 (roughly)" query="a+b (roughly)" />);
    expect(container.textContent).toBe('a+b costs $5 (roughly)');
  });

  it('never emits markup from the excerpt itself', () => {
    // Excerpts arrive as plain text; anything that looks like a tag must render
    // as visible characters, not as HTML.
    const { container } = render(<HighlightText text="<b>parent</b> reference" query="parent" />);
    expect(container.querySelectorAll('b')).toHaveLength(0);
    expect(container.textContent).toContain('<b>');
  });
});
