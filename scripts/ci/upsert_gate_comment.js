/**
 * Shared Sticky PR Gate Comment, CI Inspection, and Unified Dashboard Renderer.
 *
 * Ensures every PR has at most ONE bot status comment (updated in-place via a
 * hidden HTML marker) combining:
 *   1. Issue Compliance & Scope Check
 *   2. Malware & Secret Scan
 *   3. All Monorepo CI workflow jobs with targeted "Where & How to Fix" advice
 */

const MARKER = '<!-- soroban-gate-status-bot -->';
const META_PREFIX = '<!-- soroban-gate-meta:';
const META_SUFFIX = ' -->';

const GATE_LABELS = [
  'security-passed',
  'needs-compliance',
  'needs-security-fix',
  'security-rejected',
  'needs-ci-fix',
  'ci-pending',
];

const CI_JOBS = [
  { key: 'contracts-checks', pattern: /contract/i, exclude: /client|sdk/i, label: 'Smart Contracts CI (contracts/)' },
  { key: 'contract-client-checks', pattern: /sdk|contract client/i, exclude: null, label: 'Contract Client SDK CI (packages/contract-client/)' },
  { key: 'web-frontend-checks', pattern: /web|frontend/i, exclude: null, label: 'Web Frontend CI (apps/web/)' },
  { key: 'go-relay-checks', pattern: /relay|go/i, exclude: null, label: 'Go Relay Service CI (services/relay/)' },
];

const SELF_WORKFLOW_NAMES = ['PR Security Gate', 'PR CI Status Sync'];
const SELF_JOB_NAMES = new Set([
  '📋 Issue Compliance & Scope Check',
  '🔬 Malicious Code Scanner',
  '🚦 Security Gate Decision',
  '🔄 Sync CI Status to PR Gate Comment',
]);

/**
 * Checks whether a PR belongs to a trusted maintainer, Dependabot, or develop->main release sync.
 */
function isTrustedPR({ pr, repoOwner }) {
  const author = (pr.user?.login || '').toLowerCase();
  const isMaintainerPR = author === (repoOwner || '').toLowerCase() || author === 'emarkees';
  const isDependabot = author === 'dependabot[bot]' || author === 'dependabot';
  const isReleaseSync = pr.head?.ref === 'develop' && pr.base?.ref === 'main';
  return { isTrusted: isMaintainerPR || isDependabot || isReleaseSync, isMaintainerPR, isDependabot, isReleaseSync };
}

/**
 * Encodes gate state into an invisible HTML comment so CI sync runs preserve compliance/security context.
 */
function encodeGateMeta(meta) {
  const json = JSON.stringify(meta);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return `${META_PREFIX}${b64}${META_SUFFIX}`;
}

/**
 * Decodes embedded gate metadata from an existing sticky comment body.
 */
function decodeGateMeta(body) {
  if (!body) return null;
  const start = body.indexOf(META_PREFIX);
  if (start === -1) return null;
  const contentStart = start + META_PREFIX.length;
  const end = body.indexOf(META_SUFFIX, contentStart);
  if (end === -1) return null;
  try {
    const b64 = body.slice(contentStart, end).trim();
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Finds the existing sticky gate comment on a PR, if present.
 */
async function findStickyComment({ github, owner, repo, prNumber }) {
  let comments = [];
  if (typeof github.paginate === 'function') {
    comments = await github.paginate(github.rest.issues.listComments, {
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
  } else {
    const res = await github.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });
    comments = res.data || [];
  }

  for (let i = comments.length - 1; i >= 0; i--) {
    if ((comments[i].body || '').includes(MARKER)) {
      return comments[i];
    }
  }
  return null;
}

/**
 * Creates or updates the single sticky PR gate comment containing MARKER.
 */
async function upsertGateComment({ github, context, prNumber, body }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const markedBody = body.includes(MARKER) ? body : `${MARKER}\n${body}`;

  const existing = await findStickyComment({ github, owner, repo, prNumber });
  if (existing) {
    await github.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body: markedBody,
    });
    return { action: 'updated', commentId: existing.id };
  }

  const created = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: markedBody,
  });
  return { action: 'created', commentId: created?.data?.id || null };
}

/**
 * Synchronizes gate status labels on the PR so only the active state label remains.
 */
async function syncGateLabels({ github, context, prNumber, targetLabel }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;

  if (targetLabel) {
    try {
      await github.rest.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
        labels: [targetLabel],
      });
    } catch (err) {
      console.error(`⚠️ Could not add label ${targetLabel} to PR #${prNumber}: ${err.message}`);
    }
  }

  for (const label of GATE_LABELS) {
    if (label === targetLabel) continue;
    try {
      await github.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: prNumber,
        name: label,
      });
    } catch {
      // Label not present on PR; ignore
    }
  }
}

/**
 * Provides targeted "where" and "how" remediation guidance for known CI jobs and steps.
 */
function getCIRecommendation(jobName, failedSteps) {
  const jobLower = (jobName || '').toLowerCase();
  const stepsLower = (failedSteps || []).map(s => s.toLowerCase()).join(' ');

  if (jobLower.includes('contract') && !jobLower.includes('client') && !jobLower.includes('sdk')) {
    if (stepsLower.includes('format')) {
      return {
        where: '`contracts/src/`',
        how: 'Run `cd contracts && cargo fmt`, commit the formatted files, and push.',
      };
    }
    if (stepsLower.includes('clippy')) {
      return {
        where: '`contracts/src/`',
        how: 'Run `cd contracts && cargo clippy --all-targets -- -D warnings` and fix every compiler/clippy warning.',
      };
    }
    if (stepsLower.includes('wasm') || stepsLower.includes('build') || stepsLower.includes('check')) {
      return {
        where: '`contracts/src/` and `contracts/Cargo.toml`',
        how: 'Run `cd contracts && cargo check && cargo build --target wasm32-unknown-unknown --release` to fix compilation errors.',
      };
    }
    return {
      where: '`contracts/src/lib.rs` and `contracts/src/test.rs`',
      how: 'Run `cd contracts && cargo test` locally to reproduce and fix failing smart contract tests.',
    };
  }

  if (jobLower.includes('sdk') || jobLower.includes('contract client')) {
    if (stepsLower.includes('typecheck')) {
      return {
        where: '`packages/contract-client/src/`',
        how: 'Run `cd packages/contract-client && npm ci && npm run typecheck` and fix TypeScript type errors.',
      };
    }
    if (stepsLower.includes('build')) {
      return {
        where: '`packages/contract-client/src/` and `packages/contract-client/tsconfig.json`',
        how: 'Run `cd packages/contract-client && npm ci && npm run build` to fix SDK compilation errors.',
      };
    }
    return {
      where: '`packages/contract-client/src/*.ts` and `*.test.ts`',
      how: 'Run `cd packages/contract-client && npm ci && npm run test` locally to fix failing SDK tests.',
    };
  }

  if (jobLower.includes('web') || jobLower.includes('frontend')) {
    if (stepsLower.includes('eslint') || stepsLower.includes('lint')) {
      return {
        where: '`apps/web/src/`',
        how: 'Run `cd apps/web && npm ci && npm run lint` and fix all reported ESLint errors.',
      };
    }
    if (stepsLower.includes('typecheck')) {
      return {
        where: '`apps/web/src/`',
        how: 'Run `cd apps/web && npm ci && npm run typecheck` and resolve TypeScript errors.',
      };
    }
    if (stepsLower.includes('build')) {
      return {
        where: '`apps/web/src/` and `apps/web/next.config.ts`',
        how: 'Run `cd apps/web && npm ci && npm run build` to fix Next.js production build errors.',
      };
    }
    return {
      where: '`apps/web/src/` and `apps/web/src/lib/*.test.ts`',
      how: 'Run `cd apps/web && npm ci && npm run test` locally to fix failing frontend tests.',
    };
  }

  if (jobLower.includes('relay') || jobLower.includes('go')) {
    if (stepsLower.includes('format')) {
      return {
        where: '`services/relay/`',
        how: 'Run `cd services/relay && gofmt -w .`, commit the formatted Go files, and push.',
      };
    }
    if (stepsLower.includes('vet')) {
      return {
        where: '`services/relay/`',
        how: 'Run `cd services/relay && go vet ./...` and fix the reported static analysis issues.',
      };
    }
    if (stepsLower.includes('build')) {
      return {
        where: '`services/relay/cmd/relay/` and `services/relay/internal/`',
        how: 'Run `cd services/relay && go build ./cmd/relay/main.go` to fix Go compilation errors.',
      };
    }
    return {
      where: '`services/relay/` (`*_test.go` and `internal/`)',
      how: 'Run `cd services/relay && go test -v -race ./...` locally to fix failing tests or data races.',
    };
  }

  return {
    where: 'Check the linked GitHub Actions workflow run log for affected files.',
    how: 'Reproduce the failing step locally and push a fix commit.',
  };
}

/**
 * Queries current CI workflow runs and external checks on headSha without blocking/sleeping.
 * Picks the latest run per workflow name so re-runs replace stale failures cleanly.
 */
async function inspectCIForSha({ github, owner, repo, headSha }) {
  const runsRes = await github.rest.actions.listWorkflowRunsForRepo({
    owner,
    repo,
    head_sha: headSha,
    per_page: 50,
  });

  const allRuns = runsRes.data.workflow_runs || [];
  const ciRunsRaw = allRuns.filter(
    r =>
      !SELF_WORKFLOW_NAMES.some(selfName => (r.name || '').includes(selfName)) &&
      r.event !== 'pull_request_target' &&
      r.event !== 'workflow_run'
  );

  // Deduplicate by workflow_id/name keeping the newest run
  const latestRunsMap = new Map();
  for (const run of ciRunsRaw) {
    const key = run.workflow_id || run.name || run.id;
    const prev = latestRunsMap.get(key);
    if (!prev || new Date(run.created_at) > new Date(prev.created_at)) {
      latestRunsMap.set(key, run);
    }
  }
  const relevantRuns = Array.from(latestRunsMap.values());

  const checksRes = await github.rest.checks.listForRef({
    owner,
    repo,
    ref: headSha,
    per_page: 100,
  });
  const externalCheckRuns = (checksRes.data.check_runs || []).filter(
    c =>
      !SELF_JOB_NAMES.has(c.name) &&
      !(c.app && c.app.slug === 'github-actions') &&
      !(c.app && /vercel/i.test(c.app.slug || '')) &&
      !/vercel/i.test(c.name || '')
  );

  if (relevantRuns.length === 0 && externalCheckRuns.length === 0) {
    return {
      state: 'not_started',
      passedJobs: [],
      failedJobs: [],
      pendingJobs: [],
      allJobs: [],
    };
  }

  const waitingApproval = relevantRuns.some(
    r => r.status === 'waiting' || r.conclusion === 'action_required'
  );

  const failConclusions = new Set([
    'failure',
    'timed_out',
    'cancelled',
    'startup_failure',
    'action_required',
  ]);
  const passConclusions = new Set(['success', 'skipped', 'neutral']);

  const failedJobs = [];
  const passedJobs = [];
  const pendingJobs = [];
  const allJobs = [];

  for (const run of relevantRuns) {
    if (run.status !== 'completed') {
      try {
        const jobsRes = await github.rest.actions.listJobsForWorkflowRun({
          owner,
          repo,
          run_id: run.id,
          per_page: 50,
        });
        const jobs = jobsRes.data.jobs || [];
        if (jobs.length === 0) {
          const entry = {
            name: run.name || `Workflow #${run.id}`,
            status: run.status === 'waiting' ? 'waiting_approval' : 'pending',
            conclusion: run.conclusion || run.status,
            failedSteps: [],
            url: run.html_url,
          };
          pendingJobs.push(entry);
          allJobs.push(entry);
          continue;
        }
        for (const job of jobs) {
          if (job.status !== 'completed') {
            const entry = {
              name: job.name,
              status: run.status === 'waiting' ? 'waiting_approval' : 'pending',
              conclusion: job.status,
              failedSteps: [],
              url: job.html_url || run.html_url,
            };
            pendingJobs.push(entry);
            allJobs.push(entry);
          } else if (failConclusions.has(job.conclusion)) {
            const failedSteps = (job.steps || [])
              .filter(s => s.conclusion === 'failure')
              .map(s => s.name);
            const entry = {
              name: job.name,
              status: 'failed',
              conclusion: job.conclusion,
              failedSteps,
              url: job.html_url || run.html_url,
              recommendation: getCIRecommendation(job.name, failedSteps),
            };
            failedJobs.push(entry);
            allJobs.push(entry);
          } else if (passConclusions.has(job.conclusion)) {
            const entry = {
              name: job.name,
              status: 'passed',
              conclusion: job.conclusion,
              failedSteps: [],
              url: job.html_url || run.html_url,
            };
            passedJobs.push(entry);
            allJobs.push(entry);
          }
        }
      } catch {
        const entry = {
          name: run.name || `Workflow #${run.id}`,
          status: run.status === 'waiting' ? 'waiting_approval' : 'pending',
          conclusion: run.status,
          failedSteps: [],
          url: run.html_url,
        };
        pendingJobs.push(entry);
        allJobs.push(entry);
      }
      continue;
    }

    try {
      const jobsRes = await github.rest.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id: run.id,
        per_page: 50,
      });
      for (const job of jobsRes.data.jobs || []) {
        if (failConclusions.has(job.conclusion)) {
          const failedSteps = (job.steps || [])
            .filter(s => s.conclusion === 'failure')
            .map(s => s.name);
          const entry = {
            name: job.name,
            status: 'failed',
            conclusion: job.conclusion,
            failedSteps,
            url: job.html_url || run.html_url,
            recommendation: getCIRecommendation(job.name, failedSteps),
          };
          failedJobs.push(entry);
          allJobs.push(entry);
        } else if (passConclusions.has(job.conclusion)) {
          const entry = {
            name: job.name,
            status: 'passed',
            conclusion: job.conclusion,
            failedSteps: [],
            url: job.html_url || run.html_url,
          };
          passedJobs.push(entry);
          allJobs.push(entry);
        }
      }
    } catch (err) {
      console.error(`Warning: Could not inspect jobs for workflow run ${run.id}: ${err.message}`);
      if (failConclusions.has(run.conclusion)) {
        const entry = {
          name: run.name || `Workflow #${run.id}`,
          status: 'failed',
          conclusion: run.conclusion,
          failedSteps: [],
          url: run.html_url,
          recommendation: getCIRecommendation(run.name, []),
        };
        failedJobs.push(entry);
        allJobs.push(entry);
      }
    }
  }

  for (const check of externalCheckRuns) {
    if (check.status !== 'completed') {
      const entry = {
        name: check.name,
        status: 'pending',
        conclusion: check.status,
        failedSteps: [],
        url: check.html_url,
      };
      pendingJobs.push(entry);
      allJobs.push(entry);
    } else if (failConclusions.has(check.conclusion)) {
      const entry = {
        name: check.name,
        status: 'failed',
        conclusion: check.conclusion,
        failedSteps: [],
        url: check.html_url,
        recommendation: getCIRecommendation(check.name, []),
      };
      failedJobs.push(entry);
      allJobs.push(entry);
    } else if (passConclusions.has(check.conclusion)) {
      const entry = {
        name: check.name,
        status: 'passed',
        conclusion: check.conclusion,
        failedSteps: [],
        url: check.html_url,
      };
      passedJobs.push(entry);
      allJobs.push(entry);
    }
  }

  let state = 'passed';
  if (waitingApproval) {
    state = 'waiting_approval';
  } else if (pendingJobs.length > 0) {
    state = 'running';
  } else if (failedJobs.length > 0) {
    state = 'failed';
  }

  return { state, passedJobs, failedJobs, pendingJobs, allJobs };
}

/**
 * Matches discovered CI jobs back to the 4 canonical Monorepo CI slots for consistent table rendering.
 */
function buildMonorepoCIRows(ciResult) {
  const matchedNames = new Set();
  const rows = [];

  for (const spec of CI_JOBS) {
    const job = (ciResult.allJobs || []).find(j => {
      const n = j.name || '';
      return spec.pattern.test(n) && (!spec.exclude || !spec.exclude.test(n));
    });
    if (job) {
      matchedNames.add(job.name);
      rows.push({ displayName: spec.label, job });
    } else {
      const fallbackStatus =
        ciResult.state === 'waiting_approval'
          ? 'waiting_approval'
          : ciResult.state === 'not_started' || ciResult.state === 'running'
          ? 'pending'
          : 'pending';
      rows.push({
        displayName: spec.label,
        job: {
          name: spec.key,
          status: fallbackStatus,
          conclusion: fallbackStatus,
          failedSteps: [],
        },
      });
    }
  }

  for (const job of ciResult.allJobs || []) {
    if (!matchedNames.has(job.name)) {
      rows.push({ displayName: job.name, job });
    }
  }

  return rows;
}

function formatStatusBadge(status, conclusion) {
  if (status === 'passed') {
    return conclusion === 'skipped' ? '⏭️ Skipped' : '✅ Passed';
  }
  if (status === 'failed') return '❌ Failed';
  if (status === 'waiting_approval') return '⏸️ Needs Approval';
  return '⏳ Running';
}

/**
 * Renders the single unified PR Gate Status Dashboard comment (plus invisible metadata).
 */
function renderUnifiedGateComment({
  prNumber,
  prAuthor,
  headSha,
  owner,
  repo,
  issueCompliant,
  scanClean,
  issueReason,
  scanReport,
  linkedIssue,
  issueTitle,
  scopeReport,
  trustedRole,
  ciResult,
  securityGatePending,
  timestamp,
}) {
  const shortSha = (headSha || '').slice(0, 7) || 'unknown';
  const hasFailure = !scanClean || !issueCompliant || ciResult.state === 'failed';
  const allPassed =
    !securityGatePending &&
    scanClean &&
    issueCompliant &&
    ciResult.state === 'passed';

  let headline = '⏳ Pending Verification';
  if (hasFailure) {
    headline = '❌ Action Required';
  } else if (allPassed) {
    headline = trustedRole ? `✅ Passed (${trustedRole})` : '✅ Passed';
  } else if (ciResult.state === 'waiting_approval') {
    headline = '⏸️ Waiting for Maintainer CI Approval';
  } else if (ciResult.state === 'running' || ciResult.state === 'not_started' || securityGatePending) {
    headline = '⏳ Security Clean — Waiting for CI';
  }

  let body = `${MARKER}\n`;
  body += `## 🛡️ PR Gate Status — ${headline}\n\n`;
  body += `**PR:** #${prNumber} by @${prAuthor} | **Commit:** \`${shortSha}\``;
  if (linkedIssue) {
    body += ` | **Linked Issue(s):** ${linkedIssue}`;
  }
  body += `\n`;
  if (issueTitle) {
    body += `**Issue Details:** ${issueTitle}\n`;
  }
  body += `**Last Checked:** ${timestamp}\n\n`;

  // Summary Table
  body += `| Check | Status | Details |\n`;
  body += `| :--- | :--- | :--- |\n`;

  const complianceStatus = securityGatePending
    ? '⏳ Running'
    : issueCompliant
    ? '✅ Passed'
    : '❌ Failed';
  const complianceDetails = securityGatePending
    ? 'Checking issue linkage and file scope'
    : issueCompliant
    ? trustedRole
      ? `Trusted ${trustedRole} scope`
      : `Verified ${linkedIssue || 'issue'} scope`
    : 'See compliance & scope resolution steps below';

  const securityStatus = securityGatePending
    ? '⏳ Running'
    : scanClean
    ? '✅ Passed'
    : '❌ Failed';
  const securityDetails = securityGatePending
    ? 'Running pattern, Gitleaks, and payload scans'
    : scanClean
    ? 'No malware, secrets, or unauthorized binaries'
    : 'Security or secret finding requires remediation below';

  body += `| 📋 Issue Compliance & Scope | ${complianceStatus} | ${complianceDetails} |\n`;
  body += `| 🔬 Malware & Secret Scan | ${securityStatus} | ${securityDetails} |\n`;

  const ciRows = buildMonorepoCIRows(ciResult);
  for (const row of ciRows) {
    const j = row.job;
    const badge = formatStatusBadge(j.status, j.conclusion);
    let details = 'Waiting to run';
    if (j.status === 'passed') {
      details = j.conclusion === 'skipped' ? 'Skipped' : 'All checks passed';
    } else if (j.status === 'failed') {
      details =
        j.failedSteps && j.failedSteps.length > 0
          ? `Failed step(s): ${j.failedSteps.map(s => `\`${s}\``).join(', ')}`
          : `Conclusion: \`${j.conclusion || 'failure'}\``;
    } else if (j.status === 'waiting_approval') {
      details = 'Maintainer must click "Approve and run" in Actions';
    } else {
      details = 'Workflow in progress';
    }
    body += `| ${row.displayName} | ${badge} | ${details} |\n`;
  }
  body += `\n`;

  // What Passed section
  const passedList = [];
  if (!securityGatePending && issueCompliant) {
    passedList.push(
      scopeReport
        ? `**Compliance & Scope:** ${scopeReport.replace(/\n/g, ' ')}`
        : '**Compliance & Scope:** Verified'
    );
  }
  if (!securityGatePending && scanClean) {
    passedList.push('**Malware, Secret & Integrity Scan:** Clean');
  }
  if (ciResult.passedJobs.length > 0) {
    passedList.push(`**CI Jobs Passed:** ${ciResult.passedJobs.map(j => `\`${j.name}\``).join(', ')}`);
  }

  if (passedList.length > 0) {
    body += `### ✅ What Passed\n`;
    body += passedList.map(item => `- ${item}`).join('\n') + `\n\n`;
  }

  // What Failed section
  if (hasFailure) {
    body += `### 🚨 What Failed — Where & How to Resolve\n\n`;

    if (!securityGatePending && !scanClean) {
      body += `#### 🔑 Security / Secret Finding\n`;
      body += `${scanReport}\n\n`;
      body += `- **How to Fix:** Remove committed secrets or unsafe code; if a real secret was pushed, rotate it immediately and clean commit history (\`git commit --amend\` or \`git rebase -i\` + \`git push --force-with-lease\`). Never commit \`.vscode/\` tasks, binaries, or \`S...\` keys.\n\n`;
    }

    if (!securityGatePending && !issueCompliant) {
      body += `#### 📋 Compliance / Scope Violation\n`;
      body += `${issueReason}\n\n`;
      body += `<details>\n<summary>💡 Contributor Compliance Quick Reference</summary>\n\n`;
      body += `1. Reference up to **4 assigned open issues** in your PR body (e.g. \`Closes #42\` or \`Closes #10, #11\`).\n`;
      body += `2. Browse open tasks: [Open Issues Catalog](https://github.com/${owner}/${repo}/issues?q=is%3Aissue+is%3Aopen+label%3Adrips-wave).\n`;
      body += `3. Keep edits within your issue's architectural layer (\`contracts/\`, \`apps/web/\`, \`packages/contract-client/\`, \`services/relay/\`, \`docs/\`, \`evidence/\`) and never edit \`.github/\` or \`scripts/ci/\`.\n`;
      body += `\n</details>\n\n`;
    }

    if (ciResult.failedJobs.length > 0) {
      for (const job of ciResult.failedJobs) {
        const stepsText =
          job.failedSteps && job.failedSteps.length > 0
            ? job.failedSteps.map(s => `\`${s}\``).join(', ')
            : `Job conclusion: \`${job.conclusion}\``;
        body += `#### ❌ ${job.name}\n`;
        body += `- **Failed Step(s):** ${stepsText}\n`;
        body += `- **Where to Fix:** ${job.recommendation.where}\n`;
        body += `- **How to Fix:** ${job.recommendation.how}\n`;
        if (job.url) {
          body += `- **Logs:** [View failure logs](${job.url})\n`;
        }
        body += `\n`;
      }
    }
  } else if (ciResult.state === 'waiting_approval') {
    body += `### ⏸️ Maintainer Action Needed\n`;
    body += `- First-time contributor CI workflows require a maintainer to click **"Approve and run"** in the **Actions** tab. Once approved and finished, **this comment will automatically update**.\n\n`;
  } else if (ciResult.state === 'running' || ciResult.state === 'not_started' || securityGatePending) {
    body += `### ⏳ Checks Still In Progress\n`;
    body += `- **Monorepo CI** is currently running for commit \`${shortSha}\`. Once all jobs finish, **this comment will automatically update** with the final pass/fail verdict.\n\n`;
  } else if (allPassed) {
    body += `> 🚀 **All security, compliance, and CI checks passed!** Ready for maintainer review (@emarkees).\n\n`;
  }

  body += `---\n`;
  body += `> 🔄 **Auto Re-Check:** Your PR remains **OPEN**. Push a fix commit or edit your PR description and **this single comment will update automatically** when checks run.\n`;

  if (!securityGatePending) {
    body += `\n${encodeGateMeta({
      sha: headSha,
      issueCompliant,
      scanClean,
      issueReason,
      scanReport,
      linkedIssue,
      issueTitle,
      scopeReport,
      trustedRole: trustedRole || '',
    })}`;
  }

  return body;
}

module.exports = {
  MARKER,
  GATE_LABELS,
  isTrustedPR,
  encodeGateMeta,
  decodeGateMeta,
  findStickyComment,
  upsertGateComment,
  syncGateLabels,
  getCIRecommendation,
  inspectCIForSha,
  renderUnifiedGateComment,
};
