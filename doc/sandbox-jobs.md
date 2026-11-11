# Sandbox job implementation

The sandbox work tracks [issue #314](https://github.com/dirkwa/signalk-container/issues/314).
It is an internal implementation foundation. There is no public
`runSandboxJob` method and no executable sandbox yet.

## Implemented

`src/sandbox.ts` prepares an inert container creation plan after checking a
locally installed, digest-pinned image. Preparation never pulls images, creates
containers, or executes code. Image provisioning remains a separate trusted
administrative step.

The request accepts only owner plugin ID, fully qualified image digest, fixed
runner executable path and input bytes. The trusted consumer chooses the image
and runner; these are not fields to expose to untrusted MCP clients. Images with
declared volumes are rejected, and creation uses the resolved image ID. Input is
copied before asynchronous work and never placed in commands, labels or
environment variables.

The fixed plan requests disabled networking, no host mounts/devices, non-root
UID/GID 65534, dropped capabilities, no-new-privileges, private IPC/default private
PID namespace, read-only root, disabled image healthchecks and daemon logging,
no restart, and CPU/memory/process limits. It requests a 16 MiB temporary
filesystem at `/tmp` and separately caps shared memory at 16 MiB. Both count
towards the 256 MiB memory limit. The image must support this fixed user and
runner contract.

`SandboxOutput` accumulates already-demultiplexed output under a single combined
stdout/stderr byte ceiling, without line buffering. Overflow is terminal and
returns false; a future executor must terminate the job when that happens.
Raw protocol framing must also be bounded before demultiplexing.

The ceilings are initial design targets: 1 MiB input, 256 KiB output, 256 MiB
memory with no swap, 0.5 CPU, 32 processes/threads and a proposed 15-second
execution deadline. These are not runtime measurements.

## Required before execution can be exposed

- A versioned trusted worker protocol, including bounded readiness and input
  transfer. No untrusted code can run before verification.
- Capability preflight and verification of the effective filesystem, network,
  namespaces, user, capabilities and seccomp policy. The plan deliberately does
  not claim that requesting flags proves enforcement. Runtime-default seccomp
  must be verified or replaced with a reviewed enforced profile; unconfined
  operation must be refused.
- Live cgroup and process-limit probes for supported runtime versions, including
  refusal when controls are absent or cannot be verified. Inspect echoes alone
  are insufficient.
- A hard deadline that survives Signal K failure and cannot be disabled by the
  submitted code. No ordinary `runJob` fallback.
- Bounded transport, admission/queue limits, cancellation and typed outcomes,
  including uncertain termination/cleanup. Collect exit/OOM evidence before
  removing containers; never retry execution automatically.
- Namespace/owner-scoped cleanup and tested crash recovery.
- Real Docker and rootless Podman tests with synthetic workloads, including
  network/file access denial, resource exhaustion and cross-job isolation.

The existing `runJob` API is unchanged. Unit tests establish request validation,
creation-plan intent and output bounds only. They do not establish a working
container isolation boundary.
