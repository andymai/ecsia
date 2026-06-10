# Security Policy

## Supported Versions

ecsia is pre-1.0. Only the latest published version receives security updates — pin a version and
upgrade promptly.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

## Reporting a Vulnerability

To report a security vulnerability, please use [GitHub Security Advisories](https://github.com/andymai/ecsia/security/advisories/new).

This provides private vulnerability reporting without requiring email. **Please do not open a public
issue for security problems.**

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

### Response Timeline

- **Acknowledgement**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity
  - Critical: As soon as possible
  - High: Within 2 weeks
  - Medium/Low: Next release cycle

### Disclosure Policy

We follow responsible disclosure. Once a fix is released, we will:

1. Credit the reporter (unless they prefer anonymity)
2. Publish a security advisory
3. Note the fix in the changelog

## Supply Chain

In response to the 2025–2026 wave of npm and GitHub Actions supply-chain attacks
(Shai-Hulud worm, chalk/debug compromise, tj-actions tag retag), the build is configured to
fail closed on the patterns those attacks exploit:

| Defense                                   | Where                            | What it blocks                                                                |
| ----------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- |
| All GitHub Actions pinned to commit SHA   | `.github/workflows/*.yml`        | Tag-retag attacks (tj-actions class). Tags are mutable; commit SHAs are not.  |
| OSV scan (PRs report-only, main blocking) | `.github/workflows/osv-scan.yml` | Known-CVE versions already in the lockfile (`pnpm-lock.yaml`).                |
| Dependabot cooldown (7d / 14d major)      | `.github/dependabot.yml`         | Fresh malicious uploads — a new version isn't proposed until it has aged.     |
| Provenance via trusted-publisher OIDC     | `.github/workflows/release.yml`  | `NPM_TOKEN` exposure. Releases publish from CI (`id-token: write`) via npm OIDC trusted publishers, so packages are signed and attested. |

Install-time cooldown (pnpm `minimumReleaseAge`) is deliberately not configured: it would block
CI installs of freshly-published dependencies, and the Dependabot cooldown already gates the
update path where fresh-upload risk concentrates.
