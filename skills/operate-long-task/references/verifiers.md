# Deterministic verifiers

Checks are evaluated at `complete`. Every check must pass. Paths are resolved inside the task workspace or an operator-configured verification root; path traversal and resolved symlink escapes fail closed.

## Shapes

```json
{ "kind": "file_exists", "path": "dist/report.pdf" }
```

```json
{ "kind": "min_file_bytes", "path": "dist/report.pdf", "value": 1024 }
```

```json
{ "kind": "file_contains", "path": "report.md", "value": "# Summary" }
```

```json
{
  "kind": "json_equals",
  "path": "result.json",
  "pointer": "/status",
  "value": "ready"
}
```

## Guidance

- Combine `file_exists` and `min_file_bytes` for generated binary artifacts.
- Prefer `json_equals` over free-text inspection when a program can emit structured status.
- Keep `file_contains` values exact and stable; do not use prose likely to vary across model runs.
- Verifiers prove only their stated conditions. Add a criterion for every user-visible requirement.
