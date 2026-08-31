import { describe, it, expect } from "vitest";
import { requireApiToken, API_TOKEN_VAR } from "../../src/env.ts";
import { keychainSecrets, staticSecrets } from "../../src/infra/secrets.ts";

const VALID = "0123456789abcdef0123";

/**
 * The bearer token guards /api/* — and since `tailscale serve` puts that on the
 * tailnet, it is the only thing standing between a peer and the calendar. It
 * belongs in the Keychain with every other secret, not in a file on disk.
 */
describe("API token resolution", () => {
  it("reads the token from the secret resolver", async () => {
    const secrets = staticSecrets({ [API_TOKEN_VAR]: VALID });
    expect(await requireApiToken(secrets)).toBe(VALID);
  });

  it("still accepts an environment variable, so .env keeps working in development", async () => {
    // No Keychain access: `keychainSecrets` checks the environment first.
    const secrets = keychainSecrets("jarvis", { [API_TOKEN_VAR]: VALID });
    expect(await requireApiToken(secrets)).toBe(VALID);
  });

  it("names the command that fixes it when the token is missing", async () => {
    // A bare "Missing secret" would send you looking in .env — which is exactly
    // the file this change moves the token out of.
    await expect(requireApiToken(staticSecrets({}))).rejects.toThrow(/set-secret\.sh JARVIS_TOKEN/);
  });

  it("rejects a token too short to be worth having", async () => {
    const secrets = staticSecrets({ [API_TOKEN_VAR]: "tooshort" });
    await expect(requireApiToken(secrets)).rejects.toThrow(/8 characters/);
  });
});
