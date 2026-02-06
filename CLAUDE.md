# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A GitHub Action (`jetersen/ghaction.file.sync`) that syncs files from a central repository to other repositories by creating pull requests. It reads a YAML config (`.github/syncs.yml`) listing target repos and files to sync, fetches file contents from the source repo via the GitHub API, then creates PRs in each target repo using the `octokit-plugin-create-pull-request` plugin. Archived repositories are automatically skipped.

## Commands

```bash
yarn install --frozen-lockfile  # Install dependencies
yarn build                      # TypeScript compile (tsc) → lib/
yarn lint                       # ESLint
yarn format-check               # Prettier check
yarn format                     # Prettier fix
yarn test                       # Jest tests
yarn package                    # Bundle with @vercel/ncc → dist/index.js
yarn all                        # Build + format + lint + package + test (CI runs this)
```

The action entry point is `dist/index.js` (bundled). After code changes, run `yarn package` to rebuild it — this file is committed to the repo.

## Architecture

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

**Flow:** `main` → `getOctokit()` (authenticate) → `FileSync.run()` → `loadConfigFile()` (fetch syncs.yml) → for each sync group: fetch source files → for each target repo: skip if archived, then `octokit.createPullRequest()`.

## Code Style

- **No semicolons** — enforced by both Prettier and ESLint (`semi: false` / `@typescript-eslint/semi: ["error", "never"]`)
- Single quotes, no bracket spacing, no trailing commas, 2-space indent
- Explicit return types required on functions (`@typescript-eslint/explicit-function-return-type`)
- No `any` (`@typescript-eslint/no-explicit-any: "error"`)
- No `require()` imports (`@typescript-eslint/no-require-imports: "error"`)
- Member accessibility must omit `public` keyword (`@typescript-eslint/explicit-member-accessibility: "no-public"`)

## Auth Modes

The action supports two auth strategies (configured via action inputs):
1. **GitHub App** (`appId` + `privateKey`) — recommended; `privateKey` can be base64-encoded
2. **GitHub Token** (`githubToken`) — simpler but broader permissions
