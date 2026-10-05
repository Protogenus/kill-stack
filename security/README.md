# Security evidence

- `sbom.cdx.json`: CycloneDX SBOM of the npm dependency tree (generated with
  `@cyclonedx/cyclonedx-npm`).
- `npm-audit.json`: `npm audit --json` output for the lock file at the time of
  generation.

Regenerate both after changing dependencies:

npx @cyclonedx/cyclonedx-npm --output-format JSON --output-file
security/sbom.cdx.json
    npm audit --json > security/npm-audit.json

CI (`.github/workflows/ci.yml`) runs `npm audit --audit-level=high` and uploads
a fresh SBOM on every run.
