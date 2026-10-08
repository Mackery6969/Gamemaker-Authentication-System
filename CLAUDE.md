# Repository Guidelines & Refactoring Rules

- Architecture: Prefer modular, decoupled functions and clean separation of concerns.
- Code Smells: Replace deeply nested conditionals with early returns and guard clauses.
- Modern Syntax: Replace verbose boilerplate with modern language idioms.
- Performance: Eliminate redundant file I/O, duplicate object allocations, and unindexed lookups.
- Safety: Ensure all boundary cases, null values, and asynchronous errors are handled.
- Constraint: Never alter public API signatures without backwards compatibility. All tests must pass before opening a PR.
