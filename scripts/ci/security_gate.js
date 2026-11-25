/**
 * PR Security Gate Decision & Enforcement Module
 * Validates PR against compliance and security requirements, inspects current CI status,
 * and updates ONE single sticky PR status comment (never creates duplicate bot comments).
 */

const {
  isTrustedPR,
  upsertGateComment,
  syncGateLabels,
  inspectCIForSha,
  renderUnifiedGateComment,
} = require('./upsert_gate_comment');

module.exports = async ({ github, context, core }) => {
  const pr = context.payload.pull_request;
  const prNumber = pr.number;
  const prAuthor = pr.user.login;
  const headSha = pr.head?.sha || '';
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  const issueCompliant = process.env.ISSUE_COMPLIANT === 'true';
  const scanClean = process.env.SCAN_CLEAN === 'true';
  const issueReason = process.env.ISSUE_REASON || '';
  const rawScanReport = process.env.SCAN_REPORT || '';
  const scanReport =
    rawScanReport.trim() !== ''
      ? rawScanReport
      : '🚨 Security scan flagged an unverified anomaly or secret leak.';
  const linkedIssue = process.env.LINKED_ISSUE || '';
  const issueTitle = process.env.ISSUE_TITLE || '';
  const scopeReport = process.env.SCOPE_REPORT || '';
  const timestamp = new Date().toISOString();

  const { isTrusted, isDependabot, isReleaseSync } = isTrustedPR({
    pr,
    repoOwner: owner,
  });
  const trustedRole = isTrusted
    ? isDependabot
      ? 'Dependabot'
      : isReleaseSync
      ? 'Release Sync'
      : 'Maintainer'
    : '';

  const ciResult = await inspectCIForSha({ github, owner, repo, headSha });

  const effectiveIssueCompliant = isTrusted ? true : issueCompliant;
  const effectiveScanClean = isTrusted ? true : scanClean;
  const effectiveScopeReport = isTrusted
    ? `Verified official ${trustedRole} pull request.`
    : scopeReport;
  const effectiveLinkedIssue = isTrusted
    ? linkedIssue || trustedRole.toLowerCase().replace(/\s+/g, '-')
    : linkedIssue;

  const body = renderUnifiedGateComment({
    prNumber,
    prAuthor,
    headSha,
    owner,
    repo,
    issueCompliant: effectiveIssueCompliant,
    scanClean: effectiveScanClean,
    issueReason,
    scanReport,
    linkedIssue: effectiveLinkedIssue,
    issueTitle,
    scopeReport: effectiveScopeReport,
    trustedRole,
    ciResult,
    securityGatePending: false,
    timestamp,
  });

  try {
    const res = await upsertGateComment({ github, context, prNumber, body });
    console.log(`Sticky PR gate comment ${res.action} on PR #${prNumber} (id=${res.commentId}).`);
  } catch (commentErr) {
    console.error(`⚠️ Could not upsert sticky comment on PR #${prNumber}: ${commentErr.message}`);
  }

  let targetLabel = 'ci-pending';
  if (!effectiveScanClean) {
    targetLabel = 'needs-security-fix';
  } else if (!effectiveIssueCompliant) {
    targetLabel = 'needs-compliance';
  } else if (ciResult.state === 'failed') {
    targetLabel = 'needs-ci-fix';
  } else if (ciResult.state === 'passed') {
    targetLabel = 'security-passed';
  } else if (isTrusted) {
    // Do not block Dependabot/Maintainer PRs while CI is running; sync will confirm pass/fail.
    targetLabel = 'ci-pending';
  }

  await syncGateLabels({ github, context, prNumber, targetLabel });

  if (!effectiveScanClean) {
    core.setFailed(`PR #${prNumber} requires security remediation before merge. See sticky PR comment.`);
    return;
  }

  if (!effectiveIssueCompliant) {
    core.setFailed(`PR #${prNumber} requires compliance updates before merge. See sticky PR comment.`);
    return;
  }

  if (ciResult.state === 'failed' && !isTrusted) {
    core.setFailed(
      `PR #${prNumber} passed security & compliance checks, but CI failed (${ciResult.failedJobs.map(j => j.name).join(', ')}).`
    );
    return;
  }

  console.log(
    `✅ Security & compliance checks passed for PR #${prNumber}. Current CI state: ${ciResult.state}.`
  );
};
