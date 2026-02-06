import {FileSync} from '../src/fileSync'
import {Log} from '../src/log'
import {Inputs, Repo} from '../src/types'
import {Context} from '@actions/github/lib/context'

// Mock Octokit methods used by closeExistingPRs
function createMockOctokit(
  overrides: {
    pullsList?: jest.Mock
    issuesCreateComment?: jest.Mock
    pullsUpdate?: jest.Mock
    gitDeleteRef?: jest.Mock
  } = {}
): Record<string, unknown> {
  return {
    rest: {
      pulls: {
        list: overrides.pullsList ?? jest.fn().mockResolvedValue({data: []}),
        update: overrides.pullsUpdate ?? jest.fn().mockResolvedValue({})
      },
      issues: {
        createComment:
          overrides.issuesCreateComment ?? jest.fn().mockResolvedValue({})
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
    payload: {
      repository: {html_url: 'https://github.com/source-owner/source-repo'}
    }
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

    const octokit = createMockOctokit({
      pullsList,
      issuesCreateComment,
      pullsUpdate,
      gitDeleteRef
    })
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
      data: [{number: 5, head: {ref: 'unrelated-feature-branch'}}]
    })
    const issuesCreateComment = jest.fn()
    const pullsUpdate = jest.fn()
    const gitDeleteRef = jest.fn()

    const octokit = createMockOctokit({
      pullsList,
      issuesCreateComment,
      pullsUpdate,
      gitDeleteRef
    })
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

    const octokit = createMockOctokit({
      pullsList,
      issuesCreateComment,
      pullsUpdate,
      gitDeleteRef
    })
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
    const issuesCreateComment = jest
      .fn()
      .mockRejectedValueOnce(new Error('API rate limit'))
      .mockResolvedValueOnce({})
    const pullsUpdate = jest.fn().mockResolvedValue({})
    const gitDeleteRef = jest.fn().mockResolvedValue({})

    const octokit = createMockOctokit({
      pullsList,
      issuesCreateComment,
      pullsUpdate,
      gitDeleteRef
    })
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
      data: [{number: 10, head: {ref: 'source-owner-source-repo-old1-0'}}]
    })
    const issuesCreateComment = jest.fn().mockResolvedValue({})
    const pullsUpdate = jest.fn().mockResolvedValue({})
    const gitDeleteRef = jest
      .fn()
      .mockRejectedValue(new Error('Reference does not exist'))

    const octokit = createMockOctokit({
      pullsList,
      issuesCreateComment,
      pullsUpdate,
      gitDeleteRef
    })
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

    const octokit = createMockOctokit({
      pullsList,
      issuesCreateComment,
      pullsUpdate,
      gitDeleteRef
    })
    const fileSync = createFileSync(octokit, true)

    await fileSync.closeExistingPRs(remoteRepo, 50, branchPrefix)

    expect(pullsList).not.toHaveBeenCalled()
    expect(issuesCreateComment).not.toHaveBeenCalled()
    expect(pullsUpdate).not.toHaveBeenCalled()
    expect(gitDeleteRef).not.toHaveBeenCalled()
  })
})
