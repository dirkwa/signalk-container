import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectRecoveredVolumes } from "../containers";

describe("collectRecoveredVolumes — no prior state", () => {
  it("returns [] when prior is undefined", () => {
    const r = collectRecoveredVolumes(undefined, [], [], {
      "/data": "/exists",
    });
    assert.deepEqual(r, []);
  });

  it("returns [] when prior has no skipped or aborted", () => {
    const r = collectRecoveredVolumes({ skipped: [], aborted: [] }, [], [], {
      "/data": "/exists",
    });
    assert.deepEqual(r, []);
  });
});

describe("collectRecoveredVolumes — skipped → recovered", () => {
  it("marks a previously-skipped volume as recovered when now in kept", () => {
    const r = collectRecoveredVolumes(
      {
        skipped: [{ containerPath: "/usb", source: "/media/USB" }],
        aborted: [],
      },
      /* currentSkipped */ [],
      /* currentAborted */ [],
      /* kept */ { "/usb": "/media/USB" },
    );
    assert.deepEqual(r, [{ containerPath: "/usb", source: "/media/USB" }]);
  });

  it("does NOT mark as recovered if still in currentSkipped", () => {
    const r = collectRecoveredVolumes(
      {
        skipped: [{ containerPath: "/usb", source: "/media/USB" }],
        aborted: [],
      },
      /* currentSkipped */ [{ containerPath: "/usb", source: "/media/USB" }],
      /* currentAborted */ [],
      /* kept */ {},
    );
    assert.deepEqual(r, []);
  });

  it("does NOT mark as recovered if containerPath is no longer in kept", () => {
    // Edge case: user removed the volume entry entirely between calls.
    const r = collectRecoveredVolumes(
      {
        skipped: [{ containerPath: "/usb", source: "/media/USB" }],
        aborted: [],
      },
      [],
      [],
      { "/data": "/exists" }, // no /usb in this call
    );
    assert.deepEqual(r, []);
  });
});

describe("collectRecoveredVolumes — aborted → recovered", () => {
  it("marks a previously-aborted volume as recovered when now in kept", () => {
    const r = collectRecoveredVolumes(
      {
        skipped: [],
        aborted: [{ containerPath: "/certs", source: "/etc/certs" }],
      },
      [],
      [],
      { "/certs": "/etc/certs" },
    );
    assert.deepEqual(r, [{ containerPath: "/certs", source: "/etc/certs" }]);
  });

  it("does NOT mark as recovered if still in currentAborted", () => {
    const r = collectRecoveredVolumes(
      {
        skipped: [],
        aborted: [{ containerPath: "/certs", source: "/etc/certs" }],
      },
      [],
      [{ containerPath: "/certs", source: "/etc/certs" }],
      {},
    );
    assert.deepEqual(r, []);
  });
});

describe("collectRecoveredVolumes — mixed prior state", () => {
  it("recovers from both skipped and aborted in the same call", () => {
    const r = collectRecoveredVolumes(
      {
        skipped: [{ containerPath: "/usb", source: "/media/USB" }],
        aborted: [{ containerPath: "/certs", source: "/etc/certs" }],
      },
      [],
      [],
      { "/usb": "/media/USB", "/certs": "/etc/certs", "/data": "/exists" },
    );
    // Order: skipped first, then aborted (matches concat order in helper)
    assert.deepEqual(r, [
      { containerPath: "/usb", source: "/media/USB" },
      { containerPath: "/certs", source: "/etc/certs" },
    ]);
  });

  it("recovers only the ones that are now present, leaving still-missing ones in their state", () => {
    const r = collectRecoveredVolumes(
      {
        skipped: [
          { containerPath: "/usb", source: "/media/USB" },
          { containerPath: "/nfs", source: "/mnt/nfs" },
        ],
        aborted: [],
      },
      /* currentSkipped */ [{ containerPath: "/nfs", source: "/mnt/nfs" }],
      /* currentAborted */ [],
      /* kept */ { "/usb": "/media/USB" },
    );
    // /usb recovered; /nfs still missing.
    assert.deepEqual(r, [{ containerPath: "/usb", source: "/media/USB" }]);
  });
});
