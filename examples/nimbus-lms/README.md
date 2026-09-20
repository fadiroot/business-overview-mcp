# Nimbus LMS (demo)

A small, deliberately imperfect course platform used to demonstrate what
[Business Overview MCP](../../README.md) extracts from a codebase. It is not a real product and
does not run.

It contains a NestJS-style API, a Prisma schema, a Next.js-style frontend, and a handful of
planted problems: a delete endpoint that lost its guard, a role that only the UI enforces, a role
nobody checks, an orphaned table, and inconsistent rules on reviews.

Scan it with:

```
scan_project        root=/absolute/path/to/examples/nimbus-lms
generate_report     root=/absolute/path/to/examples/nimbus-lms
```
