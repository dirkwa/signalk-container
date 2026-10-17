import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findOrphans, type OrphanCheckInput } from "../orphans.js";

function input(overrides: Partial<OrphanCheckInput> = {}): OrphanCheckInput {
  return {
    owners: new Map([
      ["whisper", "signalk-wyoming"],
      ["mayara-server", "mayara-server-signalk-plugin"],
    ]),
    present: ["whisper", "mayara-server"],
    installedPluginIds: new Set(["mayara-server-signalk-plugin"]),
    claimed: new Set(),
    packageInstalled: () => false,
    ...overrides,
  };
}

describe("findOrphans", () => {
  it("flags a container whose recorded owner is not installed", () => {
    assert.deepEqual(findOrphans(input()), [
      { name: "whisper", owner: "signalk-wyoming" },
    ]);
  });

  it("flags nothing when the server cannot list its plugins", () => {
    assert.deepEqual(findOrphans(input({ installedPluginIds: null })), []);
  });

  it("flags nothing when the plugin list is empty", () => {
    // An empty list says nothing about what is installed; trusting it would
    // flag every container.
    assert.deepEqual(findOrphans(input({ installedPluginIds: new Set() })), []);
  });

  it("leaves a container with no recorded owner alone", () => {
    assert.deepEqual(findOrphans(input({ present: ["questdb"] })), []);
  });

  it("leaves a container its owner brought up this session alone", () => {
    assert.deepEqual(findOrphans(input({ claimed: new Set(["whisper"]) })), []);
  });

  it("treats an owner recorded by package name as installed", () => {
    assert.deepEqual(
      findOrphans(
        input({ packageInstalled: (name) => name === "signalk-wyoming" }),
      ),
      [],
    );
  });

  it("only considers containers that are on the runtime", () => {
    assert.deepEqual(findOrphans(input({ present: ["mayara-server"] })), []);
  });
});
