import * as core from "@actions/core";
import { createClient } from "@1claw/sdk";

/**
 * Parse the `secrets` input into [{ envName, vault, secretPath, raw }].
 * Accepts newline- and/or comma-separated `ENV_NAME=vault/ref` mappings.
 * `vault/ref` splits on the FIRST slash: everything before is the vault
 * (ID or name), everything after is the secret path inside that vault.
 */
function parseMappings(raw) {
  const entries = raw
    .split(/[\r\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const mappings = [];
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      throw new Error(
        `Invalid mapping "${entry}": expected ENV_NAME=vault/ref.`
      );
    }
    const envName = entry.slice(0, eq).trim();
    const ref = entry.slice(eq + 1).trim();

    if (!envName) {
      throw new Error(`Invalid mapping "${entry}": missing ENV_NAME.`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) {
      throw new Error(
        `Invalid env name "${envName}": must match [A-Za-z_][A-Za-z0-9_]*.`
      );
    }

    const slash = ref.indexOf("/");
    if (slash === -1) {
      throw new Error(
        `Invalid ref "${ref}" for ${envName}: expected <vault>/<secret-path>.`
      );
    }
    const vault = ref.slice(0, slash).trim();
    const secretPath = ref.slice(slash + 1).trim();
    if (!vault || !secretPath) {
      throw new Error(
        `Invalid ref "${ref}" for ${envName}: both <vault> and <secret-path> are required.`
      );
    }

    mappings.push({ envName, vault, secretPath, raw: entry });
  }

  if (mappings.length === 0) {
    throw new Error("No secret mappings provided in `secrets` input.");
  }
  return mappings;
}

/** Format an SDK error envelope into a single safe line (never includes values). */
function formatError(res, ref) {
  const e = res && res.error;
  const status = res && res.meta && res.meta.status;
  const parts = [
    (e && e.message) || "request failed",
    e && e.detail && e.detail !== e.message ? e.detail : undefined,
    e && e.type ? `[${e.type}]` : undefined,
    status != null ? `HTTP ${status}` : undefined,
  ].filter(Boolean);
  return `Failed to fetch ${ref}: ${parts.join(" — ")}`;
}

async function run() {
  const apiKey = core.getInput("api-key", { required: true });
  const secretsInput = core.getInput("secrets", { required: true });
  const mask = core.getBooleanInput("mask");
  const apiBase = core.getInput("api-base") || "https://api.1claw.co";

  const mappings = parseMappings(secretsInput);

  const client = createClient({ baseUrl: apiBase, apiKey });

  // Resolve vault references (ID or name) to vault IDs once, lazily.
  // A ref is treated as a name only if it does not resolve as an ID.
  let vaultList = null;
  const vaultCache = new Map();

  async function resolveVaultId(vaultRef) {
    if (vaultCache.has(vaultRef)) return vaultCache.get(vaultRef);

    if (vaultList === null) {
      const res = await client.vault.list();
      if (res.error || !res.data) {
        throw new Error(
          `Could not list vaults to resolve "${vaultRef}": ${
            (res.error && res.error.message) || "unknown error"
          }`
        );
      }
      vaultList = res.data.vaults || [];
    }

    // Exact ID match wins.
    const byId = vaultList.find((v) => v.id === vaultRef);
    if (byId) {
      vaultCache.set(vaultRef, byId.id);
      return byId.id;
    }
    // Fall back to a unique name match.
    const byName = vaultList.filter((v) => v.name === vaultRef);
    if (byName.length === 1) {
      vaultCache.set(vaultRef, byName[0].id);
      return byName[0].id;
    }
    if (byName.length > 1) {
      throw new Error(
        `Vault name "${vaultRef}" is ambiguous (matches ${byName.length} vaults). Use the vault ID instead.`
      );
    }
    throw new Error(
      `Vault "${vaultRef}" not found or not accessible to this agent (deny-by-default).`
    );
  }

  let resolved = 0;
  for (const m of mappings) {
    const ref = `${m.vault}/${m.secretPath}`;

    const vaultId = await resolveVaultId(m.vault);
    const res = await client.secrets.get(vaultId, m.secretPath);

    if (res.error || !res.data) {
      // Fail closed. Message never contains the secret value.
      throw new Error(formatError(res, ref));
    }

    const value = res.data.value;
    if (typeof value !== "string") {
      throw new Error(`Secret ${ref} returned no string value.`);
    }

    // Mask BEFORE exporting so any later echo of the value is redacted.
    if (mask) {
      core.setSecret(value);
    }
    core.exportVariable(m.envName, value);
    core.setOutput(m.envName, value);
    resolved += 1;

    core.info(`Resolved ${ref} -> $${m.envName} (masked: ${mask})`);
  }

  core.info(`1Claw Secrets: exported ${resolved} secret(s).`);
}

run().catch((err) => {
  // setFailed prints the message only; values are never placed in messages.
  core.setFailed(err && err.message ? err.message : String(err));
});
