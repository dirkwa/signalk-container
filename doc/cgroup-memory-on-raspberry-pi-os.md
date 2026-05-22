# Enabling the memory cgroup controller on Raspberry Pi OS

## Why this matters

On a Raspberry Pi 4 or 5 running Raspberry Pi OS Trixie (Debian 13 base, and likely earlier Pi OS releases), the GPU firmware injects `cgroup_disable=memory` into the kernel boot cmdline. That disables the **memory cgroup controller** at the kernel level — before `systemd` even starts.

Consequence for signalk-container: every consumer plugin that requests a memory limit (e.g. `memory: '1g'`) gets that limit **silently dropped**, because the controller systemd would otherwise delegate doesn't exist on this kernel. The container runs with no memory cap; on a Pi 5 with a busy kopia + rclone backup or a memory-hungry chart provider, that can OOM-kill the entire SK process.

This page is the operator's fix.

## Diagnose

```bash
grep -o "cgroup_disable=memory" /proc/cmdline
# Prints "cgroup_disable=memory" → you're hit.
# Empty output → not this case; see signalk-container's README "Cgroup
# controller delegation" section for the systemd-Delegate= fix instead.
```

The signalk-container `/api/doctor/deployment` endpoint flags this case automatically with `status: cgroup-controllers-incomplete` and surfaces these same commands in its `remediation` array.

## Fix

The kernel evaluates cmdline tokens left-to-right; **a later token wins**. Append `cgroup_enable=memory cgroup_memory=1` to `/boot/firmware/cmdline.txt` so it sits _after_ the firmware-injected `cgroup_disable=memory`.

```bash
sudo cp /boot/firmware/cmdline.txt /boot/firmware/cmdline.txt.bak.$(date +%Y%m%d)
sudo sed -i 's/$/ cgroup_enable=memory cgroup_memory=1/' /boot/firmware/cmdline.txt
```

> [!important]
> `/boot/firmware/cmdline.txt` MUST remain a single line. Verify:
>
> ```bash
> sudo wc -l /boot/firmware/cmdline.txt        # 0 (no trailing newline is fine, > 1 line is broken)
> sudo cat /boot/firmware/cmdline.txt          # eyeball the appended tokens
> ```

Reboot for the kernel to re-parse the cmdline:

```bash
sudo reboot
```

## Verify after reboot

```bash
grep -oE "cgroup_enable=memory|cgroup_disable=memory" /proc/cmdline
# Both tokens appear — that's expected; the later cgroup_enable wins.

cat /sys/fs/cgroup/cgroup.controllers
# Output must include "memory":
#   cpuset cpu io memory pids
```

Then check that the SK container sees it too:

```bash
podman exec <sk-container> cat /sys/fs/cgroup/cgroup.controllers
# or: docker exec <sk-container> cat /sys/fs/cgroup/cgroup.controllers
# Should match the host view — memory present.
```

## If memory is still missing after reboot

The kernel side is fixed but you may also need the systemd Delegate= snippet so the controller actually reaches the user slice the SK container runs in:

```bash
sudo mkdir -p /etc/systemd/system/user@.service.d
sudo tee /etc/systemd/system/user@.service.d/delegate.conf <<'EOF'
[Service]
Delegate=cpu cpuset io memory pids
EOF
sudo systemctl daemon-reload
```

Then log the SK-owning user out and back in (or reboot once more). This is the same systemd snippet described in signalk-container's main README under "Cgroup controller delegation" — both layers (kernel + user-slice delegation) need to be in place on Pi OS.

## Revert

If you ever need to roll back:

```bash
sudo cp /boot/firmware/cmdline.txt.bak.<your-date> /boot/firmware/cmdline.txt
sudo reboot
```

## Related

- signalk-container README: `Cgroup controller delegation` — generic systemd-Delegate= fix and the broader rationale
- signalk-container `/api/doctor/deployment` — runtime detection of both the kernel-disabled-memory case and the missing-systemd-delegation case, with the right remediation surfaced for each
