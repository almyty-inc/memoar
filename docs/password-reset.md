# Resetting a password

Somebody who knows their password changes it in Settings, under General.
Somebody who has lost it cannot, because Memoar sends no email and so has no
self-service reset. An operator with database access resets it instead, with
`reset-password`.

## Run it

Inside the api container, where `DATABASE_URL` is already set:

```sh
docker compose -f deploy/docker-compose.dev.yml exec api \
  node dist/reset-password.js --email owner@example.com
```

It prints the new password once:

```text
Password reset for owner@example.com.
New password, shown once and stored only as a hash: 3vQk…
Ended every browser session, 2 API key(s) with the MCP sessions made from them, and 1 machine token(s).
```

Nothing keeps a copy. Give the password to the owner over a channel you trust
and ask them to change it in Settings straight away.

Outside a container, build the server and run it with `DATABASE_URL` pointing
at the archive:

```sh
npm run build --workspace @memoar/server
DATABASE_URL=postgres://… node server/dist/reset-password.js --email owner@example.com
```

It runs no migrations and creates no account. Run it against a database the
server has already started on at least once.

## What it ends

A reset assumes somebody else may have been in the account, so it ends every
credential the account was issued, in one transaction with the new password:

| Credential | After a reset |
| --- | --- |
| Browser sessions, however they signed in | Refused on their next request |
| API keys | Revoked, and listed as revoked in Settings |
| MCP sessions made from those keys | Refused, because the key they came from is revoked |
| Machine tokens held by the capture agent | Revoked |
| GitHub or Google sign-in | Untouched, because the owner controls that at the provider |

The capture agent stops uploading until the owner signs it in again with
`memoar login`.

## What it refuses

It refuses an address that has no password, and changes nothing. That covers an
address with no account and an account that only signs in with GitHub or
Google. It will not create a password for either, because that would open a way
in that the owner never asked for. The exit code is 1 and the reason is printed.

| Exit code | Meaning |
| --- | --- |
| 0 | Reset. The password is on standard output |
| 1 | Refused. Nothing was changed |
| 2 | No `--email`, or no `DATABASE_URL` |

## Changing a password while signed in

Settings, General, Change password. It asks for the current password and
checks the new one against the rule registration uses, ten characters or more.
Every other browser signed in to the account is signed out. The one that made
the change stays signed in. API keys and machine tokens are left alone, since
they are listed in Settings and revoked there one by one. Wrong guesses at the
current password count against the same limit as sign-in.
