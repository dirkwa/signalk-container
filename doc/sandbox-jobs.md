# Sandbox jobs

This branch implements the experimental `ContainerManagerApi.runSandboxJob`
proposed in [issue #314](https://github.com/dirkwa/signalk-container/issues/314).
It is not an upstream release and adds no integration to signalk-mcp.

## Consumer contract

Only trusted server plugins call this API. The consumer must choose and approve
the image and runner independently of submitted code. An image digest establishes
identity, not trust: an image containing a malicious supervisor or probe executable
is outside this boundary. Never pass Signal K tokens, credentials or arbitrary
caller-selected images to the sandbox.

```typescript
const result = await containers.runSandboxJob(
  {
    ownerPluginId: "my-plugin",
    image: approvedFullyQualifiedDigest,
    runnerPath: "/usr/local/bin/node",
    stdin: Buffer.from(submittedCode),
  },
  { signal: cancellationSignal },
);
```

The image must already be installed, have no declared volumes, contain trusted
Node at `/usr/local/bin/node`, and contain GNU coreutils **9.1** `/usr/bin/timeout`.
There is no image pull, shell interpolation, arbitrary create option, bind mount,
network option, persistent worker or dependency installation. The fixed runner
must wait for stdin before interpreting submitted code. Image environment values
are cleared; only fixed PATH, HOME and TMPDIR values are supplied.

The result includes a status, raw combined stdout/stderr bytes in observed frame
order, exit code and OOM evidence when available, and confirmed/pending cleanup.
Daemon errors are not forwarded. Exit 137 is reported as failure with OOM evidence,
not asserted to be a timeout: code can kill itself. `deadline-exceeded` means the
manager's observation budget expired, including possible daemon/transport delays.

## Limits

These originated as **initial design targets**, not measured throughput promises.
This implementation fixes these ceilings:

| Resource                    | Limit                                                                 |
| --------------------------- | --------------------------------------------------------------------- |
| Input, including code       | 1 MiB                                                                 |
| Combined output             | 256 KiB                                                               |
| Memory / swap               | 256 MiB / zero                                                        |
| CPU quota                   | 50,000 microseconds per 100,000 microseconds                          |
| Processes and threads       | 32                                                                    |
| Writable temporary storage  | 16 MiB tmpfs; shared-memory mount masked                              |
| Container deadline          | 15 seconds from supervisor start, including preflight                 |
| Setup / cleanup observation | 3 seconds each                                                        |
| Admission                   | One active job, no queue, six attempts per rolling minute per manager |

Busy requests are rejected without retaining code. Failed attempts count toward
admission. If removal is unconfirmed, the manager refuses further execution until
it can remove that container. Restarting the manager resets admission accounting.
Stopped orphan containers can be removed by the existing owner/namespace-scoped
`cleanupOrphanedJobs`; cleanup after restart is not the deadline mechanism.

## Isolation before input

The creation policy pins the local image ID, sets UID/GID 65534, drops all
capabilities, disables networking and restart, disables daemon-injected init,
uses a read-only root filesystem, and applies no-new-privileges plus an explicit
seccomp allowlist. The policy derives its unconditional syscall list from
[Moby's default profile](https://github.com/moby/profiles/blob/main/seccomp/default.json);
its [Apache license](licenses/sandbox-seccomp-LICENSE.txt) is included.
Tracing/process-memory access, namespace creation, io_uring and Internet sockets
are not granted. There are no capability-conditional grants.

Before writing input, Container Manager checks inspect data for the fixed launch
and mounts, then runs a separate trusted probe. The probe reads effective cgroup
v2 memory, swap, CPU and PID limits, effective UID/GID and capability sets,
NoNewPrivs and seccomp mode, mount flags and tmpfs size. It verifies supervisor
process files are hidden, root/shared-memory writes fail, non-loopback interfaces
are down, no IPv4 route exists, and an Internet socket attempt receives EPERM.
An inspect echo alone is insufficient. Missing controllers, unreadable evidence,
an incompatible image or runtime, or any mismatch prevents input release.

The execution stream parses Docker frames incrementally; a huge claimed frame
length cannot cause a matching allocation. Both streams share one byte budget.
Overflow, cancellation, malformed/truncated transport and plugin shutdown trigger
removal. A daemon failure may leave cleanup pending; it does not disable the
container's independent deadline.

## Crash-safe deadline

The container's PID 1 is the trusted command
`/usr/bin/timeout --signal=KILL 15s <runner>`. It owns the timer independently
of Signal K. There is no kill-after timer that a worker signal can reset.
`/proc/1` is masked read-only, tracing and cross-process memory syscalls are
denied, and the PID namespace is private. Namespace-init signal rules prevent a
descendant from stopping or killing PID 1 directly. When the supervisor exits,
Linux kills the remaining namespace processes, including detached descendants.

The supervisor and kernel/runtime are trusted. This is container isolation, not
a VM boundary or a hard real-time guarantee under a suspended/starved host.
Runtime pause, host shutdown or a privileged runtime administrator remain outside
the guarantee. Ordinary Signal K process death does not cancel the timer.
See [GNU timeout's implementation](https://github.com/coreutils/coreutils/blob/v9.1/src/timeout.c)
and [PID namespace init signal semantics](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html).

## Verification

Live verification on Docker Engine 29.8.0, Linux aarch64/cgroup v2 in Docker Desktop:

- Successful code execution and confirmed container removal.
- Network denial, read-only root, masked supervisor/shared-memory paths,
  tmpfs exhaustion, kernel OOM and process/thread ceiling.
- Output overflow, cancellation, missing memory enforcement withholding input,
  single-job admission, fresh filesystem state and cleanup recovery.
- Manual crash test: SIGKILL the submitting manager after stdin delivery while
  worker code attempts to stop/kill PID 1 and starts a detached busy child.
  Both processes stop with the container after approximately 15 seconds.

The trusted test image was
`docker.io/library/node@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54`.
It is test evidence, not an automatically installed production image.

```sh
npm run build
SANDBOX_TEST_IMAGE=<local-approved-digest> node --test dist/test/integration/sandbox.test.js
SANDBOX_TEST_IMAGE=<local-approved-digest> node dist/scripts/tests/verify-sandbox-deadline.js
```

Portable tests cover policy, framing, admission, cancellation and late creation.
The integration suite requires explicit image opt-in and a detected runtime.
The deadline test is a manual script because it deliberately waits for the full
15-second deadline and kills its submitting process.

Podman, x86-64 and a physical Raspberry Pi have not been live-verified here.
Cgroup v1, absent swap/memory controllers, ignored compat-API security settings,
other coreutils versions and missing probe dependencies fail closed. There is
no claim of release, deployment, upstream acceptance or signalk-mcp execution.
