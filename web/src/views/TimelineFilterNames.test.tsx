import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TimelineGroup } from '../lib/types';
import { TimelineView } from './Timeline';

const groups: TimelineGroup[] = [{
  date: '2026-09-01',
  sessions: [{
    id: 's-1', title: 'Fix the ingest pipeline', summary: 'Archived coding session',
    source: 'claude-code', sourceLabel: 'Claude Code', workspace: '/workspace/memoar',
    createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:30:00.000Z',
    turnCount: 2, tokenCount: 40, redactionStatus: 'clear',
  }],
}];

describe('the timeline filters', () => {
  it('each name themselves, the date one included', () => {
    // The source and workspace selects carried an sr-only label and the date
    // one did not, so a reader who cannot see the calendar icon beside it was
    // offered a control announced as nothing but its own current value.
    render(
      <TimelineView
        groups={groups}
        machines={[]}
        archived={1}
        asOf={Date.parse('2026-09-02T00:00:00.000Z')}
        onOpen={vi.fn()}
        onSearch={vi.fn()}
        onConnect={vi.fn()}
        hasMore={false}
        loadingMore={false}
        onLoadMore={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Filter by source')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by workspace')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by date')).toBeInTheDocument();
  });
});
