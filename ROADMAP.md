# Kunii Roadmap

Kuratchi ORM is Cloudflare-first. The supported runtime targets are:

- Cloudflare D1
- Durable Objects with SQLite `SqlStorage`
- Worker-safe custom executors for advanced users

The Drizzle comparison pass is closed. Future work should be planned from
Kuratchi's own product goals, not from upstream parity.

## Near-Term Cleanup

- Keep D1 and Durable Object integration coverage paired for behavior that
  touches SQLite execution semantics.
- Keep type checks focused on the generated schema DSL and Kuratchi's fluent
  API, while preserving intentional escape hatches for JSON paths, relation
  predicates, and runtime-filtered fields.
- Keep migrations additive and explicit. Table rebuilds, destructive drops,
  and complex schema rewrites should require deliberate user action.
- Review public docs against the current behavior: default inserts,
  undefined-field omission, nested includes, JSON-path include filters,
  top-N writes, and migration safety warnings.

## Product Direction

- Improve generated relation result types for common include shapes.
- Add a deliberate story for destructive or table-rebuild migrations, likely
  as an explicit offline workflow rather than automatic runtime migration.
- Tighten observability around migrations and batch execution in Workers.
- Keep the query API small and predictable; add new operators only when they
  remove real Cloudflare application friction.
