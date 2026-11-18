# Windows real-host evidence — 2026-11-18

Packaged `@ido-bata/ae-a8n@0.3.0` verified on a real Windows 11 host reached
through herdr (`device-windows`) into the interactive desktop session.

- `manifest.json` — source SHA, tarball hashes, host identity, AE versions, per-run records
- `report.json` — operation-level results and safety notes
- `e2e-win{1,2}-trace.jsonl` — driver traces copied verbatim from the host
- `e2e-win{1,2}-a8n-session.json` — session manifests
- `doctor.json` — read-only `doctor --json` output (status ok; trust/component honestly unproven)

Result: **Windows local E2E PASS x2** (`verified on real host`). Render PNGs
(3671 B each, identical SHA-256 — deterministic flat comp) remain on the host
at `C:\Users\rebui\ae-a8n-verify\e2e-win{1,2}\artifacts\`; their hashes are in
the manifest.

Not covered here (UNVERIFIED, tracked in #74): isolated-session E2E, GUI
non-interference measurement, and the remaining T092 acceptance rows.
