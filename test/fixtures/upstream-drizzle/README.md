# Drizzle Comparison Policy

This inventory was a temporary comparison tool, not a compatibility contract.

Kuratchi ORM is Cloudflare-first and intentionally smaller than Drizzle. We
only convert upstream Drizzle tests when the behavior improves Kuratchi for D1
or Durable Objects SqlStorage. Drizzle API-shape tests, non-SQLite drivers,
Node-only drivers, and broad CLI workflows are classified as non-goals unless
Kuratchi independently chooses to build that surface.

Conversion rules:

- Convert behavior, not syntax. Tests should use Kuratchi's public API.
- Prefer D1/DO-safe semantics over matching Drizzle output exactly.
- Keep SQL compiler tests for narrow statement shape regressions.
- Add integration tests when SQLite runtime behavior matters.
- Mark non-goals explicitly so the comparison list reaches zero unknowns
  without expanding Kuratchi beyond its product direction.

Current state:

- No upstream Drizzle bucket remains in `gap` or `partially-converted`.
- Buckets marked `converted-pass` mean the applicable Kuratchi behavior has
  local evidence, not that Kuratchi matches Drizzle API-for-API.
- Future ORM work should be tracked in the package roadmap, not by adding new
  Drizzle parity obligations.
