import {FileSync, filesToChanges} from '../src/fileSync'
import {Log} from '../src/log'
import {File, Inputs, Repo} from '../src/types'
import {Context} from '@actions/github/lib/context'

const SOURCE_SHA = 'abc123def4567890abc123def4567890abc12345'

// Mock Octokit methods used by closeExistingPRs
function createMockOctokit(
  overrides: {
    pullsList?: jest.Mock
    paginate?: jest.Mock
    issuesCreateComment?: jest.Mock
    pullsUpdate?: jest.Mock
    gitDeleteRef?: jest.Mock
  } = {}
): Record<string, unknown> {
  const pullsList =
    overrides.pullsList ?? jest.fn().mockResolvedValue({data: []})
  return {
    // Stands in for octokit.paginate, which walks every page and returns the
    // flattened array. The default delegates to pullsList so tests that only
    // care about a single page keep asserting against it.
    paginate:
      overrides.paginate ??
      jest.fn(
        async (
          endpoint: (params: unknown) => Promise<{data: unknown[]}>,
          params: unknown
        ) => (await endpoint(params)).data
      ),
    rest: {
      pulls: {
        list: pullsList,
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
  dryRun = false,
  skipCi = true
): FileSync {
  const inputs: Inputs = {
    githubToken: 'token',
    privateKey: '',
    appId: '',
    configFile: '.github/syncs.yml',
    dryRun,
    skipCi
  }
  const context = {
    repo: {owner: 'source-owner', repo: 'source-repo'},
    sha: SOURCE_SHA,
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

  it('closes stale PRs beyond the first page of results', async () => {
    // A single list call is capped at 100 results; a repo that has accumulated
    // more open sync PRs than that would silently keep the overflow open.
    const allStalePRs = Array.from({length: 150}, (_, i) => ({
      number: i + 1,
      head: {ref: `source-owner-source-repo-oldsha${i}-0`}
    }))

    // Only ever hands back the first page, like a lone pulls.list call.
    const pullsList = jest
      .fn()
      .mockResolvedValue({data: allStalePRs.slice(0, 100)})
    // Walks every page, like the real octokit.paginate.
    const paginate = jest.fn().mockResolvedValue(allStalePRs)
    const issuesCreateComment = jest.fn().mockResolvedValue({})
    const pullsUpdate = jest.fn().mockResolvedValue({})
    const gitDeleteRef = jest.fn().mockResolvedValue({})

    const octokit = createMockOctokit({
      pullsList,
      paginate,
      issuesCreateComment,
      pullsUpdate,
      gitDeleteRef
    })
    const fileSync = createFileSync(octokit)

    await fileSync.closeExistingPRs(remoteRepo, 500, branchPrefix)

    // Must paginate rather than issue a single capped list call.
    expect(paginate).toHaveBeenCalledWith(pullsList, {
      owner: 'target-owner',
      repo: 'target-repo',
      state: 'open',
      per_page: 100
    })

    // All 150 get closed, not just the first page's 100.
    expect(issuesCreateComment).toHaveBeenCalledTimes(150)
    expect(pullsUpdate).toHaveBeenCalledTimes(150)
    expect(gitDeleteRef).toHaveBeenCalledTimes(150)
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
      data: [{number: 50, head: {ref: 'source-owner-source-repo-newsha789-0'}}]
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

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), {status})
}

const PROTECTION_ROUTE =
  'GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks'
const RULES_ROUTE = 'GET /repos/{owner}/{repo}/rules/branches/{branch}'

// Stands in for octokit.request: each route either answers with `data` or
// rejects with the given error, like the real client on a non-2xx status.
function createRequestFake(responses: {
  protection: unknown | Error
  rules: unknown | Error
}): jest.Mock {
  return jest.fn(async (route: string) => {
    const response =
      route === PROTECTION_ROUTE
        ? responses.protection
        : route === RULES_ROUTE
          ? responses.rules
          : httpError(500, `unexpected route ${route}`)
    if (response instanceof Error) throw response
    return {data: response}
  })
}

describe('hasRequiredStatusChecks', () => {
  const repo: Repo = {owner: 'target-owner', repo: 'target-repo'}
  let warning: jest.SpyInstance

  beforeEach(() => {
    warning = jest.spyOn(Log.prototype, 'warning').mockImplementation()
  })

  afterEach(() => {
    warning.mockRestore()
  })

  it('is true when classic protection requires contexts', async () => {
    const request = createRequestFake({
      protection: {contexts: ['build'], checks: []},
      rules: []
    })
    const fileSync = createFileSync({request})

    await expect(
      fileSync.hasRequiredStatusChecks(repo, 'master')
    ).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith(PROTECTION_ROUTE, {
      owner: 'target-owner',
      repo: 'target-repo',
      branch: 'master'
    })
  })

  it('is true when classic protection requires only checks', async () => {
    const request = createRequestFake({
      protection: {contexts: [], checks: [{context: 'build', app_id: 1}]},
      rules: []
    })
    const fileSync = createFileSync({request})

    await expect(
      fileSync.hasRequiredStatusChecks(repo, 'master')
    ).resolves.toBe(true)
  })

  it('is false when classic protection lists no checks and no ruleset applies', async () => {
    const request = createRequestFake({
      protection: {contexts: [], checks: []},
      rules: []
    })
    const fileSync = createFileSync({request})

    await expect(
      fileSync.hasRequiredStatusChecks(repo, 'master')
    ).resolves.toBe(false)
    expect(warning).not.toHaveBeenCalled()
  })

  it('is false when the branch is not protected and no ruleset applies', async () => {
    const request = createRequestFake({
      protection: httpError(404, 'Branch not protected'),
      rules: []
    })
    const fileSync = createFileSync({request})

    await expect(
      fileSync.hasRequiredStatusChecks(repo, 'master')
    ).resolves.toBe(false)
    expect(warning).not.toHaveBeenCalled()
  })

  it('is true when a ruleset requires status checks', async () => {
    const request = createRequestFake({
      protection: httpError(404, 'Branch not protected'),
      rules: [
        {type: 'pull_request', parameters: {}},
        {
          type: 'required_status_checks',
          parameters: {required_status_checks: [{context: 'build'}]}
        }
      ]
    })
    const fileSync = createFileSync({request})

    await expect(
      fileSync.hasRequiredStatusChecks(repo, 'master')
    ).resolves.toBe(true)
    expect(request).toHaveBeenCalledWith(
      RULES_ROUTE,
      expect.objectContaining({
        owner: 'target-owner',
        repo: 'target-repo',
        branch: 'master'
      })
    )
  })

  it('is false when a ruleset rule requires an empty list of checks', async () => {
    const request = createRequestFake({
      protection: httpError(404, 'Branch not protected'),
      rules: [
        {
          type: 'required_status_checks',
          parameters: {required_status_checks: []}
        }
      ]
    })
    const fileSync = createFileSync({request})

    await expect(
      fileSync.hasRequiredStatusChecks(repo, 'master')
    ).resolves.toBe(false)
  })

  it('is true and warns when branch protection cannot be read', async () => {
    const request = createRequestFake({
      protection: httpError(403, 'Resource not accessible by integration'),
      rules: []
    })
    const fileSync = createFileSync({request})

    await expect(
      fileSync.hasRequiredStatusChecks(repo, 'master')
    ).resolves.toBe(true)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0][0]).toContain('target-owner/target-repo')
    expect(warning.mock.calls[0][0]).toContain(
      'Resource not accessible by integration'
    )
  })

  it('is true and warns when rulesets cannot be read', async () => {
    const request = createRequestFake({
      protection: httpError(404, 'Branch not protected'),
      rules: httpError(502, 'Bad Gateway')
    })
    const fileSync = createFileSync({request})

    await expect(
      fileSync.hasRequiredStatusChecks(repo, 'master')
    ).resolves.toBe(true)
    expect(warning).toHaveBeenCalledTimes(1)
    expect(warning.mock.calls[0][0]).toContain('target-owner/target-repo')
    expect(warning.mock.calls[0][0]).toContain('Bad Gateway')
  })
})

describe('filesToChanges', () => {
  const files: File[] = [
    {src: 'workflows/ci.yml', dest: '.github/workflows/ci.yml', content: 'Y2k='}
  ]

  it('adds [skip ci] to the commit message when CI is skipped', () => {
    expect(filesToChanges(files, true).commit).toBe('🔃 File Sync [skip ci]')
  })

  it('keeps the plain commit message when CI runs', () => {
    const changes = filesToChanges(files, false)
    expect(changes.commit).toBe('🔃 File Sync')
    expect(changes.commit).not.toContain('[skip ci]')
    expect(changes.emptyCommit).toBe(false)
  })
})

describe('run', () => {
  let info: jest.SpyInstance

  beforeEach(() => {
    info = jest.spyOn(Log.prototype, 'info').mockImplementation()
  })

  afterEach(() => {
    info.mockRestore()
  })

  function createRunOctokit(
    request: jest.Mock,
    config: unknown = {
      syncs: [
        {
          repos: ['target-owner/target-repo'],
          files: [{src: 'workflows/ci.yml', dest: '.github/ci.yml'}]
        }
      ]
    }
  ): {
    octokit: Record<string, unknown>
    createPullRequest: jest.Mock
    configGet: jest.Mock
    getContent: jest.Mock
  } {
    const createPullRequest = jest.fn().mockResolvedValue(null)
    const configGet = jest.fn().mockResolvedValue({config})
    const getContent = jest.fn().mockResolvedValue({data: {content: 'Y2k='}})
    const octokit = {
      config: {
        get: configGet
      },
      repos: {
        getContent,
        get: jest
          .fn()
          .mockResolvedValue({data: {archived: false, default_branch: 'main'}})
      },
      request,
      createPullRequest
    }
    return {octokit, createPullRequest, configGet, getContent}
  }

  it('commits with [skip ci] into the default branch when it has no required checks', async () => {
    const request = createRequestFake({
      protection: httpError(404, 'Branch not protected'),
      rules: []
    })
    const {octokit, createPullRequest} = createRunOctokit(request)

    await createFileSync(octokit).run()

    expect(createPullRequest).toHaveBeenCalledTimes(1)
    const options = createPullRequest.mock.calls[0][0]
    expect(options.base).toBe('main')
    expect(options.changes[0].commit).toBe('🔃 File Sync [skip ci]')
    expect(options.body).toContain('CI is skipped for this PR')
    expect(info).toHaveBeenCalledWith(
      '⏭️ CI will be skipped for target-owner/target-repo (no required status checks on main)'
    )
  })

  it('keeps CI when the default branch requires status checks', async () => {
    const request = createRequestFake({
      protection: {contexts: ['build'], checks: []},
      rules: []
    })
    const {octokit, createPullRequest} = createRunOctokit(request)

    await createFileSync(octokit).run()

    const options = createPullRequest.mock.calls[0][0]
    expect(options.base).toBe('main')
    expect(options.changes[0].commit).toBe('🔃 File Sync')
    expect(options.body).toContain(
      'CI runs for this PR because `main` requires status checks to pass.'
    )
    expect(info).toHaveBeenCalledWith(
      '🧪 CI will run for target-owner/target-repo (required status checks on main)'
    )
  })

  it('checks and logs the CI decision but creates nothing in dry run', async () => {
    const request = createRequestFake({
      protection: httpError(404, 'Branch not protected'),
      rules: []
    })
    const {octokit, createPullRequest} = createRunOctokit(request)

    await createFileSync(octokit, true).run()

    expect(request).toHaveBeenCalledTimes(2)
    expect(createPullRequest).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(
      '⏭️ CI will be skipped for target-owner/target-repo (no required status checks on main)'
    )
  })

  it('reads the config and the synced files at the triggering commit', async () => {
    const request = createRequestFake({
      protection: httpError(404, 'Branch not protected'),
      rules: []
    })
    const {octokit, configGet, getContent} = createRunOctokit(request)

    await createFileSync(octokit).run()

    expect(configGet).toHaveBeenCalledWith({
      owner: 'source-owner',
      repo: 'source-repo',
      path: '.github/syncs.yml',
      branch: SOURCE_SHA
    })
    expect(getContent).toHaveBeenCalledWith({
      owner: 'source-owner',
      repo: 'source-repo',
      path: 'workflows/ci.yml',
      ref: SOURCE_SHA
    })
  })

  it('returns cleanly with a warning when the config has no syncs', async () => {
    const warning = jest.spyOn(Log.prototype, 'warning').mockImplementation()
    const request = createRequestFake({protection: {}, rules: []})
    const {octokit, createPullRequest, getContent} = createRunOctokit(
      request,
      {}
    )

    try {
      await expect(createFileSync(octokit).run()).resolves.toBeUndefined()
      expect(warning).toHaveBeenCalledWith('😰 Nothing to sync')
      expect(getContent).not.toHaveBeenCalled()
      expect(request).not.toHaveBeenCalled()
      expect(createPullRequest).not.toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })

  it('leaves the commit, the body and branch protection alone when skipCi is off', async () => {
    const request = createRequestFake({
      protection: httpError(404, 'Branch not protected'),
      rules: []
    })
    const {octokit, createPullRequest} = createRunOctokit(request)

    await createFileSync(octokit, false, false).run()

    expect(request).not.toHaveBeenCalled()
    expect(createPullRequest).toHaveBeenCalledTimes(1)
    const options = createPullRequest.mock.calls[0][0]
    expect(options.changes[0].commit).toBe('🔃 File Sync')
    expect(options.body).toBe(
      '🔃 Synced files from [source-owner/source-repo](https://github.com/source-owner/source-repo)\n\nThis PR was created automatically by the [ghaction.file.sync](https://github.com/jetersen/ghaction.file.sync) workflow run [#12345](https://github.com/source-owner/source-repo/actions/runs/12345)'
    )
    expect(info).toHaveBeenCalledWith(
      '🧪 skipCi is off: sync commits run CI in every target repository'
    )
  })
})
