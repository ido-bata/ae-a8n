/**
 * Windows ACL checks: the counterpart of the POSIX mode-bit checks.
 *
 * On macOS/Linux the key file and the channel are proven safe by mode bits —
 * "readable only by the owner", "writable only by the two accounts". Windows
 * models neither, and the Windows build used to skip the checks entirely and
 * defer them to a real-host visit. These tests give the Windows build the
 * same two properties, parsed from `icacls` (the OS's own account of the ACL).
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  channelAclVerdict,
  keyFileAclVerdict,
  parseIcacls,
  type AccessControlEntry,
} from "../src/platform/windows/acl.js";
import { loadKeyFile } from "../src/platform/windows/key-store.js";

const KEY = {
  schemaVersion: "1.0",
  keyId: "k1",
  secret: Buffer.alloc(32, 7).toString("base64"),
};

function entries(...pairs: readonly (readonly [string, string])[]): AccessControlEntry[] {
  return pairs.map(([principal, rights]) => ({ principal, rights }));
}

describe("icacls parsing", () => {
  it("reads the path line and its continuations", () => {
    const out = [
      "C:\\Users\\rebui\\.ae-a8n\\channel.key BUILTIN\\Administrators:(F)",
      "                                       NT AUTHORITY\\SYSTEM:(F)",
      "                                       HOST\\rebui:(R,W)",
      "",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    expect(parseIcacls(out)).toEqual([
      { principal: "BUILTIN\\Administrators", rights: "F" },
      { principal: "NT AUTHORITY\\SYSTEM", rights: "F" },
      { principal: "HOST\\rebui", rights: "R,W" },
    ]);
  });

  it("drops inheritance markers, which are not rights", () => {
    const out = "C:\\x BUILTIN\\Users:(OI)(CI)(RX)";
    expect(parseIcacls(out)).toEqual([{ principal: "BUILTIN\\Users", rights: "RX" }]);
  });

  it("skips the summary line in any language", () => {
    // The real host prints this in Japanese. Refusing on it would refuse
    // every key on a non-English Windows.
    const out = [
      "C:\\x UUU\\rebui:(F)",
      "",
      "1 個のファイルが正常に処理されました。0 個のファイルを処理できませんでした",
    ].join("\r\n");
    expect(parseIcacls(out)).toEqual([{ principal: "UUU\\rebui", rights: "F" }]);
  });

  it("refuses a line with a colon but no entry, instead of skipping it", () => {
    // A line the parser drops might be the one carrying the grant.
    const out = [
      "C:\\x BUILTIN\\Administrators:(F)",
      "C:\\x BUILTIN\\Users:",
    ].join("\r\n");
    expect(parseIcacls(out)).toBeNull();
  });

  it("refuses output with no entries at all", () => {
    expect(parseIcacls("")).toBeNull();
  });

  it("reads a path that contains spaces when the caller names it", () => {
    // Regression: the first token was taken as the path, so a key under
    // "C:\Users\First Last\..." parsed its principal as
    // "Last\.ae-a8n\agent.key BUILTIN\Administrators" — a foreign account.
    // The key was then refused on a machine whose only fault was a space in
    // the user's name. The caller knows the path; the parser must use it.
    const path = "C:\\Users\\First Last\\.ae-a8n\\agent.key";
    const out = [
      `${path} BUILTIN\\Administrators:(F)`,
      "                              NT AUTHORITY\\SYSTEM:(F)",
      "                              HOST\\First Last:(F)",
      "",
      "Successfully processed 1 files; Failed processing 0 files",
    ].join("\r\n");
    expect(parseIcacls(out, path)).toEqual([
      { principal: "BUILTIN\\Administrators", rights: "F" },
      { principal: "NT AUTHORITY\\SYSTEM", rights: "F" },
      { principal: "HOST\\First Last", rights: "F" },
    ]);
  });

  it("strips the named path case-insensitively", () => {
    // icacls echoes what it was given; Windows paths are case-insensitive.
    const out = "c:\\users\\first last\\agent.key HOST\\First Last:(F)";
    expect(parseIcacls(out, "C:\\Users\\First Last\\agent.key")).toEqual([
      { principal: "HOST\\First Last", rights: "F" },
    ]);
  });
});

describe("the key file's ACL", () => {
  it("accepts owner, SYSTEM and Administrators", () => {
    const verdict = keyFileAclVerdict(
      entries(
        ["BUILTIN\\Administrators", "F"],
        ["NT AUTHORITY\\SYSTEM", "F"],
        ["HOST\\rebui", "R,W"],
      ),
      "rebui",
    );
    expect(verdict).toEqual({ ok: true });
  });

  it("refuses an account outside the owner, even read-only", () => {
    // A reader is a forger: anyone who can read the key can sign a job.
    const verdict = keyFileAclVerdict(
      entries(["HOST\\rebui", "F"], ["HOST\\guest", "R"]),
      "rebui",
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false ? verdict.detail : "").toContain("HOST\\guest");
  });

  it("refuses Users and Everyone, which is what 'group or others' is here", () => {
    for (const principal of ["BUILTIN\\Users", "Everyone", "NT AUTHORITY\\Authenticated Users"]) {
      const verdict = keyFileAclVerdict(entries([principal, "R"], ["HOST\\rebui", "F"]), "rebui");
      expect(verdict.ok).toBe(false);
    }
  });

  it("treats every unprivileged account as foreign when the owner is unknown", () => {
    const verdict = keyFileAclVerdict(entries(["BUILTIN\\Administrators", "F"], ["HOST\\x", "R"]), null);
    expect(verdict.ok).toBe(false);
  });

  it("still refuses a foreign grant when the path has spaces", () => {
    // The path fix must not turn a refusal into an acceptance.
    const path = "C:\\Users\\First Last\\agent.key";
    const parsed = parseIcacls(`${path} HOST\\guest:(R)\r\n HOST\\First Last:(F)`, path) ?? [];
    const verdict = keyFileAclVerdict(parsed, "First Last");
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false ? verdict.detail : "").toContain("HOST\\guest");
  });
});

describe("the channel directory's ACL", () => {
  it("accepts a channel closed to shared accounts", () => {
    const verdict = channelAclVerdict(
      entries(["BUILTIN\\Administrators", "F"], ["NT AUTHORITY\\SYSTEM", "F"], ["HOST\\rebui", "M"]),
    );
    expect(verdict).toEqual({ ok: true });
  });

  it("refuses a channel Users or Everyone can write to", () => {
    for (const rights of ["F", "M", "W", "WD,REA,WEA"]) {
      const verdict = channelAclVerdict(entries(["BUILTIN\\Users", rights]));
      expect(verdict.ok, `${rights} should be refused`).toBe(false);
    }
  });

  it("accepts read-only access for shared accounts", () => {
    expect(channelAclVerdict(entries(["BUILTIN\\Users", "RX"]))).toEqual({ ok: true });
  });
});

describe("loadKeyFile on Windows", () => {
  it.skipIf(process.platform !== "win32")(
    "reads the real ACL with icacls and refuses a key others can read",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "a8n-acl-"));
      const path = join(root, "channel.key");
      writeFileSync(path, JSON.stringify(KEY));
      // A fresh file in %TEMP% inherits an ACE for the owning user; granting
      // Users means the check has something real to refuse.
      const { execFileSync } = await import("node:child_process");
      execFileSync("icacls", [path, "/grant", "BUILTIN\\Users:(R)"]);
      const refused = await loadKeyFile(path);
      expect(refused.ok).toBe(false);
      expect(refused.ok === false ? refused.code : "").toBe("A8N-PERM-005");
      expect(refused.ok === false ? refused.detail : "").toContain("BUILTIN\\Users");

      execFileSync("icacls", [path, "/remove:g", "BUILTIN\\Users"]);
      const accepted = await loadKeyFile(path);
      expect(accepted.ok).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "still refuses a group-readable key by its mode bits here",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "a8n-mode-"));
      const path = join(root, "channel.key");
      writeFileSync(path, JSON.stringify(KEY));
      chmodSync(path, 0o644);
      const refused = await loadKeyFile(path);
      expect(refused.ok).toBe(false);
      expect(refused.ok === false ? refused.code : "").toBe("A8N-PERM-005");
    },
  );
});
