/** Native syscall fixture: targets only container PID 1 and its own disposable child. */
export function sandboxMemoryProbe(denied: boolean): string {
  return String.raw`
import ctypes as c
import errno
import json
import os
import signal

denied = __DENIED__
libc = c.CDLL(None, use_errno=True)
libc.ptrace.argtypes = [c.c_ulong, c.c_ulong, c.c_void_p, c.c_void_p]
libc.ptrace.restype = c.c_long
class IOVec(c.Structure):
    _fields_ = [("base", c.c_void_p), ("length", c.c_size_t)]
for name in ("process_vm_readv", "process_vm_writev"):
    fn = getattr(libc, name)
    fn.argtypes = [c.c_int, c.POINTER(IOVec), c.c_ulong,
                   c.POINTER(IOVec), c.c_ulong, c.c_ulong]
    fn.restype = c.c_ssize_t
marker = c.create_string_buffer(b"private-marker")
size = c.sizeof(marker)
release_r, release_w = os.pipe()
report_r, report_w = os.pipe()
child = os.fork()
if child == 0:
    os.close(release_w)
    os.close(report_r)
    os.read(release_r, 1)
    os.write(report_w, marker.raw)
    os._exit(0)
os.close(release_r)
os.close(report_w)
results = {}
try:
    targets = [("child", child)] + ([("supervisor", 1)] if denied else [])
    for label, pid in targets:
        os.kill(pid, 0)
        for name, operation in (("ptrace_attach", 16), ("ptrace_seize", 0x4206)):
            c.set_errno(0)
            rc = libc.ptrace(operation, pid, None, None)
            error = c.get_errno()
            results[label + "." + name] = {"result": rc, "errno": error}
            if denied:
                assert (rc, error) == (-1, errno.EPERM), results
            else:
                assert rc == 0, results
                if operation == 0x4206:
                    assert libc.ptrace(0x4207, pid, None, None) == 0
                os.waitpid(pid, 0)
                assert libc.ptrace(17, pid, None, None) == 0
        for name in ("process_vm_readv", "process_vm_writev"):
            local_buffer = c.create_string_buffer(size)
            if name == "process_vm_writev":
                local_buffer.value = b"changed-marker"
            local = IOVec(c.addressof(local_buffer), size)
            remote = IOVec(c.addressof(marker), size)
            c.set_errno(0)
            rc = getattr(libc, name)(pid, c.byref(local), 1, c.byref(remote), 1, 0)
            error = c.get_errno()
            results[label + "." + name] = {"result": rc, "errno": error}
            if denied:
                assert (rc, error) == (-1, errno.EPERM), results
            else:
                assert rc == size, results
                if name == "process_vm_readv":
                    assert local_buffer.raw == marker.raw
    os.write(release_w, b"x")
    observed = os.read(report_r, size)
    expected = b"private-marker" if denied else b"changed-marker"
    assert observed.rstrip(b"\0") == expected, observed
    os.waitpid(child, 0)
    child = None
    results["childMemory"] = observed.rstrip(b"\0").decode()
    print(json.dumps(results))
finally:
    if child is not None:
        os.kill(child, signal.SIGKILL)
        os.waitpid(child, 0)
`.replace("__DENIED__", denied ? "True" : "False");
}
