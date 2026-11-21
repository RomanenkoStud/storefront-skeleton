import test from 'node:test';
import assert from 'node:assert/strict';
import { latestStagingDeploy, containedIn, promotedPullRequest, requireOnStaging, requirePromotion } from '../../tools/staging-verified.mjs';

// Tiny commit graph: base <- a <- b (staging tip); c is a branch head never merged to staging.
const ancestors = { b: ['b', 'a', 'base'], a: ['a', 'base'], c: ['c', 'base'], base: ['base'] };
const run = (sha, extra = {}) => ({ head_sha: sha, head_branch: 'staging', status: 'completed', conclusion: 'success', event: 'push', created_at: '2026-11-16T10:00:00Z', html_url: `run-${sha}`, ...extra });

function fakeGithub({ runs = [], pulls = [] } = {}) {
  const calls = [];
  return {
    calls,
    rest: {
      actions: { listWorkflowRuns: async args => { calls.push(['runs', args]); return { data: { workflow_runs: runs } }; } },
      repos: {
        compareCommits: async ({ base, head }) => {
          calls.push(['compare', base, head]);
          if (!ancestors[head] || !ancestors[base]) { const e = new Error('nope'); e.status = 404; throw e; }
          if (base === head) return { data: { status: 'identical' } };
          return { data: { status: ancestors[head].includes(base) ? 'ahead' : 'diverged' } };
        },
        listPullRequestsAssociatedWithCommit: async () => ({ data: pulls })
      }
    }
  };
}
const repoArgs = { owner: 'o', repo: 'r' };

test('latest staging deploy is the newest successful staging-branch push or dispatch', async () => {
  const github = fakeGithub({ runs: [
    run('a', { created_at: '2026-11-16T09:00:00Z' }),
    run('x', { created_at: '2026-11-16T12:00:00Z', head_branch: 'main' }),
    run('y', { created_at: '2026-11-16T12:00:00Z', conclusion: 'failure' }),
    run('z', { created_at: '2026-11-16T12:00:00Z', event: 'pull_request' }),
    run('b', { created_at: '2026-11-16T11:00:00Z', event: 'workflow_dispatch' })
  ] });
  assert.equal((await latestStagingDeploy({ github, ...repoArgs })).head_sha, 'b');
  assert.deepEqual(github.calls[0][1], { owner: 'o', repo: 'r', workflow_id: 'staging.yml', branch: 'staging', status: 'success', per_page: 20 });
  assert.equal(await latestStagingDeploy({ github: fakeGithub(), ...repoArgs }), null);
});

test('containment accepts the deployed commit and its ancestors only', async () => {
  const github = fakeGithub();
  assert.equal(await containedIn({ github, ...repoArgs, sha: 'b', deployedSha: 'b' }), true);
  assert.equal(await containedIn({ github, ...repoArgs, sha: 'a', deployedSha: 'b' }), true);
  assert.equal(await containedIn({ github, ...repoArgs, sha: 'c', deployedSha: 'b' }), false);
  assert.equal(await containedIn({ github, ...repoArgs, sha: 'missing', deployedSha: 'b' }), false);
});

test('requireOnStaging explains how to fix an untested head', async () => {
  await assert.rejects(requireOnStaging({ github: fakeGithub(), ...repoArgs, sha: 'a', label: 'PR #1' }), /No successful staging deploy/);
  const github = fakeGithub({ runs: [run('b')] });
  assert.equal((await requireOnStaging({ github, ...repoArgs, sha: 'a', label: 'PR #1' })).head_sha, 'b');
  await assert.rejects(requireOnStaging({ github, ...repoArgs, sha: 'c', label: 'PR #2 (task/x)' }), /PR #2 \(task\/x\) head c is not on staging[\s\S]*Merge this exact branch head into `staging`/);
});

test('production gate requires main to be the merge commit of a PR whose head is on staging', async () => {
  const pull = (n, head, merge, base = 'main', merged = '2026-11-16') => ({ number: n, head: { sha: head, ref: `task/${n}` }, base: { ref: base }, merge_commit_sha: merge, merged_at: merged });
  const runs = [run('b')];
  const ok = fakeGithub({ runs, pulls: [pull(5, 'a', 'm1', 'staging'), pull(6, 'a', 'm1')] });
  assert.deepEqual(await promotedPullRequest({ github: ok, ...repoArgs, mainSha: 'm1' }), { number: 6, sha: 'a', branch: 'task/6' });
  assert.equal((await requirePromotion({ github: ok, ...repoArgs, mainSha: 'm1' })).pull.number, 6);
  await assert.rejects(requirePromotion({ github: fakeGithub({ runs, pulls: [pull(7, 'c', 'm2')] }), ...repoArgs, mainSha: 'm2' }), /PR #7 \(task\/7\) head c is not on staging/);
  await assert.rejects(requirePromotion({ github: fakeGithub({ runs, pulls: [] }), ...repoArgs, mainSha: 'm3' }), /not the merge commit of a pull request/);
  await assert.rejects(requirePromotion({ github: fakeGithub({ runs, pulls: [pull(8, 'a', 'other')] }), ...repoArgs, mainSha: 'm4' }), /not the merge commit/);
  await assert.rejects(requirePromotion({ github: fakeGithub({ runs, pulls: [pull(9, 'a', 'm5', 'main', null)] }), ...repoArgs, mainSha: 'm5' }), /not the merge commit/);
});
