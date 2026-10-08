# Repository Standards

## Function 1: Security Policy
- Treat all scanner findings in `semgrep-results.json` as triage items.
- Real Flaws: Patch using standard, secure library implementations rather than custom string filters.
- False Positives: Do not alter functional logic. Insert an inline suppression comment (`// nosemgrep: <rule-id>` or `# nosemgrep: <rule-id>`) with an explanatory comment on the line immediately preceding the flagged code.
- Zero Regressions: All existing test suites must pass before opening a PR.

## Function 2: Code Quality & Refactoring Policy
- Maintain strict backward compatibility for all public functions, classes, and APIs.
- Replace deep conditional nesting with early returns and guard clauses.
- Extract duplicated business logic into private, single-responsibility helper functions.
- Modernize outdated language idioms (e.g., replace verbose loops with native functional methods where readability improves).
- Never mix security patches with style/quality refactoring in the same run.
