/**
 * A transport that runs the host script in-process against the fake
 * After Effects model.
 *
 * This is what makes the rest of the stack testable without Adobe installed:
 * the request file, the bootstrap, the ES3 host script, the result file, and
 * the driver's polling loop are all the real code.
 */

import { runHostScript, CloseOptions, type HostGlobals } from "./fake-ae/es3-runtime.js";
import {
  FakeApplication,
  createDefaultComp,
  createFakeGlobals,
  type FakeComp,
} from "./fake-ae/object-model.js";
import type { HostTransport } from "../driver/transport.js";

export type FakeTransportOptions = {
  /**
   * What the fake should do when a method is unknown or a value is invalid.
   * "throw" surfaces a failed result envelope, which is what real AE does.
   */
  readonly onHostError?: "throw";
};

export class FakeAfterEffectsTransport implements HostTransport {
  readonly kind = "fake-in-process";
  readonly app = new FakeApplication();
  /**
   * A global `JSON` for the host to find, standing in for one another AE
   * extension installed. Unset by default: real ExtendScript has none.
   */
  foreignJson: unknown = undefined;
  #launched = false;
  #closed = false;
  #nextComp: FakeComp = createDefaultComp();

  available(): Promise<boolean> {
    return Promise.resolve(true);
  }

  launch(): Promise<void> {
    // The real transport starts a process here. The fake needs a live project
    // for `app.info` to report a version against, and the host script requires
    // a project to be open for most operations.
    if (!this.#launched) {
      this.#launched = true;
      if (this.app.project.numItems === 0) {
        this.app.project.load(this.#nextComp, null);
      }
    }
    return Promise.resolve();
  }

  invoke(entryScriptPath: string): Promise<void> {
    const globals: HostGlobals = createFakeGlobals(this.app);
    const outcome = runHostScript(
      entryScriptPath,
      globals,
      this.foreignJson === undefined ? {} : { foreignJson: this.foreignJson },
    );
    if (!outcome.success) {
      // The bootstrap catches everything the host throws, so reaching here
      // means the entry script itself failed. On a real AE that is a modal
      // dialog that blocks the application until someone dismisses it.
      throw new Error(
        `fake host threw while evaluating the entry script: ${outcome.error.message}`,
      );
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#closed = true;
    this.app.quit();
    this.app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES);
    return Promise.resolve();
  }

  /** Replace the composition the next `launch()` will install. */
  setComp(comp: FakeComp): void {
    this.#nextComp = comp;
  }

  get launched(): boolean {
    return this.#launched;
  }

  get closed(): boolean {
    return this.#closed;
  }
}
