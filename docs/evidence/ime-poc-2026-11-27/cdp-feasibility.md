# CDP feasibility on AE's CEP/CEF — findings (2026-11-27, read-only bundle + log inspection)

## Verdict: SUPPORTED, per-extension scoped

AE's CEP panels run in `CEPHtmlEngine.app` (Chromium Embedded Framework,
full Chromium content — devtools code present in the framework binary).
Remote debugging is NOT a global AE endpoint; it is a **per-extension-surface
channel** enabled by the extension bundle itself:

1. The extension ships a `.debug` file at the bundle root — an
   `ExtensionList` XML mapping each `Extension Id` to a `Host` debug `Port`
   (ty-plus dev bundle: ports 9170+ per surface; see
   `/Users/rebui/work/ty-plus/dist/cep-dev/.debug`).
2. With `PlayerDebugMode=1` in `com.adobe.CSXS.<ver>.plist` (already set on
   this host for CSXS 9–13), CEPHtmlEngine starts a CEF instance per surface
   with remote debugging on the assigned port.
3. The live endpoint is the standard CEF/CDP HTTP+WebSocket interface:
   `http://127.0.0.1:<port>/json/list` → targets → `webSocketDebuggerUrl`.
   ty-plus's own E2E (`scripts/verify/e2e/cdp.ts`, `surfaces.ts`) drives
   live panels through exactly this — proven on this host against AE 2027.
4. Each debug surface also logs `DevTools listening on
   ws://127.0.0.1:<ephemeral>/devtools/browser/<guid>` to
   `~/Library/Logs/CSXS/CEPHtmlEngine<ver>-<host>-<ext>.debug-console.log`
   (browser-level WS; the stable per-surface endpoint is the `.debug` port).

## Evidence on this host (no AE launch performed by this PoC)

- `~/Library/Logs/CSXS/CEPHtmlEngine12-AEFT-27.0-app.ty-plus(.dev).debug-console.log`
  contain `DevTools listening on ws://127.0.0.1:{34038,49919}/...` lines
  written while AE 2027 ran earlier today.
- `defaults read com.adobe.CSXS.9..13` → `PlayerDebugMode = 1` on all.
- CEPHtmlEngine binary strings include `remote-debugging-port` and
  `No debug port file found.` / `Error occurs while getting debug port.` —
  consistent with the `.debug`-file-driven port mechanism.
- Ports were not live at check time (no panel surfaces open); endpoints
  exist only while the owning surface's CEPHtmlEngine is running.

## Consequences for specs/ime-input/spec.md §7

- The `Composition observation — CDP` row can move from `unverified` to
  **`supported` (scoped)**: CDP is available per fixture surface when the
  fixture extension ships a `.debug` file and PlayerDebugMode is set.
- Scope limits to record honestly: CDP observes/drives ONE extension's
  surfaces; it is not an AE-wide debug channel; the port is per-surface
  and only alive while that surface is open; `Input.*` CDP methods remain
  forbidden as Tier-1b evidence (spec §4.2) regardless.
- For the fixture: `ae extension build` output must include the `.debug`
  file (or equivalent) for the CDP channel to exist — flag to #376/#fixture.
