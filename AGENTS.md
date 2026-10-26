# Repository instructions

Relay has not launched yet. Target the current code, storage schemas, APIs, and supported
runtime versions directly. Breaking changes are acceptable during this phase.

- Do not add or retain backward compatibility layers, legacy aliases, old-format readers,
  migration code, data backfills, or fallbacks for unsupported runtime versions unless the
  user explicitly requests them.
- When changing a contract or stored format, update its producers, consumers, tests, and
  documentation together. Development data can be reset instead of migrated.
- Use defaults to initialize new data, not to fill missing fields in older stored records.
- Keep validation, error handling, and recovery needed by current features.

Validate changes with `pnpm check`, `pnpm test`, and `pnpm build`.
