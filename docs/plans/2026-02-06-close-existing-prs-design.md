# Design: Close Existing Sync PRs

## Summary

When the action creates a new sync PR for a target repo, it should close any previously opened (and still unmerged) sync PRs for that same target repo. This prevents stale PRs from accumulating.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| When to close | Always, after creating a new PR | Simplest mental model; old PRs are always stale once a new sync runs |
| How to identify old PRs | Branch name prefix (`<owner>-<repo>-`) | Deterministic, programmatically generated, no collision risk |
| Delete branches too? | Yes | Automated branches serve no purpose once PR is closed |
| Add comment on old PR? | Yes, referencing new PR number | Audit trail for target repo maintainers |
| Sequencing | Create new PR first, then close old | Allows referencing new PR number in the close comment |
| Configuration toggle | None (always-on) | YAGNI — this is always desirable behavior |

## Flow

For each target repo within a sync group:

1. Skip if archived (existing)
2. Create the new sync PR (existing logic)
3. If PR was created successfully (not null, not "Reference already exists"):
   a. List open PRs where head branch starts with `<owner>-<repo>-`
   b. Filter out the PR we just created
   c. For each old PR:
      - Add comment: `Superseded by #<new_pr_number>`
      - Close the PR
      - Delete the head branch
4. Log results

## New Method

```typescript
async closeExistingPRs(
  remoteRepo: Repo,
  newPrNumber: number,
  branchPrefix: string
): Promise<void>
```

### API Calls Per Old PR

1. `octokit.rest.pulls.list({ state: 'open', per_page: 100 })` — find candidates
2. Client-side filter by `head.ref.startsWith(branchPrefix)`
3. `octokit.rest.issues.createComment()` — superseded comment
4. `octokit.rest.pulls.update({ state: 'closed' })` — close PR
5. `octokit.rest.git.deleteRef()` — delete branch

### Error Handling

- Each old PR cleanup wrapped in try/catch — one failure doesn't block others
- Branch deleteRef may 404 if already deleted — catch and ignore
- Follows same resilience pattern as cascading failure fix

### Dry Run

When `this.dryRun` is true, log what would happen but make no API calls.

## Edge Cases

| Case | Behavior |
|------|----------|
| New PR returns null (no changes) | Skip cleanup — old PR may still be relevant |
| "Reference already exists" error | Skip cleanup — existing PR from same SHA is still current |
| Old PR opened by different actor | Still close — branch prefix is strong identification |
| Branch already deleted manually | deleteRef 404 caught and ignored |
| Many stale PRs (>100) | Use per_page: 100; unlikely to exceed in practice |

## Files to Modify

- `src/fileSync.ts` — Add `closeExistingPRs()` method, call it after successful PR creation
- `dist/index.js` — Rebuild bundle
