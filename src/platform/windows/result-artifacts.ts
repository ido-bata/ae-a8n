/**
 * Reading a job result's artifacts as verified bytes.
 *
 * `result.json` is HMAC-signed, and since the artifact-digest change its
 * signature also covers the SHA-256 of every artifact the agent published.
 * A channel writer without the key can still replace `stdout.log` after the
 * result is signed — the digest is what makes that replacement detectable.
 *
 * Three answers, never a fourth:
 *
 *   - `verified`   — the result declared digests and the bytes match;
 *   - `unproven`   — the result predates the field (or declared none), so
 *                    today's behaviour applies: the bytes are read as they
 *                    always were, and the caller records the proof as
 *                    unproven rather than verified;
 *   - `refused`    — the result declared digests and the bytes do not match,
 *                    or the named artifact is not one the result covers.
 */

import type { FileChannel } from "./channel.js";
import { jobPaths, sha256Hex, type JobResult } from "./job.js";

export type ResultArtifactRead =
  | {
      readonly proof: "verified" | "unproven";
      readonly bytes: Uint8Array | null;
    }
  | { readonly proof: "refused"; readonly detail: string };

/**
 * Read one artifact of a finished job and check it against the digest the
 * signed result carries. `name` is the artifact's path inside the result
 * directory, exactly as the agent named it.
 */
export async function readResultArtifact(
  channel: FileChannel,
  jobId: string,
  result: JobResult,
  name: string,
): Promise<ResultArtifactRead> {
  const declared = result.artifacts;
  if (declared === undefined) {
    // A result from before the digest field: read as before, unproven.
    return {
      proof: "unproven",
      bytes: await channel.read(`${jobPaths(jobId).resultDirectory}/${name}`),
    };
  }
  const digest = declared[name];
  if (digest === undefined) {
    return {
      proof: "refused",
      detail:
        `result.json does not authenticate artifact "${name}"; ` +
        "the file on the channel is not covered by the result's signature",
    };
  }
  const bytes = await channel.read(`${jobPaths(jobId).resultDirectory}/${name}`);
  if (bytes === null) {
    return {
      proof: "refused",
      detail: `artifact "${name}" is named by result.json but is missing from the channel`,
    };
  }
  const actual = sha256Hex(bytes);
  if (actual !== digest) {
    return {
      proof: "refused",
      detail:
        `artifact "${name}" does not match the digest result.json carries ` +
        `(${actual} != ${digest}); the file was rewritten after the result was signed`,
    };
  }
  return { proof: "verified", bytes };
}
