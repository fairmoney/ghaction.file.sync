# Fix Codebase Issues Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 high-confidence bugs identified during full codebase review: deprecated node12 runtime, one-repo-fails-all crash, multiple-sync-groups data loss, auth error masking, and missing getContent error handling.

**Architecture:** We first create a `toErrorMessage()` utility (TDD) so every catch block can safely extract error messages from `unknown` values. Then we apply fixes in dependency order: action.yml (trivial, no deps), octokit.ts (auth fix), fileSync.ts (three fixes stacked). Each commit is atomic and the final task rebuilds the dist bundle.

**Tech Stack:** TypeScript 4.1.3, Jest 26 (jest-circus runner), ts-jest, @vercel/ncc, @actions/core 1.2.6, @actions/github 4.0.0, octokit-plugin-create-pull-request 3.9.2

**Important codebase conventions:**
- No semicolons (enforced by Prettier + ESLint)
- Single quotes, no bracket spacing, 2-space indent
- Explicit return types on functions (`allowExpressions: true`)
- No `any` type, no `require()` imports
- `yarn all` = build + format + lint + package + test (the CI check)
- `dist/index.js` is committed — always run `yarn package` after changes

---

### Task 1: Create `toErrorMessage` utility with tests

A shared helper to safely extract `.message` from unknown catch values. Every subsequent task depends on this.

**Files:**
- Create: `src/util.ts`
- Create: `__tests__/util.test.ts`

**Step 1: Write the failing test**

Create `__tests__/util.test.ts` with this exact content:

```typescript
import {toErrorMessage} from '../src/util'

describe('toErrorMessage', () => {
  it('extracts message from Error objects', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('converts string errors to string', () => {
    expect(toErrorMessage('something broke')).toBe('something broke')
  })

  it('handles null', () => {
    expect(toErrorMessage(null)).toBe('Unknown error')
  })

  it('handles undefined', () => {
    expect(toErrorMessage(undefined)).toBe('Unknown error')
  })

  it('handles objects without message property', () => {
    expect(toErrorMessage({code: 404})).toBe('Unknown error')
  })

  it('handles objects with message property', () => {
    expect(toErrorMessage({message: 'not found'})).toBe('not found')
  })

  it('handles number errors', () => {
    expect(toErrorMessage(42)).toBe('Unknown error')
  })
})
```

**Step 2: Run the test to verify it fails**

Run: `yarn test -- --testPathPattern util`
Expected: FAIL — "Cannot find module '../src/util'"

**Step 3: Implement the utility**

Create `src/util.ts` with this exact content:

```typescript
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as {message: unknown}).message === 'string'
  ) {
    return (error as {message: string}).message
  }
  return 'Unknown error'
}
```

**Step 4: Run the test to verify it passes**

Run: `yarn test -- --testPathPattern util`
Expected: PASS — 7 tests passing

**Step 5: Verify build compiles**

Run: `yarn build`
Expected: No errors

**Step 6: Commit**

```bash
git add src/util.ts __tests__/util.test.ts
git commit -m "feat: add toErrorMessage helper for safe error extraction"
```

---

### Task 2: Update node12 to node20 in action.yml

GitHub Actions deprecated node12 (EOL April 2022). The action will fail or show warnings on current runners.

**Files:**
- Modify: `action.yml:32`

**Step 1: Make the change**

In `action.yml` line 32, change:
```yaml
  using: node12
```
to:
```yaml
  using: node20
```

**Step 2: Verify the change**

Run: `grep 'using:' action.yml`
Expected output: `  using: node20`

**Step 3: Commit**

```bash
git add action.yml
git commit -m "fix: update runtime from deprecated node12 to node20"
```

---

### Task 3: Fix auth error masking in octokit.ts

**Bug:** `src/octokit.ts:59-63` — the catch block replaces ALL auth errors with a generic "install your GitHub App" message. Even the "No credentials provided" error (thrown at line 55) gets masked, making the message actively misleading.

**Fix:** Use `toErrorMessage()` for safe extraction, and include the original error message in the thrown error.

**Files:**
- Modify: `src/octokit.ts:1-63`

**Step 1: Add the import**

Add this line after line 9 (`import {Log} from './log'`):

```typescript
import {toErrorMessage} from './util'
```

**Step 2: Replace the catch block**

Replace lines 59-63 (the catch block). Current code:

```typescript
  } catch (e) {
    log.error(e.message)
    throw new Error(
      '🔒 Failed to authenticate, did you remember to install your GitHub App?'
    )
  } finally {
```

Replace with:

```typescript
  } catch (e) {
    const msg = toErrorMessage(e)
    log.error(msg)
    throw new Error(`🔒 Failed to authenticate: ${msg}`)
  } finally {
```

**Step 3: Verify build compiles**

Run: `yarn build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/octokit.ts
git commit -m "fix: preserve original error context in auth failure messages"
```

---

### Task 4: Fix one-repo-fails-all crash in fileSync.ts

**Bug:** `src/fileSync.ts:135-141` — the catch around `createPullRequest()` only handles `"Reference already exists"`. Any other error (403, 404, 422, network) is re-thrown, crashing the entire action. 1 failing repo out of 20 prevents the other 19 from getting PRs.

**Fix:** Log a warning and continue instead of re-throwing.

**Files:**
- Modify: `src/fileSync.ts:1-141`

**Step 1: Add the import**

Add this line after line 6 (`import {dump} from 'js-yaml'`):

```typescript
import {toErrorMessage} from './util'
```

**Step 2: Replace the catch block in run()**

Replace lines 135-141 (the catch block inside the PR creation try). Current code:

```typescript
          } catch (error) {
            if (error.message === 'Reference already exists') {
              this.log.info(`⛔ Pull request already exists`)
            } else {
              throw error
            }
          }
```

Replace with:

```typescript
          } catch (error) {
            const msg = toErrorMessage(error)
            if (msg === 'Reference already exists') {
              this.log.info(`⛔ Pull request already exists`)
            } else {
              this.log.warning(
                `⚠️ Failed to create pull request for ${toRepoStr(remoteRepo)}: ${msg}`
              )
            }
          }
```

**Step 3: Verify build compiles**

Run: `yarn build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/fileSync.ts
git commit -m "fix: continue syncing remaining repos when one PR creation fails"
```

---

### Task 5: Fix missing getContent error handling in fileSync.ts

**Bug:** `src/fileSync.ts:89-98` — the `getContent()` API call has no try-catch. If any source file doesn't exist (404), the error crashes the entire action. The file fetch loop runs BEFORE any PR creation, so a single missing source file prevents ALL repos from receiving updates. Also, if the path is a directory, `getContent()` returns an array — `'content' in data` silently fails and the file is skipped without warning.

**Fix:** Wrap in try-catch, add directory detection, log warnings, continue.

**Files:**
- Modify: `src/fileSync.ts:89-98`

**Step 1: Replace the file fetch loop body**

Replace lines 89-98 in the `run()` method. Current code:

```typescript
      for (const file of sync.files) {
        this.log.info(`📝 Fetching ${file.src}`)
        const {data} = await this.octokit.repos.getContent({
          ...this.repo,
          path: file.src
        })
        if ('content' in data) {
          file.content = data.content
        }
      }
```

Replace with:

```typescript
      for (const file of sync.files) {
        this.log.info(`📝 Fetching ${file.src}`)
        try {
          const {data} = await this.octokit.repos.getContent({
            ...this.repo,
            path: file.src
          })
          if (Array.isArray(data)) {
            this.log.warning(
              `⚠️ Skipping '${file.src}': path is a directory, not a file`
            )
            continue
          }
          if ('content' in data) {
            file.content = data.content
          }
        } catch (error) {
          this.log.warning(
            `⚠️ Failed to fetch '${file.src}': ${toErrorMessage(error)}`
          )
        }
      }
```

Note: `toErrorMessage` import was already added in Task 4.

**Step 2: Verify build compiles**

Run: `yarn build`
Expected: No errors

**Step 3: Commit**

```bash
git add src/fileSync.ts
git commit -m "fix: handle missing/directory source files gracefully instead of crashing"
```

---

### Task 6: Fix multiple sync groups silently losing files

**Bug:** `src/fileSync.ts:117` — the branch name `owner-repo-sha` is deterministic per commit, not per sync group. If two sync groups target the same repo, the second hits `"Reference already exists"` and its files are silently dropped. Example:

```yaml
syncs:
  - repos: [owner/repo]
    files: [{src: file1.yml}]
  - repos: [owner/repo]
    files: [{src: file2.yml}]
# file2.yml is silently lost
```

**Fix:** Include the sync group index in the branch name so each group gets a unique branch/PR.

**Files:**
- Modify: `src/fileSync.ts:87` and `src/fileSync.ts:117`

**Step 1: Change the for loop to track index**

Replace line 87. Current code:

```typescript
    for (const sync of config.syncs) {
```

Replace with:

```typescript
    for (let syncIndex = 0; syncIndex < config.syncs.length; syncIndex++) {
      const sync = config.syncs[syncIndex]
```

**Step 2: Add sync index to branch name**

Replace line 117 (will have shifted due to Step 1 — find the `head:` line in prOptions). Current code:

```typescript
          head: `${toRepoStr(this.repo, '-')}-${this.gitSha}`,
```

Replace with:

```typescript
          head: `${toRepoStr(this.repo, '-')}-${this.gitSha}-${syncIndex}`,
```

**Step 3: Verify build compiles**

Run: `yarn build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/fileSync.ts
git commit -m "fix: include sync group index in branch name to prevent data loss"
```

---

### Task 7: Fix remaining unsafe error.message accesses

**Bug:** Two more catch blocks access `error.message` directly: `src/main.ts:14` and `src/fileSync.ts:77`. While TypeScript 4.1.3 types catch as `any` (not `unknown`), this is still unsafe at runtime and inconsistent now that other catch blocks use `toErrorMessage()`.

**Files:**
- Modify: `src/main.ts:1-14`
- Modify: `src/fileSync.ts:74-78`

**Step 1: Fix main.ts**

Add import after line 4 (`import {Log} from './log'`):

```typescript
import {toErrorMessage} from './util'
```

Replace line 14. Current code:

```typescript
    core.setFailed(error.message)
```

Replace with:

```typescript
    core.setFailed(toErrorMessage(error))
```

**Step 2: Fix fileSync.ts isRepositoryArchived catch block**

Replace lines 74-78. Current code:

```typescript
    } catch (error) {
      this.log.warning(
        `⚠️ Failed to check archive status for ${toRepoStr(repo)}: ${
          error.message
        }`
      )
```

Replace with:

```typescript
    } catch (error) {
      this.log.warning(
        `⚠️ Failed to check archive status for ${toRepoStr(repo)}: ${
          toErrorMessage(error)
        }`
      )
```

Note: `toErrorMessage` import was already added in Task 4.

**Step 3: Verify build compiles**

Run: `yarn build`
Expected: No errors

**Step 4: Commit**

```bash
git add src/main.ts src/fileSync.ts
git commit -m "fix: use toErrorMessage for safe error access in all catch blocks"
```

---

### Task 8: Rebuild dist bundle and run full validation

`dist/index.js` is committed and is the actual action entry point. It must be rebuilt after all source changes.

**Files:**
- Regenerate: `dist/index.js`

**Step 1: Run the full CI pipeline**

Run: `yarn all`
Expected: All steps pass — build, format, lint, package, test. Output ends with test results (8 tests: 7 from util.test.ts + 1 from main.test.ts).

If `yarn all` fails at any step, fix the issue before proceeding. Common problems:
- **format fails**: Run `yarn format` to auto-fix, then re-run `yarn all`
- **lint fails**: Check the error for which rule, fix manually
- **test fails**: Check which test failed, debug

**Step 2: Verify dist was updated**

Run: `git diff --stat dist/`
Expected: `dist/index.js` shows changes

**Step 3: Commit**

```bash
git add dist/index.js
git commit -m "chore: rebuild dist bundle with all fixes"
```

---

### Task 9: Update CLAUDE.md architecture section

Document the new `util.ts` module.

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add util.ts to architecture block**

In the architecture section, after the `src/log.ts` line, add:

```
src/util.ts      → Shared utilities: toErrorMessage() for safe error extraction from unknown catch values
```

So the full architecture block becomes:

```
src/main.ts      → Entry point: wires up Log, Octokit, FileSync, calls fileSync.run()
src/context.ts   → Parses action inputs (githubToken/appId/privateKey/configFile/dryRun) from @actions/core
src/octokit.ts   → Auth: supports GitHub token OR GitHub App (appId+privateKey) via @octokit/auth-app
                   Extends Octokit with two plugins: @probot/octokit-plugin-config + octokit-plugin-create-pull-request
src/fileSync.ts  → Core logic: loads config YAML, fetches source file contents, creates PRs in target repos
src/types.ts     → Interfaces: Config, Sync, File, Repo, Inputs
src/log.ts       → Thin wrapper over @actions/core logging; prepends "[dryrun]" when dry-run mode is active
src/util.ts      → Shared utilities: toErrorMessage() for safe error extraction from unknown catch values
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add util.ts to CLAUDE.md architecture section"
```

---

## Summary of all changes

| Task | File | What changes | Bug fixed |
|------|------|-------------|-----------|
| 1 | `src/util.ts`, `__tests__/util.test.ts` | New utility + tests | Foundation for all error fixes |
| 2 | `action.yml` | `node12` → `node20` | Deprecated runtime |
| 3 | `src/octokit.ts` | Catch block preserves original error | Auth error masking |
| 4 | `src/fileSync.ts` | PR catch: warn + continue instead of throw | One repo crashes all |
| 5 | `src/fileSync.ts` | getContent: try-catch + directory check | Missing file kills all syncs |
| 6 | `src/fileSync.ts` | Branch name includes syncIndex | Multi-group data loss |
| 7 | `src/main.ts`, `src/fileSync.ts` | Replace `error.message` with `toErrorMessage()` | Unsafe error access |
| 8 | `dist/index.js` | Rebuild bundle | Ship all fixes |
| 9 | `CLAUDE.md` | Document util.ts | Keep docs current |

## Final state of modified files

After all tasks, these files will have been touched:
- `src/util.ts` — NEW (Task 1)
- `__tests__/util.test.ts` — NEW (Task 1)
- `action.yml` — line 32 changed (Task 2)
- `src/octokit.ts` — new import + catch block changed (Task 3)
- `src/fileSync.ts` — new import + 4 code changes (Tasks 4, 5, 6, 7)
- `src/main.ts` — new import + catch block changed (Task 7)
- `dist/index.js` — rebuilt (Task 8)
- `CLAUDE.md` — architecture section updated (Task 9)
