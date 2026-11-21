// Staging-first release gate, shared by ci.yml (PR check and production deploy).
// A feature reaches production only if its exact task-branch head is already
// contained in the commit that the most recent successful staging deploy shipped.
// The `staging` branch only grows through merge commits (no force-push, no squash),
// so containment in the newest successful deploy is containment in what is on staging.

export const STAGING_WORKFLOW = 'staging.yml';
export const STAGING_BRANCH = 'staging';

/** Newest successful staging.yml run that deployed the `staging` branch, or null. */
export async function latestStagingDeploy({ github, owner, repo }) {
  const { data } = await github.rest.actions.listWorkflowRuns({
    owner, repo, workflow_id: STAGING_WORKFLOW, branch: STAGING_BRANCH, status: 'success', per_page: 20
  });
  const runs = data.workflow_runs
    .filter(run => run.head_branch === STAGING_BRANCH && run.status === 'completed' && run.conclusion === 'success' &&
      (run.event === 'push' || run.event === 'workflow_dispatch'))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  return runs[0] ?? null;
}

/** True when `sha` is the staging deploy commit or one of its ancestors. */
export async function containedIn({ github, owner, repo, sha, deployedSha }) {
  if (sha === deployedSha) return true;
  try {
    const { data } = await github.rest.repos.compareCommits({ owner, repo, base: sha, head: deployedSha });
    return data.status === 'identical' || data.status === 'ahead';
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/** The merged PR into main whose merge commit is `mainSha`, as {number, sha, branch}, or null. */
export async function promotedPullRequest({ github, owner, repo, mainSha }) {
  const { data } = await github.rest.repos.listPullRequestsAssociatedWithCommit({ owner, repo, commit_sha: mainSha });
  const pull = data.find(item => item.merged_at && item.base?.ref === 'main' && item.merge_commit_sha === mainSha);
  return pull ? { number: pull.number, sha: pull.head.sha, branch: pull.head.ref } : null;
}

/** Throws with an actionable message unless `sha` (from `label`) is live on staging. */
export async function requireOnStaging({ github, owner, repo, sha, label }) {
  const run = await latestStagingDeploy({ github, owner, repo });
  if (!run) throw new Error(`No successful staging deploy exists. Merge ${label} into \`staging\`, test it there, then promote.`);
  if (!(await containedIn({ github, owner, repo, sha, deployedSha: run.head_sha }))) {
    throw new Error(`${label} head ${sha} is not on staging (last successful staging deploy: ${run.head_sha}, run ${run.html_url}). ` +
      'Merge this exact branch head into `staging`, let it deploy and test it, then promote the same head to `main`.');
  }
  return run;
}

/** Production gate: the commit on main must be the merge of a PR whose head is live on staging. */
export async function requirePromotion({ github, owner, repo, mainSha }) {
  const pull = await promotedPullRequest({ github, owner, repo, mainSha });
  if (!pull) throw new Error(`Main commit ${mainSha} is not the merge commit of a pull request. Production only ships features promoted from staging through a PR.`);
  const run = await requireOnStaging({ github, owner, repo, sha: pull.sha, label: `PR #${pull.number} (${pull.branch})` });
  return { pull, run };
}
