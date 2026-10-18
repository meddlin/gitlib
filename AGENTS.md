# AGENTS.md

## GitHub Actions

Every `uses:` reference in `.github/workflows/` (and in any composite action under `.github/actions/`) must be pinned to a full 40-character commit SHA. Mutable refs (tags like `v4`, branches like `main`, or short SHAs) are not allowed, because they can be moved to point at different code.

Write the SHA and keep the human-readable version in a trailing comment:

```yaml
- uses: actions/checkout@<full-40-char-sha> # v4.2.2
```

When adding or updating an action:

- Resolve the SHA of the exact release tag you want, e.g. `git ls-remote https://github.com/actions/checkout 'refs/tags/v4.2.2^{}' refs/tags/v4.2.2`. If the tag is annotated, use the dereferenced (`^{}`) commit SHA.
- Never copy a SHA from a fork or an unverified source; confirm it belongs to the action's own repository.
- Put the version in the trailing comment so Dependabot can keep the pin current.
- Do not use `@main`, `@master`, `@latest`, or a bare major tag, even for first-party `actions/*` actions.
- Local actions (`uses: ./path`) and `docker://` images must also be immutable; pin Docker images by `@sha256:` digest.

Before finishing any change that touches a workflow, check for violations:

```bash
grep -rnE 'uses:\s*[^./][^@]*@' .github | grep -vE '@[0-9a-f]{40}(\s|$)'
```

No output means every external action is pinned.
