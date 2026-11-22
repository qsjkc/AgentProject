"""Watch large release transfers without changing SCP or the hard deadline."""

import os
from pathlib import Path, PurePosixPath
import re
import shlex
import signal
import subprocess
import sys
import time
from typing import NamedTuple


DEADLINE_SECONDS = 12 * 60
WARMUP_SECONDS = 2 * 60
SAMPLE_INTERVAL_SECONDS = 60
SSH_PROBE_TIMEOUT = 6
SLOW_TRANSFER = 75


class Observation(NamedTuple):
    identity: str
    size: int
    modified: str


ABSENT = Observation("", 0, "")


def staged_target(destination, sources):
    host, _, remote = destination.partition(":")
    if host != "deploy-target" or not remote.startswith("/"):
        return None
    names = [Path(source).name for source in sources]
    leaf = PurePosixPath(remote).name
    if (remote.endswith("/") and re.fullmatch(r"\.server-images-[a-f0-9]{40}", leaf)
            and names == ["server-images.tar.gz", "server-images.json"]):
        return remote + names[0]
    if (len(names) == 1 and names[0].endswith("-x64.exe")
            and re.fullmatch(rf"\.{re.escape(names[0])}\.[a-f0-9]{{40}}\.upload", leaf)):
        return remote
    return None


def remote_progress(path):
    command = (
        f"target={shlex.quote(path)}; "
        'if [ -L "$target" ]; then exit 2; '
        'elif [ -f "$target" ]; then LC_ALL=C stat -c "%d:%i %s %y" -- "$target"; '
        'elif [ ! -e "$target" ] && [ -x "${target%/*}" ]; then printf "absent\\n"; '
        'else exit 2; fi'
    )
    try:
        result = subprocess.run(
            ["ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "deploy-target", command],
            capture_output=True, text=True, timeout=SSH_PROBE_TIMEOUT, check=False,
        )
    except (OSError, subprocess.TimeoutExpired, UnicodeError):
        return None
    if result.returncode != 0:
        return None
    observed = result.stdout.strip()
    if observed == "absent":
        return ABSENT
    match = re.fullmatch(r"([0-9]+:[0-9]+) ([0-9]+) ([^\r\n]+)", observed)
    return Observation(match[1], int(match[2]), match[3]) if match else None


def stop_owned_transfer(transfer):
    # The timeout wrapper and SCP share a session created for this upload alone.
    if transfer.poll() is not None:
        return False
    try:
        os.killpg(transfer.pid, signal.SIGTERM)
    except ProcessLookupError:
        return False
    try:
        transfer.wait(timeout=15)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(transfer.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        transfer.wait()
    return True


def stop_if_slow(transfer, path, size, baseline, started, *,
                 deadline=DEADLINE_SECONDS, warmup=WARMUP_SECONDS, interval=SAMPLE_INTERVAL_SECONDS):
    if baseline is None:
        return False
    previous = None
    previous_time = started
    slow_windows = 0
    limit = started + deadline
    next_sample = started + warmup
    while next_sample < limit:
        try:
            transfer.wait(timeout=max(0, next_sample - time.monotonic()))
            return False
        except subprocess.TimeoutExpired:
            pass
        sample = remote_progress(path)
        now = time.monotonic()
        if transfer.poll() is not None or now >= limit:
            return False
        if (sample is None or not sample.identity or sample == baseline or
                (previous and (sample.identity != previous.identity or sample.size < previous.size))):
            print("Fresh SSH staging progress cannot be established; keeping the original deadline.", flush=True)
            return False
        if sample.size >= size:
            return False
        if previous is not None:
            actual = (sample.size - previous.size) / (now - previous_time)
            required = (size - sample.size) / (limit - now)
            print(f"SSH staging: {sample.size}/{size} bytes, {actual:.0f} B/s observed, "
                  f"{required:.0f} B/s needed by the deadline.", flush=True)
            slow_windows = slow_windows + 1 if actual * 4 < required else 0
            if slow_windows >= 2:
                return stop_owned_transfer(transfer)
        previous, previous_time = sample, now
        next_sample = now + interval
    return False


def shell_status(code):
    return 128 - code if code < 0 else code


class TransferInterrupted(Exception):
    pass


def main(destination, sources):
    command = ["timeout", "--kill-after=15s", "12m", "scp", "-B", "--", *sources, destination]
    path = staged_target(destination, sources)
    if os.name != "posix":
        return shell_status(subprocess.call(command))
    if path is None:
        os.execvp(command[0], command)

    transfer = None
    interrupted = None

    def interrupt(number, _frame):
        nonlocal interrupted
        interrupted = number
        if transfer is not None:
            raise TransferInterrupted

    for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(number, interrupt)
    try:
        size = Path(sources[0]).stat().st_size
        baseline = remote_progress(path)
        if interrupted is not None:
            return 128 + interrupted
        started = time.monotonic()
        transfer = subprocess.Popen(command, start_new_session=True)
        if interrupted is not None:
            return 128 + interrupted
        if stop_if_slow(transfer, path, size, baseline, started):
            return SLOW_TRANSFER
        return shell_status(transfer.wait())
    except TransferInterrupted:
        return 128 + interrupted
    finally:
        if transfer is not None:
            # Further cancellation signals should not interrupt the cleanup wait.
            for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(number, signal.SIG_IGN)
            stop_owned_transfer(transfer)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))
