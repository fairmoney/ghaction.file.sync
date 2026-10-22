import {Context} from '@actions/github/lib/context'
import {GitHub} from '@actions/github/lib/utils'
import {createPullRequest} from 'octokit-plugin-create-pull-request'
import {Log} from './log'
import {Inputs, Config, Repo, File} from './types'
import {dump} from 'js-yaml'
import {errorStatus, toErrorMessage} from './util'

interface RepositoryInfo {
  archived: boolean
  defaultBranch: string | undefined
}

interface RequiredStatusChecks {
  contexts?: string[]
  checks?: unknown[]
}

interface BranchRule {
  type: string
  parameters?: {required_status_checks?: unknown[]}
}

export class FileSync {
  private readonly configFile
  private readonly repo
  private readonly dryRun
  private readonly skipCi
  private readonly sha
  private readonly gitSha
  private readonly htmlUrl
  private readonly octokit
  private readonly log
  private readonly runId
  private readonly repoStr

  constructor(
    inputs: Inputs,
    context: Context,
    octokit: InstanceType<typeof GitHub>,
    log: Log
  ) {
    this.log = log
    this.octokit = octokit
    this.configFile = inputs.configFile
    this.dryRun = inputs.dryRun
    this.skipCi = inputs.skipCi
    this.repo = context.repo
    this.sha = context.sha
    this.gitSha = context.sha.substring(0, 12)
    this.runId = context.runId
    this.repoStr = toRepoStr(this.repo)
    this.htmlUrl =
      context.payload.repository?.html_url ||
      `https://github.com/${this.repo.owner}/${this.repo.repo}`
  }

  /**
   * name
   */
  async loadConfigFile(): Promise<Config> {
    this.log.startGroup(
      `📝 Fetching '${this.configFile}' from ${this.repo.owner}/${this.repo.repo}`
    )
    const {config}: {config: Config} = await this.octokit.config.get({
      ...this.repo,
      path: this.configFile,
      // The triggering commit, so a pull_request run tests the PR's config
      branch: this.sha
    })
    this.log.info(`🛠 config:\n${dump(config)}`)
    if (!config.syncs?.length) {
      this.log.warning('😰 Nothing to sync')
    }
    this.log.endGroup()
    return config
  }

  toRepo(str: string): Repo {
    const input = str.split('/', 2)
    const owner = input.length === 2 ? input[0] : this.repo.owner
    const repo = input.length === 2 ? input[1] : input[0]
    return {
      owner,
      repo
    }
  }

  async getRepositoryInfo(repo: Repo): Promise<RepositoryInfo> {
    try {
      const {data} = await this.octokit.repos.get({
        owner: repo.owner,
        repo: repo.repo
      })
      return {archived: data.archived, defaultBranch: data.default_branch}
    } catch (error) {
      this.log.warning(
        `⚠️ Failed to fetch repository info for ${toRepoStr(
          repo
        )}: ${toErrorMessage(error)}`
      )
      return {archived: false, defaultBranch: undefined}
    }
  }

  /**
   * Whether a PR into `branch` needs status checks to pass, from classic
   * branch protection or from a ruleset. A PR with `[skip ci]` into such a
   * branch would wait for the checks forever, so when unsure this answers
   * true and CI runs.
   */
  async hasRequiredStatusChecks(repo: Repo, branch: string): Promise<boolean> {
    try {
      const {data} = await this.octokit.request(
        'GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks',
        {...repo, branch}
      )
      const checks = data as RequiredStatusChecks
      if (checks.contexts?.length || checks.checks?.length) {
        return true
      }
    } catch (error) {
      // 404: the branch is not protected or protection requires no checks
      if (errorStatus(error) !== 404) {
        this.log.warning(
          `⚠️ Failed to read branch protection of ${branch} in ${toRepoStr(
            repo
          )}, assuming status checks are required: ${toErrorMessage(error)}`
        )
        return true
      }
    }

    try {
      const {data} = await this.octokit.request(
        'GET /repos/{owner}/{repo}/rules/branches/{branch}',
        {...repo, branch, per_page: 100}
      )
      const rules = data as BranchRule[]
      return rules.some(
        rule =>
          rule.type === 'required_status_checks' &&
          !!rule.parameters?.required_status_checks?.length
      )
    } catch (error) {
      this.log.warning(
        `⚠️ Failed to read rulesets of ${branch} in ${toRepoStr(
          repo
        )}, assuming status checks are required: ${toErrorMessage(error)}`
      )
      return true
    }
  }

  async closeExistingPRs(
    remoteRepo: Repo,
    newPrNumber: number,
    branchPrefix: string
  ): Promise<void> {
    if (this.dryRun) {
      this.log.info(
        `✔ Skipping cleanup of existing PRs for ${toRepoStr(
          remoteRepo
        )} due to dry run`
      )
      return
    }

    // Paginate: a repo with more open PRs than a single page holds would
    // otherwise leave the overflow open forever.
    const openPRs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      ...remoteRepo,
      state: 'open',
      per_page: 100
    })

    const stalePRs = openPRs.filter(
      (pr: {head: {ref: string}; number: number}) =>
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
          `⚠️ Failed to close PR #${pr.number} in ${toRepoStr(
            remoteRepo
          )}: ${toErrorMessage(error)}`
        )
      }
    }
  }

  async run(): Promise<void> {
    this.log.info('🏃 Running GitHub File Sync')
    this.log.info(
      this.skipCi
        ? '⏭️ skipCi is on: [skip ci] is added unless the target branch requires status checks'
        : '🧪 skipCi is off: sync commits run CI in every target repository'
    )
    const config = await this.loadConfigFile()
    if (!config.syncs?.length) {
      return
    }
    for (let syncIndex = 0; syncIndex < config.syncs.length; syncIndex++) {
      const sync = config.syncs[syncIndex]
      this.log.startGroup(`📝 Fetching files from ${this.repoStr}`)
      for (const file of sync.files) {
        this.log.info(`📝 Fetching ${file.src}`)
        try {
          const {data} = await this.octokit.repos.getContent({
            ...this.repo,
            path: file.src,
            ref: this.sha
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
      this.log.endGroup()
      for (const remoteRepoStr of sync.repos) {
        const remoteRepo = this.toRepo(remoteRepoStr)

        const {archived, defaultBranch} =
          await this.getRepositoryInfo(remoteRepo)
        if (archived) {
          this.log.info(
            `⏭️ Skipping ${toRepoStr(remoteRepo)} as it is archived`
          )
          continue
        }

        let skipCi = false
        if (this.skipCi) {
          if (defaultBranch) {
            skipCi = !(await this.hasRequiredStatusChecks(
              remoteRepo,
              defaultBranch
            ))
            this.log.info(
              skipCi
                ? `⏭️ CI will be skipped for ${toRepoStr(
                    remoteRepo
                  )} (no required status checks on ${defaultBranch})`
                : `🧪 CI will run for ${toRepoStr(
                    remoteRepo
                  )} (required status checks on ${defaultBranch})`
            )
          } else {
            this.log.info(
              `🧪 CI will run for ${toRepoStr(
                remoteRepo
              )} (default branch unknown)`
            )
          }
        }

        this.log.info(`💄 Creating pull request for ${toRepoStr(remoteRepo)}`)
        const body = `🔃 Synced files from [${this.repoStr}](${this.htmlUrl})\n\nThis PR was created automatically by the [ghaction.file.sync](https://github.com/jetersen/ghaction.file.sync) workflow run [#${this.runId}](${this.htmlUrl}/actions/runs/${this.runId})`
        const prOptions: createPullRequest.Options = {
          ...remoteRepo,
          title: `🔃 Synced files from ${this.repoStr}`,
          body: this.skipCi
            ? `${body}\n\n${ciNote(skipCi, defaultBranch)}`
            : body,
          head: `${toRepoStr(this.repo, '-')}-${this.gitSha}-${syncIndex}`,
          base: defaultBranch,
          createWhenEmpty: false,
          changes: [filesToChanges(sync.files, skipCi)]
        }
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
      }
    }
  }
}

function toRepoStr(repo: Repo, separator = '/'): string {
  return `${repo.owner}${separator}${repo.repo}`
}

export function ciNote(skipCi: boolean, branch: string | undefined): string {
  if (skipCi) {
    return `CI is skipped for this PR (\`[skip ci]\` in the commit) because \`${branch}\` has no required status checks. Merge it when convenient. To run CI first, push an empty commit to this branch (or press **Update branch** if GitHub offers it). On merge the \`[skip ci]\` marker is kept, so the merge workflows on \`${branch}\` are skipped as well. Edit the squash commit title to drop \`[skip ci]\` if you need them to run.`
  }
  if (!branch) {
    return 'CI runs for this PR because its base branch could not be checked for required status checks.'
  }
  return `CI runs for this PR because \`${branch}\` requires status checks to pass.`
}

export function filesToChanges(
  files: File[],
  skipCi: boolean
): createPullRequest.Changes {
  const result = files.reduce(
    (obj: {[path: string]: createPullRequest.File}, file) => {
      const dest = file.dest ? file.dest : file.src
      if (file.content) {
        obj[dest] = {
          content: file.content,
          encoding: 'base64'
        }
      }
      return obj
    },
    {}
  )
  return {
    emptyCommit: false,
    commit: skipCi ? '🔃 File Sync [skip ci]' : '🔃 File Sync',
    files: result
  }
}
