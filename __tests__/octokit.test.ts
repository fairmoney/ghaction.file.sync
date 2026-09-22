import {Log} from '../src/log'

// src/context.ts reads its inputs at import time, so each case needs a fresh
// module registry with the env already in place.
async function loadGetOctokit(
  env: Record<string, string>
): Promise<(log: Log) => Promise<unknown>> {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_')) delete process.env[key]
  }
  Object.assign(process.env, env)
  jest.resetModules()
  const {getOctokit} = await import('../src/octokit')
  return getOctokit as (log: Log) => Promise<unknown>
}

describe('getOctokit', () => {
  it('preserves the original error as `cause` when auth fails', async () => {
    const getOctokit = await loadGetOctokit({})

    let error: unknown
    try {
      await getOctokit(new Log(false))
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(Error)
    const thrown = error as Error
    expect(thrown.message).toContain('🔒 Failed to authenticate')

    // Without `cause`, the underlying failure is flattened to a string and the
    // original stack is lost.
    expect(thrown.cause).toBeInstanceOf(Error)
    expect((thrown.cause as Error).message).toContain('No credentials provided')
    expect((thrown.cause as Error).stack).toBeDefined()
  })
})
