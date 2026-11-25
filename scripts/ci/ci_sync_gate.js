/**
 * CI Workflow Completion Sync Module
 *
 * Triggered via `workflow_run` when "Monorepo CI" finishes (whether first-run,
 * post-approval for first-time contributors, or manual job re-run).
 * Updates the SINGLE sticky PR gate comment and status labels with the combined
 * Security + Compliance + CI result.
 */

const {
  isTrustedPR,
  findStickyComment,
  decodeGateMeta,
  upsertGateComment,
  syncGateLabels,
  inspectCIForSha,
  renderUnifiedGateComment,
} = require('./upsert_gate_comment');

/**
 * Resolves open PR(s) matching the workflow run's head SHA (supports both same-repo and fork PRs).
 */
async function resolveOpenPRsForRun({ github, owner, repo, run }) {
  const prsByNumber = new Map();

  for (const stub of run.pull_requests || []) {
    try {
      const res = await github.rest.pulls.get({
        owner,
        repo,
        pull_number: stub.number,
      });
      if (res.data && res.data.state === 'open') {
        prsByNumber.set(res.data.number, res.data);
      }
    } catch {
      // Ignore inaccessible PRs
    }
  }

  if (prsByNumber.size === 0) {
    const listRes = await github.rest.pulls.list({
      owner,
      repo,
      state: 'open',
      per_page: 50,
    });
    for (const pr of listRes.data || []) {
      if (pr.head?.sha === run.head_sha) {
        prsByNumber.set(pr.number, pr);
      }
    }
  }

  return Array.from(prsByNumber.values()).filter(pr => pr.head?.sha === run.head_sha);
}

/**
 * Checks whether the PR Security Gate workflow on headSha has already finished or is still running.
 */
async function inspectSecurityGateRun({ github, owner, repo, headSha }) {
  const runsRes = await github.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: headSha,
    per_page: 30,
  });

  const gateRuns = (runsRes.data.workflow_runs || [])
    .filter(r => (r.name || '').includes('PR Security Gate') || r.event === 'pull_request_target')
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  if (gateRuns.length === 0) {
    return { status: 'not_found', issueCompliant: false, scanClean: false };
  }

  const latest = gateRuns[0];
  if (latest.status !== 'completed') {
    return { status: 'running', issueCompliant: false, scanClean: false };
  }

  try {
    const jobsRes = await github.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: latest.id,
      per_page: 20,
    });
    const jobs = jobsRes.data.jobs || [];
    const compJob = jobs.find(j => (j.name || '').includes('Issue Compliance'));
    const scanJob = jobs.find(j => (j.name || '').includes('Malicious Code Scanner'));
    const issueCompliant = compJob ? compJob.conclusion === 'success' : latest.conclusion === 'success';
    const scanClean = scanJob ? scanJob.conclusion === 'success' : latest.conclusion === 'success';
    return { status: 'completed', issueCompliant, scanClean };
  } catch {
    const ok = latest.conclusion === 'success';
    return { status: 'completed', issueCompliant: ok, scanClean: ok };
  }
}

module.exports = async ({ github, context, core }) => {
  const run = context.payload.workflow_run;
  if (!run) {
    console.log('No workflow_run payload present; skipping.');
    return;
  }

  if (run.event !== 'pull_request') {
    console.log(`Skipping ${run.name} run #${run.id} (event=${run.event}, not pull_request).`);
    return;
  }

  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const headSha = run.head_sha;

  const matchingPRs = await resolveOpenPRsForRun({ github, owner, repo, run });
  if (matchingPRs.length === 0) {
    console.log(`No open PR currently points to head SHA ${headSha}; skipping comment sync.`);
    return;
  }

  const ciResult = await inspectCIForSha({ github, owner, repo, headSha });
  const timestamp = new Date().toISOString();

  for (const pr of matchingPRs) {
    const prNumber = pr.number;
    const prAuthor = pr.user.login;
    const { isTrusted, isDependabot, isReleaseSync } = isTrustedPR({ pr, repoOwner: owner });
    const trustedRole = isTrusted
      ? isDependabot
        ? 'Dependabot'
        : isReleaseSync
        ? 'Release Sync'
        : 'Maintainer'
      : '';

    const existing = await findStickyComment({ github, owner, repo, prNumber });
    const meta = decodeGateMeta(existing?.body);
    const hasFreshMeta = meta && meta.sha === headSha;

    let gateState = { status: 'completed', issueCompliant: true, scanClean: true };
    if (!hasFreshMeta && !isTrusted) {
      gateState = await inspectSecurityGateRun({ github, owner, repo, headSha });
    }

    const securityGatePending = !isTrusted && !hasFreshMeta && gateState.status !== 'completed';
    const issueCompliant = isTrusted
      ? true
      : hasFreshMeta
      ? Boolean(meta.issueCompliant)
      : gateState.issueCompliant;
    const scanClean = isTrusted
      ? true
      : hasFreshMeta
      ? Boolean(meta.scanClean)
      : gateState.scanClean;

    const issueReason = hasFreshMeta
      ? meta.issueReason || ''
      : issueCompliant
      ? ''
      : 'Issue compliance or scope check did not pass on this commit. See the PR Security Gate workflow log for details.';
    const scanReport = hasFreshMeta
      ? meta.scanReport || ''
      : scanClean
      ? ''
      : 'Security scan did not pass on this commit. See the PR Security Gate workflow log for details.';

    const body = renderUnifiedGateComment({
      prNumber,
      prAuthor,
      headSha,
      owner,
      repo,
      issueCompliant,
      scanClean,
      issueReason,
      scanReport,
      linkedIssue: hasFreshMeta ? meta.linkedIssue : trustedRole ? trustedRole.toLowerCase().replace(/\s+/g, '-') : '',
      issueTitle: hasFreshMeta ? meta.issueTitle : '',
      scopeReport: hasFreshMeta ? meta.scopeReport : '',
      trustedRole: trustedRole || (hasFreshMeta ? meta.trustedRole : ''),
      ciResult,
      securityGatePending,
      timestamp,
    });

    const upsertRes = await upsertGateComment({ github, context, prNumber, body });
    console.log(
      `Sticky PR gate comment ${upsertRes.action} on PR #${prNumber} from CI sync (CI state=${ciResult.state}).`
    );

    if (securityGatePending) {
      console.log(`PR Security Gate still running for PR #${prNumber}; deferring final label update.`);
      continue;
    }

    let targetLabel = 'ci-pending';
    if (!scanClean) {
      targetLabel = 'needs-security-fix';
    } else if (!issueCompliant) {
      targetLabel = 'needs-compliance';
    } else if (ciResult.state === 'failed') {
      targetLabel = 'needs-ci-fix';
    } else if (ciResult.state === 'passed') {
      targetLabel = 'security-passed';
    }

    await syncGateLabels({ github, context, prNumber, targetLabel });
  }
};
