# Runtime migration specification

## State and versions

The application supplies its desired schema. Each database stores applied snapshots
and execution history in `_kuratchi_migrations`. No migration files or external
storage are required. Versions are positive integers and advance monotonically.
Older application versions do not reverse the database. Existing unversioned schemas
retain additive compatibility. Renames and rebuilds require a forward version and
an atomic batch client.

An applied version is immutable. Changing the requested schema, including rename
hints, requires incrementing its version. Removing the version from a versioned
database is rejected. A failed atomic migration does not reserve its version.
Partially applied migrations retain their requested schema and can complete that
same request on retry.

Snapshots contain observed effective definitions separately from the requested
schema. Adoption never treats requested constraints as evidence that they exist.
Unverified definitions and unapplied constraints remain pending. Snapshots written
before this verification format are re-inspected before using the fast path.

## Column identity

Normalized columns accept `renameFrom`. The string DSL accepts
`mobile: 'text renameFrom phone'`.

- Source only present means native rename.
- Destination only present means already satisfied.
- Neither present means ordinary column creation.
- Both present means a conflict and the entire plan fails before execution.
- Multiple destinations claiming one source, cycles, and chains within one version
  are rejected as ambiguous.

Keep hints while supported databases might skip the version introducing them.
Removing a hint in a newer version does not reverse a completed rename. Kunii logs
and returns a warning before executing a physical rename because application code
using the old name needs updating. Application deployment coordination belongs to
the application owner.

A single hint describes one transition. After successive renames, a database that
predates the named source must receive the earlier transition before the latest
one. Kunii does not infer ancestry from unrelated column names.

## Automatic rebuilds

Forward D1 and Durable Object migrations can rebuild tables for existing-column constraint/default
changes and table CHECK changes. The engine creates a replacement, copies values
and row identities, swaps it in, and recreates explicit indexes and triggers.
Constraint violations abort the batch, including the history write.

The initial implementation requires the complete live table definition to match
the inspected definition structurally. SQL whitespace and identifier quoting do
not determine equivalence. It rejects omitted columns, type or primary-key
transformations, incoming foreign keys, view dependencies, and replacement-name
collisions. These errors occur before executing the plan. Incoming foreign keys
require a future coordinated rebuild of dependent tables because D1 deferral does
not suppress cascading deletes. Adopted schemas require accurate introspection
before they can participate in automatic rebuilds.

Native rename preserves SQLite-managed dependencies. Simultaneous renames and
definition changes that cannot be verified against the prior definition fail.

## Execution and performance

Unchanged schemas use the existing isolate cache and history fast path. Rename
planning is in memory. Additional dependency inspection runs only for rebuilds
and is shared by all rebuilt tables in a plan. View references are checked
conservatively by SQL identifier tokens, allowing unrelated views.
One migration engine drives both backends. Its SQL operations are awaited for D1
and completed synchronously for Durable Objects. DDL and history execute in one
native D1 batch or one DO `transactionSync` callback. Concurrent plans retry against the
winning history version. Executor-only calls retain additive compatibility.
When ADD COLUMN cannot preserve a default or constraint, the effective snapshot
records the weaker definition and stays pending. A forward atomic migration can
instead rebuild the table to preserve the full definition, including raw defaults.

Pass `ctx.storage` to the synchronous DO initializer to supply transaction support.
Bare SqlStorage without an attached transaction function has the same executor-only
fallback restrictions as a D1 executor without its native batch client.
`runDurableObjectMigrations(storage, schema)` also exposes the migration result.
The public SQL splitter respects literals, comments, and complete trigger bodies.

Rebuilds currently copy the table in one transaction. Resumable large migrations,
cron execution, Time Travel recovery integration, and table renames are subsequent work.

## Validation

Tests must exercise populated databases, repeated hints, skipped versions,
conflicting names, rollback protection, constraint failures, dependent data,
preserved indexes/triggers, and concurrent migration execution.
Paired scenarios exercise the public D1 initializer and synchronous DO initializer
with the same assertions, so backend parity is enforced by tests.
