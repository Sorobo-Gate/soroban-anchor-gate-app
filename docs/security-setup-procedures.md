# 🛡️ Security Setup Procedures

Step-by-step procedures for configuring GitHub security features for the SorobanAnchor Gate repository.

---

## 1. Create Required Labels

The PR Security Gate workflow automatically applies labels to PRs. You must create them first.

### Option A — GitHub Web UI (Manual)

1. Go to your repository: **https://github.com/emarkees/soroban-anchor-gate-app**
2. Click the **Issues** tab
3. Click **Labels** (right side)
4. Click **New label**

Create these two labels:

| Label Name | Color Code | Description |
|------------|-----------|-------------|
| `security-rejected` | `#d73a4a` | PR auto-closed by the security gate — malicious code or compliance failure |
| `security-passed` | `#0e8a16` | PR passed all automated security scans — awaiting manual review |

For each label:
- Type the **Label name** exactly as shown (case-sensitive)
- Paste the **Color** hex code (without the `#` — GitHub adds it)
- Type the **Description**
- Click **Create label**

### Option B — GitHub CLI (Automated)

If you have the [GitHub CLI](https://cli.github.com/) installed, run these commands from your terminal:

```bash
# Authenticate if you haven't already
gh auth login

# Create the security-rejected label (red)
gh label create "security-rejected" \
  --description "PR auto-closed by the security gate — malicious code or compliance failure" \
  --color "d73a4a" \
  --repo emarkees/soroban-anchor-gate-app

# Create the security-passed label (green)
gh label create "security-passed" \
  --description "PR passed all automated security scans — awaiting manual review" \
  --color "0e8a16" \
  --repo emarkees/soroban-anchor-gate-app
```

### Option C — GitHub REST API (cURL)

If you prefer using the API directly, create a [Personal Access Token](https://github.com/settings/tokens) with `repo` scope, then run:

```bash
# Replace YOUR_TOKEN with your GitHub Personal Access Token

# Create security-rejected label
curl -X POST \
  -H "Authorization: token YOUR_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/emarkees/soroban-anchor-gate-app/labels \
  -d '{"name":"security-rejected","color":"d73a4a","description":"PR auto-closed by the security gate — malicious code or compliance failure"}'

# Create security-passed label
curl -X POST \
  -H "Authorization: token YOUR_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/emarkees/soroban-anchor-gate-app/labels \
  -d '{"name":"security-passed","color":"0e8a16","description":"PR passed all automated security scans — awaiting manual review"}'
```

### Verification

After creating the labels, go to **https://github.com/emarkees/soroban-anchor-gate-app/labels** and confirm both labels appear:

- 🔴 **security-rejected**
- 🟢 **security-passed**

---

## 2. Enable Secret Scanning + Push Protection

Secret scanning detects leaked credentials (API keys, Stellar secret keys, passwords) in your code. Push protection **blocks the push entirely** before it even reaches the repository.

### Step-by-Step (GitHub Web UI)

1. Go to your repository: **https://github.com/emarkees/soroban-anchor-gate-app**

2. Click **Settings** (top tab bar — you must be the repo owner/admin)

3. In the left sidebar, click **Code security and analysis**
   > If you don't see this option, look under **Security** → **Code security and analysis**

4. Scroll to the **Secret scanning** section and configure:

   | Setting | Action |
   |---------|--------|
   | **Secret scanning** | Click **Enable** |
   | **Push protection** | Click **Enable** (appears after enabling secret scanning) |
   | **Validity checks** | Click **Enable** if available — checks if detected secrets are still active |

5. While you're on this page, also enable these if not already active:

   | Setting | Action |
   |---------|--------|
   | **Dependency graph** | Verify it shows **Enabled** |
   | **Dependabot alerts** | Click **Enable** |
   | **Dependabot security updates** | Click **Enable** |

6. Click **Save** if prompted

### What Happens After Enabling

#### Secret Scanning
- GitHub continuously scans your entire repository history for 200+ secret patterns
- If secrets are found, you'll see alerts at **Security** → **Secret scanning alerts**
- You will receive email notifications for any detected secrets

#### Push Protection
When a contributor tries to push code containing a secret, this happens:

```
remote: —— GitHub Push Protection ——————————————————————
remote: 
remote:  ✗ Found 1 secret in commit abc1234
remote: 
remote:    Stellar Secret Key
remote:    Location: contracts/src/lib.rs:42
remote: 
remote:  To push, you must first remove the secret from your commits.
remote: 
remote: —————————————————————————————————————————————————
```

The push is **blocked entirely** — the secret never reaches your repository.

#### If a contributor claims they need to bypass push protection:
> ⚠️ **Never allow bypasses.** If the secret is a test key, they should use environment variables. If it's a false positive, they can request a review through the GitHub Security tab.

### Verify It's Working

1. Go to **Settings → Code security and analysis**
2. Confirm you see green checkmarks (✅) next to:
   - Secret scanning
   - Push protection
3. Go to **Security** tab → **Secret scanning** to see if any historical secrets were detected

---

## 3. Enable Branch Protection Rules

These rules prevent anyone (including you) from pushing directly to protected branches.

### Step-by-Step

1. Go to **Settings** → **Branches**
2. Click **Add branch protection rule**
3. Set **Branch name pattern** to `main`
4. Configure these settings:

#### For `main` branch:

| Setting | Toggle | Why |
|---------|--------|-----|
| **Require a pull request before merging** | ✅ ON | No direct pushes to main |
| ↳ Required number of approvals | `1` | At least one maintainer must approve |
| ↳ Dismiss stale PR approvals when new commits are pushed | ✅ ON | Forces re-review after changes |
| ↳ Require review from Code Owners | ✅ ON | Your CODEOWNERS file enforces review |
| **Require status checks to pass before merging** | ✅ ON | CI + security gate must be green |
| ↳ Require branches to be up to date | ✅ ON | Forces rebase |
| ↳ Add required checks | Search and add: `📋 Issue Compliance Check`, `🔬 Malicious Code Scanner`, `🚦 Security Gate Decision` | All security jobs must pass |
| **Require signed commits** | ✅ ON (recommended) | Prevents commit author spoofing |
| **Do not allow bypassing the above settings** | ✅ ON | Even admins follow the rules |
| **Restrict who can push to matching branches** | ✅ ON, leave empty | No one pushes directly |

5. Click **Create**
6. **Repeat** for the `develop` branch with the same settings

> **Note:** The status check names won't appear in the search until the workflow has run at least once. Push the `pr-security-gate.yml` workflow first, then come back to add the checks.

---

## 4. Enable Private Vulnerability Reporting

Allow security researchers to report vulnerabilities privately instead of opening public issues.

1. Go to **Settings** → **Code security and analysis**
2. Scroll to **Private vulnerability reporting**
3. Click **Enable**

Reports will appear at **Security** → **Advisories** and only you (the admin) can see them.

---

## 5. Quick Verification Checklist

After completing all steps above, verify:

- [ ] Go to **https://github.com/emarkees/soroban-anchor-gate-app/labels** — see `security-rejected` (red) and `security-passed` (green)
- [ ] Go to **Settings → Code security** — Secret scanning ✅, Push protection ✅, Dependabot alerts ✅
- [ ] Go to **Settings → Branches** — `main` and `develop` both have protection rules
- [ ] Go to **Security tab** — Check for any existing secret scanning alerts
- [ ] Create a test branch, open a PR to `develop`, and verify the security gate workflow runs

---

## Troubleshooting

### "Secret scanning is not available"
- Secret scanning is free for public repositories
- For private repos, you need **GitHub Advanced Security** (free for open-source, paid for private)
- Alternative: The Gitleaks scan in the PR Security Gate workflow provides similar coverage for PRs

### "Status checks not appearing in branch protection"
- Status checks only appear after the workflow has run at least once
- Push the workflow file first, open a test PR, let it run, then configure branch protection

### "CODEOWNERS not working"
- The file must be at `.github/CODEOWNERS` (or root `CODEOWNERS`)
- Your GitHub username must be correct: `@emarkees`
- Branch protection must have **Require review from Code Owners** enabled

### "Labels not being applied by the workflow"
- The `GITHUB_TOKEN` needs `issues: write` permission (already configured in the workflow)
- If the labels don't exist yet, the workflow logs a warning but continues
