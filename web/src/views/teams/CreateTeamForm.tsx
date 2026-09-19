import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui';

/**
 * The way out of an account's first empty state.
 *
 * `POST /v1/teams` had been in the contract since teams shipped and nothing in
 * the app called it, so an account with no team and no invitation read two
 * honest empty lists and had no move to make from either of them. Creating is
 * the only move that does not depend on somebody else acting first.
 *
 * It lives in the panel header rather than in the empty state, because an
 * account that already has a team may want a second one, and an affordance that
 * disappears once it has been used once is not one.
 */
export function CreateTeamForm({ busy, onCreate }: {
  busy: boolean;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const trimmed = name.trim();

  return (
    <form
      className="create-team-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmed) return;
        onCreate(trimmed);
        setName('');
      }}
    >
      <input
        type="text"
        value={name}
        placeholder="Archive crew"
        aria-label="Name for a new team"
        onChange={(event) => setName(event.target.value)}
      />
      <Button size="sm" variant="primary" type="submit" disabled={busy || trimmed.length === 0}>
        <Plus size={14} /> Create team
      </Button>
    </form>
  );
}
