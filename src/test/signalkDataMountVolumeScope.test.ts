import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertVolumeIsNotBroaderThanRequested } from "../containers.js";

/**
 * `signalkDataMount` resolves to a named volume when one backs the data
 * directory. Neither runtime can subpath-mount a volume, so whatever the
 * volume holds is what the managed container sees — which is only
 * acceptable while the volume is the data directory itself.
 */

const DATA_DIR = "/var/lib/signalk/plugin-config-data/signalk-container";
const VOLUME = "signalk-data";

describe("assertVolumeIsNotBroaderThanRequested", () => {
  it("accepts a volume mounted on the data directory itself", () => {
    assert.doesNotThrow(() =>
      assertVolumeIsNotBroaderThanRequested(
        VOLUME,
        DATA_DIR,
        DATA_DIR,
        "signalkDataMount",
      ),
    );
  });

  it("refuses a volume covering the SignalK config root", () => {
    // The container asked for scratch space; the whole volume would carry
    // settings.json, security.json and every other plugin's state.
    assert.throws(
      () =>
        assertVolumeIsNotBroaderThanRequested(
          VOLUME,
          "/var/lib/signalk",
          DATA_DIR,
          "signalkDataMount",
        ),
      /cannot be resolved safely/,
    );
  });

  it("refuses any parent, however close", () => {
    assert.throws(
      () =>
        assertVolumeIsNotBroaderThanRequested(
          VOLUME,
          "/var/lib/signalk/plugin-config-data",
          DATA_DIR,
          "signalkDataMount",
        ),
      /whole volume/,
    );
  });

  it("names the API the consumer actually used", () => {
    // One resolver serves both mount fields; an error naming the wrong one
    // sends the operator to the wrong part of their config.
    assert.throws(
      () =>
        assertVolumeIsNotBroaderThanRequested(
          VOLUME,
          "/var/lib",
          "/var/lib/signalk",
          "signalkConfigRootMount",
        ),
      /^Error: signalkConfigRootMount cannot be resolved safely/,
    );
  });

  it("names the volume, its mount point and the remedy", () => {
    // The operator has to know which volume to re-attach, and to what.
    try {
      assertVolumeIsNotBroaderThanRequested(
        VOLUME,
        "/var/lib/signalk",
        DATA_DIR,
        "signalkDataMount",
      );
      assert.fail("should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, new RegExp(VOLUME));
      assert.match(msg, /\/var\/lib\/signalk/);
      assert.match(msg, new RegExp(DATA_DIR.replace(/[/.]/g, "\\$&")));
      assert.match(msg, /resolveHostPath/);
    }
  });
});
