/**
 * Read-only inspection of After Effects workspace XML files (#362).
 *
 * Everything here is `observe`-class per spec §2/§8: the module hashes,
 * stats, and text-scans files AE owns. It never writes, copies, renames,
 * or deletes anything — there is deliberately no write path to test for
 * beyond its absence.
 *
 * Workspace-name extraction is a **heuristic over an unverified schema**.
 * Adobe does not publish the workspace XML format. The rule below collects,
 * in order:
 *
 *   1. `name` attributes on elements whose local tag contains "workspace"
 *      (covers `<Workspace name="Standard">`, `<x:UserWorkspace …>`);
 *   2. if that finds nothing, text of `<name>`/`<workspaceName>` elements.
 *
 * An empty result means "nothing matched the heuristic" — not "the file
 * has no workspaces". Consumers must treat `workspaceNames` as a hint,
 * never as identity (spec §5: the active workspace is re-read from the
 * menu checkmark, not from these files).
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

import { discoverWorkspaceXml, type DiscoverOptions } from "./paths.js";
import {
  WorkspaceXmlError,
  type InspectedWorkspaceXml,
  type WorkspaceDiscovery,
  type WorkspaceStoreSnapshot,
  type WorkspaceXmlInspection,
  type WorkspaceXmlRef,
} from "./types.js";

const START_TAG = /<([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NAME_ELEMENT =
  /<\s*(?:[\w.-]*:)?(?:name|workspaceName)\s*>([^<]+)<\s*\/\s*(?:[\w.-]*:)?(?:name|workspaceName)\s*>/gi;

function localTagName(tag: string): string {
  const colon = tag.lastIndexOf(":");
  return (colon === -1 ? tag : tag.slice(colon + 1)).toLowerCase();
}

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(source)) !== null) {
    const value = match[2] ?? match[3] ?? "";
    attributes.set(match[1] ?? "", decodeXmlEntities(value));
  }
  return attributes;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function pushUnique(into: string[], value: string): void {
  const trimmed = value.trim();
  if (trimmed !== "" && !into.includes(trimmed)) {
    into.push(trimmed);
  }
}

/**
 * Extracts workspace display names from workspace XML text using the
 * documented heuristic. Pure function — safe to unit test on fixtures.
 */
export function extractWorkspaceNames(xml: string): string[] {
  const names: string[] = [];

  START_TAG.lastIndex = 0;
  let tag: RegExpExecArray | null;
  while ((tag = START_TAG.exec(xml)) !== null) {
    const local = localTagName(tag[1] ?? "");
    if (!local.includes("workspace")) continue;
    const name = attributesOf(tag[2] ?? "").get("name");
    if (name !== undefined) pushUnique(names, name);
  }

  if (names.length === 0) {
    NAME_ELEMENT.lastIndex = 0;
    let element: RegExpExecArray | null;
    while ((element = NAME_ELEMENT.exec(xml)) !== null) {
      pushUnique(names, element[1] ?? "");
    }
  }

  return names;
}

/** Builds the spec §5 `xmlRef` evidence handle from an inspection. */
export function workspaceXmlRef(inspection: {
  readonly path: string;
  readonly sha256: string;
}): WorkspaceXmlRef {
  return { path: inspection.path, sha256: inspection.sha256 };
}

/**
 * Reads one workspace XML file: sha256, size, mtime, and heuristic name
 * extraction. Throws `WorkspaceXmlError` on missing/non-file/unreadable
 * input. Performs no writes.
 */
export function inspectWorkspaceXml(path: string): WorkspaceXmlInspection {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) {
    throw new WorkspaceXmlError(
      "read-failed",
      `workspace XML not found: ${path}`,
    );
  }
  if (!stat.isFile()) {
    throw new WorkspaceXmlError(
      "not-a-file",
      `workspace XML path is not a regular file: ${path}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new WorkspaceXmlError(
      "read-failed",
      `could not read workspace XML ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const xml = bytes.toString("utf-8");
  const workspaceNames = extractWorkspaceNames(xml);

  return {
    path,
    fileName: basename(path),
    sha256,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    workspaceNames,
    xmlRef: { path, sha256 },
  };
}

/**
 * Discovers the workspace stores and inspects every XML file found.
 * Equivalent to `discoverWorkspaceXml` + `inspectWorkspaceXml` per file,
 * packaged as the snapshot W1 evidence collection will consume.
 */
export function snapshotWorkspaceStore(
  options: DiscoverOptions = {},
): WorkspaceStoreSnapshot {
  const discovery: WorkspaceDiscovery = discoverWorkspaceXml(options);
  const files: InspectedWorkspaceXml[] = discovery.files.map((file) => ({
    kind: file.kind,
    ...inspectWorkspaceXml(file.path),
  }));
  return {
    preferencesDir: discovery.preferencesDir,
    layout: discovery.layout,
    versionDir: discovery.versionDir,
    files,
    missingStores: discovery.missingStores,
  };
}
