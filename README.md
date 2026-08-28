# 1Claw Secrets

> ⭐ **Star [1clawAI/agent-templates](https://github.com/1clawAI/agent-templates)** — ready-to-run agent templates wired to 1Claw. It is our single starred repo.

A GitHub Action that fetches secrets from a [1Claw](https://1claw.co) vault **at CI runtime** and exposes them as masked environment variables and step outputs. **Deny-by-default:** the only values your workflow can read are the secret refs it explicitly requests. No long-lived secrets live in GitHub repo settings — you store one short-lived agent API key and let the action exchange it for a short-TTL, policy-gated vault token on each run.

This is a thin, typed wrapper over [`@1claw/sdk`](https://www.npmjs.com/package/@1claw/sdk). It uses the real Vault HTTP API (`createClient` → `secrets.get`) and the same agent-key auth as the rest of the 1Claw stack — the action never invents endpoints. Values are registered with `::add-mask::` **before** they are exported, so they are redacted from logs even if a later step prints them.

## Why

Storing every API key in GitHub repo/org secrets means dozens of long-lived credentials sitting in settings, copied across repos, rarely rotated, and visible to anyone with admin. With this action:

- **One credential, not dozens.** You store a single 1Claw agent API key in GitHub secrets. Everything else lives in the vault.
- **Short TTL.** The agent key is exchanged for a short-lived JWT per run. Nothing long-lived touches the runner.
- **Policy-gated, deny-by-default.** The agent can only read what its vault policy allows, and the action only fetches the refs your workflow names — nothing more.
- **Audited.** Every read is recorded in the 1Claw audit trail.

## Quick Start

1. Create a 1Claw agent and scope a read policy to the secrets your CI needs (see [docs.1claw.co](https://docs.1claw.co)).
2. Add the agent API key (`ocv_...`) to your repository as a GitHub Actions secret, e.g. `ONECLAW_AGENT_API_KEY`.
3. Reference the secrets you need in your workflow:

```yaml
name: deploy

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Load secrets from 1Claw
        id: vault
        uses: 1clawAI/1claw-action@v1
        with:
          api-key: ${{ secrets.ONECLAW_AGENT_API_KEY }}
          secrets: |
            STRIPE_KEY=prod/api-keys/stripe
            DB_URL=prod/config/db-url
            NPM_TOKEN=ci/tokens/npm

      # Exported to the job env for every later step:
      - name: Use as env vars
        run: |
          echo "Stripe key length: ${#STRIPE_KEY}"   # value itself is masked in logs
          ./deploy.sh

      # Also available as step outputs (masked):
      - name: Use as step output
        run: ./publish.sh
        env:
          NODE_AUTH_TOKEN: ${{ steps.vault.outputs.NPM_TOKEN }}
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `api-key` | Yes | — | 1Claw agent API key (`ocv_...`). Pass `${{ secrets.ONECLAW_AGENT_API_KEY }}`. Exchanged for a short-lived JWT at runtime. |
| `secrets` | Yes | — | Newline- or comma-separated `ENV_NAME=vault/ref` mappings (see below). |
| `mask` | No | `true` | Register each fetched value with `::add-mask::` so it is redacted from logs. Leave on. |
| `api-base` | No | `https://api.1claw.co` | Vault API base URL. |

### The `secrets` mapping format

Each entry is `ENV_NAME=vault/ref`:

- `ENV_NAME` is the environment variable / step output name (must match `[A-Za-z_][A-Za-z0-9_]*`).
- `vault` is a vault **ID or name** accessible to the agent.
- `ref` is the secret path inside that vault. The split happens on the **first** slash, so paths may themselves contain slashes (e.g. `prod/api-keys/stripe` → vault `prod`, path `api-keys/stripe`).

Entries are separated by newlines and/or commas:

```yaml
secrets: STRIPE_KEY=prod/api-keys/stripe, DB_URL=prod/config/db-url
```

## Outputs

For each mapping, the resolved value is set as a step output under `ENV_NAME` (masked) and exported to the job environment via `$GITHUB_ENV` so all later steps see it as `$ENV_NAME`.

## Security notes

- **Deny-by-default.** Only the refs you list are fetched. If a ref is denied by policy, missing, or the vault is not accessible to the agent, the step **fails closed** with a clear message — and that message never contains a secret value.
- **Masking first.** Each value is passed to `::add-mask::` before it is exported or set as output, so it is redacted from logs even if a later command echoes it. Keep `mask: true`.
- **No values in logs or errors.** The action only logs the ref and the target env name, never the value. Error messages are built from the SDK error envelope (status / type / message), not from secret material.
- **Short TTL.** The agent API key is exchanged for a short-lived JWT per run; nothing long-lived is written to the runner. Scope the agent's vault policy to the minimum it needs.
- **Treat outputs like secrets.** Masking reduces accidental leakage, but a workflow that deliberately exfiltrates a value still can. Review the steps that consume these env vars.

## Development

```bash
npm install
npm run build      # bundles src/index.mjs -> dist/index.js with esbuild
npm test           # node --check dist/index.js
```

`dist/index.js` is committed (GitHub Actions runs the bundle directly, with no `node_modules` install). The included CI workflow rebuilds and fails if `dist/` is stale, so always run `npm run build` before committing.

## Links

- 1Claw for AI: https://1claw.co/for-ai
- Documentation: https://docs.1claw.co

## License

MIT — see [LICENSE](./LICENSE).
