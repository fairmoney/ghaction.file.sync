# Close Existing Sync PRs — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** After creating a new sync PR, close any previously opened (unmerged) sync PRs for the same target repo — preventing stale PR accumulation.

**Architecture:** Add a `closeExistingPRs()` method to the `FileSync` class in `src/fileSync.ts`. Call it after successful PR creation. It lists open PRs by branch prefix, comments "Superseded by #N", closes each, and deletes the branch. Each old PR cleanup is independent and wrapped in try/catch.

**Tech Stack:** TypeScript, Octokit REST API (`pulls.list`, `issues.createComment`, `pulls.update`, `git.deleteRef`), Jest for tests.

**Design doc:** `docs/plans/2026-02-06-close-existing-prs-design.md`

---

### Task 1: Write the `closeExistingPRs` unit tests

**Files:**
- Create: `__tests__/fileSync.test.ts`

**Why this test file:** The project has no tests for `FileSync` yet. We need a test file that mocks Octokit and verifies the new method's behavior in isolation.

**Step 1: Write the test file**

Create `__tests__/fileSync.test.ts` with these test cases:

```typescript
import {FileSync} from '../src/fileSync'
import {Log} from '../src/log'
import {Inputs, Repo} from '../src/types'
import {Context} from '@actions/github/lib/context'

// Mock Octokit methods used by closeExistingPRs
function createMockOctokit(overrides: {
  pullsList?: jest.Mock
  issuesCreateComment?: jest.Mock
  pullsUpdate?: jest.Mock
  gitDeleteRef?: jest.Mock
} = {}): Record<string, unknown> {
  return {
    rest: {
      pulls: {
        list: overrides.pullsList ?? jest.fn().mockResolvedValue({data: []}),
        update: overrides.pullsUpdate ?? jest.fn().mockResolvedValue({})
      },
      issues: {
        createComment: overrides.issuesCreateComment ?? jest.fn().mockResolvedValue({})
      },
      git: {
        deleteRef: overrides.gitDeleteRef ?? jest.fn().mockResolvedValue({})
      }
    }
  }
}

function createFileSync(
  octokit: Record<string, unknown>,
  dryRun = false
): FileSync {
  const inputs: Inputs = {
    githubToken: 'token',
    privateKey: '',
    appId: '',
    configFile: '.github/syncs.yml',
    dryRun
  }
  const context = {
    repo: {owner: 'source-owner', repo: 'source-repo'},
    sha: 'abc123def456',
    runId: 12345,
    payload: {repository: {html_url: 'https://github.com/source-owner/source-repo'}}
  } as unknown as Context
  const log = new Log(dryRun)
  return new FileSync(inputs, context, octokit as never, log)
}

describe('closeExistingPRs', () => {
  const remoteRepo: Repo = {owner: 'target-owner', repo: 'target-repo'}
  const branchPrefix = 'source-owner-source-repo-'

  it('closes old PRs matching branch prefix and skips the new PR', async () => {
    const pullsList = jest.fn().mockResolvedValue({
      data: [
        {number: 10, head: {ref: 'source-owner-source-repo-oldsha123-0'}},
        {number: 20, head: {ref: 'source-owner-source-repo-oldsha456-1'}},
        {number: 30, head: {ref: 'unrelated-branch'}}
      ]
    })
    const issuesCreateComment = jest.fn().mockResolvedValue({})
    const pullsUpdate = jest.fn().mockResolvedValue({})
    const gitDeleteRef = jest.fn().mockResolvedValue({})

    const octokit = createMockOctokit({pullsList, issuesCreateComment, pullsUpdate, gitDeleteRef})
    const fileSync = createFileSync(octokit)

    await fileSync.closeExistingPRs(remoteRepo, 50, branchPrefix)

    // Should list open PRs
    expect(pullsList).toHaveBeenCalledWith({
      owner: 'target-owner',
      repo: 'target-repo',
      state: 'open',
      per_page: 100
    })

    // Should comment, close, and delete branch for PRs 10 and 20 (not 30 — wrong prefix, not 50 — new PR)
    expect(issuesCreateComment).toHaveBeenCalledTimes(2)
    expect(pullsUpdate).toHaveBeenCalledTimes(2)
    expect(gitDeleteRef).toHaveBeenCalledTimes(2)

    // Verify comment on PR #10
    expect(issuesCreateComment).toHaveBeenCalledWith({
      owner: 'target-owner',
      repo: 'target-repo',
      issue_number: 10,
      body: 'Superseded by #50'
    })

    // Verify close PR #10
    expect(pullsUpdate).toHaveBeenCalledWith({
      owner: 'target-owner',
      repo: 'target-repo',
      pull_number: 10,
      state: 'closed'
    })

    // Verify delete branch for PR #10
    expect(gitDeleteRef).toHaveBeenCalledWith({
      owner: 'target-owner',
      repo: 'target-repo',
      ref: 'heads/source-owner-source-repo-oldsha123-0'
    })
  })

  it('does nothing when no open PRs match the prefix', async () => {
    const pullsList = jest.fn().mockResolvedValue({
      data: [
        {number: 5, head: {ref: 'unrelated-feature-branch'}}
      ]
    })
    const issuesCreateComment = jest.fn()
    const pullsUpdate = jest.fn()
    const gitDeleteRef = jest.fn()

    const octokit = createMockOctokit({pullsList, issuesCreateComment, pullsUpdate, gitDeleteRef})
    const fileSync = createFileSync(octokit)

    await fileSync.closeExistingPRs(remoteRepo, 50, branchPrefix)

    expect(issuesCreateComment).not.toHaveBeenCalled()
    expect(pullsUpdate).not.toHaveBeenCalled()
    expect(gitDeleteRef).not.toHaveBeenCalled()
  })

  it('skips the newly created PR number', async () => {
    const pullsList = jest.fn().mockResolvedValue({
      data: [
        {number: 50, head: {ref: 'source-owner-source-repo-newsha789-0'}}
      ]
    })
    const issuesCreateComment = jest.fn()
    const pullsUpdate = jest.fn()
    const gitDeleteRef = jest.fn()

    const octokit = createMockOctokit({pullsList, issuesCreateComment, pullsUpdate, gitDeleteRef})
    const fileSync = createFileSync(octokit)

    await fileSync.closeExistingPRs(remoteRepo, 50, branchPrefix)

    expect(issuesCreateComment).not.toHaveBeenCalled()
    expect(pullsUpdate).not.toHaveBeenCalled()
    expect(gitDeleteRef).not.toHaveBeenCalled()
  })

  it('continues closing other PRs if one fails', async () => {
    const pullsList = jest.fn().mockResolvedValue({
      data: [
        {number: 10, head: {ref: 'source-owner-source-repo-old1-0'}},
        {number: 20, head: {ref: 'source-owner-source-repo-old2-1'}}
      ]
    })
    const issuesCreateComment = jest.fn()
      .mockRejectedValueOnce(new Error('API rate limit'))
      .mockResolvedValueOnce({})
    const pullsUpdate = jest.fn().mockResolvedValue({})
    const gitDeleteRef = jest.fn().mockResolvedValue({})

    const octokit = createMockOctokit({pullsList, issuesCreateComment, pullsUpdate, gitDeleteRef})
    const fileSync = createFileSync(octokit)

    // Should not throw
    await fileSync.closeExistingPRs(remoteRepo, 50, branchPrefix)

    // PR #10 comment failed, so close+delete for #10 should be skipped
    // PR #20 should still be fully processed
    expect(issuesCreateComment).toHaveBeenCalledTimes(2)
    expect(pullsUpdate).toHaveBeenCalledTimes(1)
    expect(gitDeleteRef).toHaveBeenCalledTimes(1)
  })

  it('ignores 404 when deleting an already-deleted branch', async () => {
    const pullsList = jest.fn().mockResolvedValue({
      data: [
        {number: 10, head: {ref: 'source-owner-source-repo-old1-0'}}
      ]
    })
    const issuesCreateComment = jest.fn().mockResolvedValue({})
    const pullsUpdate = jest.fn().mockResolvedValue({})
    const gitDeleteRef = jest.fn().mockRejectedValue(new Error('Reference does not exist'))

    const octokit = createMockOctokit({pullsList, issuesCreateComment, pullsUpdate, gitDeleteRef})
    const fileSync = createFileSync(octokit)

    // Should not throw — branch deletion failure is non-fatal
    await fileSync.closeExistingPRs(remoteRepo, 50, branchPrefix)

    expect(issuesCreateComment).toHaveBeenCalledTimes(1)
    expect(pullsUpdate).toHaveBeenCalledTimes(1)
    expect(gitDeleteRef).toHaveBeenCalledTimes(1)
  })

  it('skips API calls in dry run mode', async () => {
    const pullsList = jest.fn()
    const issuesCreateComment = jest.fn()
    const pullsUpdate = jest.fn()
    const gitDeleteRef = jest.fn()

    const octokit = createMockOctokit({pullsList, issuesCreateComment, pullsUpdate, gitDeleteRef})
    const fileSync = createFileSync(octokit, true)

    await fileSync.closeExistingPRs(remoteRepo, 50, branchPrefix)

    expect(pullsList).not.toHaveBeenCalled()
    expect(issuesCreateComment).not.toHaveBeenCalled()
    expect(pullsUpdate).not.toHaveBeenCalled()
    expect(gitDeleteRef).not.toHaveBeenCalled()
  })
})
```

**Step 2: Run the tests to verify they fail**

Run: `yarn test -- --testPathPattern=fileSync`

Expected: FAIL — `closeExistingPRs` does not exist on `FileSync` yet. The error should be something like `fileSync.closeExistingPRs is not a function` or a TypeScript compilation error.

**Step 3: Commit the failing tests**

```bash
git add __tests__/fileSync.test.ts
git commit -m "test: add failing tests for closeExistingPRs method"
```

---

### Task 2: Implement `closeExistingPRs` method

**Files:**
- Modify: `src/fileSync.ts` (add method after `isRepositoryArchived`, around line 83)

**Step 1: Add the `closeExistingPRs` method to the `FileSync` class**

Insert this method after `isRepositoryArchived()` (after line 83 in `src/fileSync.ts`):

```typescript
  async closeExistingPRs(
    remoteRepo: Repo,
    newPrNumber: number,
    branchPrefix: string
  ): Promise<void> {
    if (this.dryRun) {
      this.log.info(
        `✔ Skipping cleanup of existing PRs for ${toRepoStr(remoteRepo)} due to dry run`
      )
      return
    }

    const {data: openPRs} = await this.octokit.rest.pulls.list({
      ...remoteRepo,
      state: 'open',
      per_page: 100
    })

    const stalePRs = openPRs.filter(
      pr =>
        pr.head.ref.startsWith(branchPrefix) && pr.number !== newPrNumber
    )

    for (const pr of stalePRs) {
      try {
        await this.octokit.rest.issues.createComment({
          ...remoteRepo,
          issue_number: pr.number,
          body: `Superseded by #${newPrNumber}`
        })
        await this.octokit.rest.pulls.update({
          ...remoteRepo,
          pull_number: pr.number,
          state: 'closed'
        })
        try {
          await this.octokit.rest.git.deleteRef({
            ...remoteRepo,
            ref: `heads/${pr.head.ref}`
          })
        } catch {
          // Branch may already be deleted — ignore
        }
        this.log.info(
          `🧹 Closed superseded PR #${pr.number} and deleted branch ${pr.head.ref}`
        )
      } catch (error) {
        this.log.warning(
          `⚠️ Failed to close PR #${pr.number} in ${toRepoStr(remoteRepo)}: ${toErrorMessage(error)}`
        )
      }
    }
  }
```

**Step 2: Run the tests to verify they pass**

Run: `yarn test -- --testPathPattern=fileSync`

Expected: All 6 tests in `fileSync.test.ts` PASS.

**Step 3: Run the full test suite**

Run: `yarn test`

Expected: All tests pass (existing `util.test.ts` + `main.test.ts` + new `fileSync.test.ts`).

**Step 4: Commit**

```bash
git add src/fileSync.ts __tests__/fileSync.test.ts
git commit -m "feat: add closeExistingPRs method to FileSync class"
```

---

### Task 3: Wire `closeExistingPRs` into the `run()` method

**Files:**
- Modify: `src/fileSync.ts` (the `run()` method, around lines 138-161)

**Step 1: Modify `run()` to call `closeExistingPRs` after successful PR creation**

In `src/fileSync.ts`, find the existing PR creation block inside `run()`. Currently it looks like this (around line 137-161):

```typescript
        if (this.dryRun) {
          this.log.info('✔ No pull request was created due to dry run')
        } else {
          try {
            const pr = await this.octokit.createPullRequest(prOptions)
            if (pr === null) {
              this.log.info(
                '✔ No pull request was created since there were no changes'
              )
            } else {
              this.log.info(
                `✅ Pull request created: ${pr.data.number} ${pr.data.html_url}`
              )
            }
          } catch (error) {
```

Replace the `else` block (the successful PR case, the part after `} else {` and before the closing of the if/else on `pr === null`) with:

```typescript
            } else {
              this.log.info(
                `✅ Pull request created: ${pr.data.number} ${pr.data.html_url}`
              )
              const branchPrefix = `${toRepoStr(this.repo, '-')}-`
              await this.closeExistingPRs(
                remoteRepo,
                pr.data.number,
                branchPrefix
              )
            }
```

The full block should now be:

```typescript
        if (this.dryRun) {
          this.log.info('✔ No pull request was created due to dry run')
        } else {
          try {
            const pr = await this.octokit.createPullRequest(prOptions)
            if (pr === null) {
              this.log.info(
                '✔ No pull request was created since there were no changes'
              )
            } else {
              this.log.info(
                `✅ Pull request created: ${pr.data.number} ${pr.data.html_url}`
              )
              const branchPrefix = `${toRepoStr(this.repo, '-')}-`
              await this.closeExistingPRs(
                remoteRepo,
                pr.data.number,
                branchPrefix
              )
            }
          } catch (error) {
            const msg = toErrorMessage(error)
            if (msg === 'Reference already exists') {
              this.log.info(`⛔ Pull request already exists`)
            } else {
              this.log.warning(
                `⚠️ Failed to create pull request for ${toRepoStr(
                  remoteRepo
                )}: ${msg}`
              )
            }
          }
        }
```

**Step 2: Run all tests**

Run: `yarn test`

Expected: All tests pass. The existing tests still pass because mocked Octokit doesn't have `rest.pulls.list` by default, and `closeExistingPRs` is only called in the real `run()` flow.

**Step 3: Run lint and format check**

Run: `yarn build && yarn lint && yarn format-check`

Expected: No errors. If Prettier complains, run `yarn format` to fix.

**Step 4: Commit**

```bash
git add src/fileSync.ts
git commit -m "feat: wire closeExistingPRs into run() after PR creation"
```

---

### Task 4: Build, verify, and bundle

**Files:**
- Modify: `dist/index.js` (rebuilt by `yarn package`)

**Step 1: Run the full CI pipeline**

Run: `yarn all`

This runs: `build` → `format` → `lint` → `package` → `test`

Expected: All steps pass with no errors.

**Step 2: Verify the bundle includes the new method**

Run: `grep -c 'closeExistingPRs' dist/index.js`

Expected: At least 1 match, confirming the new method is in the bundle.

**Step 3: Commit the bundle**

```bash
git add dist/index.js
git commit -m "chore: rebuild dist bundle with closeExistingPRs feature"
```

---

### Summary

| Task | Description | Key files |
|------|-------------|-----------|
| 1 | Write failing tests for `closeExistingPRs` | `__tests__/fileSync.test.ts` |
| 2 | Implement `closeExistingPRs` method | `src/fileSync.ts` |
| 3 | Wire into `run()` after successful PR creation | `src/fileSync.ts` |
| 4 | Build, lint, bundle, commit dist | `dist/index.js` |
