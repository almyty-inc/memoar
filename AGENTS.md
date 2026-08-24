# Memoar contributor instructions

Memoar is contract-first. Read `contracts/VERSION`, `contracts/canonical.schema.json`, `contracts/openapi.yaml`, and the relevant fixture before changing an API, parser, converter, or generated type.

- Use `ae` for every text-file edit. Open a file before the first edit and pass its state token to writes.
- Do not change a contract without announcing the proposal in `#memoar` and receiving an acknowledgement.
- Treat fixtures and golden responses as executable specifications.
- Keep TypeScript strict and keep TypeORM `synchronize` disabled.
- Keep Rust on the stable toolchain. Do not add unsafe code without a reason in the same file.
- Never place credentials or personal data in fixtures.
- In prose, lead with the gist. Do not use em dashes, semicolons, slogans, or vague claims.

Workstream channels are `#memoar-agent`, `#memoar-server`, `#memoar-ingest`, `#memoar-search`, `#memoar-convert`, `#memoar-mcp`, `#memoar-web`, `#memoar-distill`, and `#memoar-skill`.
