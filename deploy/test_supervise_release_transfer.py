import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import supervise_release_transfer as transfer


SHA = "a" * 40
ARCHIVE = "server-images.tar.gz"
INSTALLER = "Detachym-1.1.0-rc.52-x64.exe"
DESTINATION = f"deploy-target:/release dir/data/downloads/.{INSTALLER}.{SHA}.upload"


def sample(size, identity="20:123", modified="now"):
    return transfer.Observation(identity, size, modified)


class RemoteObservationTests(unittest.TestCase):
    def test_only_known_staging_paths_are_observed(self):
        archive_target = f"/srv/releases/.server-images-{SHA}/"
        self.assertEqual(transfer.staged_target("deploy-target:" + archive_target,
                                               [ARCHIVE, "server-images.json"]), archive_target + ARCHIVE)
        self.assertEqual(transfer.staged_target(DESTINATION, [INSTALLER]), DESTINATION.split(":", 1)[1])
        self.assertIsNone(transfer.staged_target(DESTINATION.replace("deploy-target", "alternate"), [INSTALLER]))
        self.assertIsNone(transfer.staged_target("deploy-target:/release/data/downloads/" + INSTALLER, [INSTALLER]))
        self.assertIsNone(transfer.staged_target("deploy-target:" + archive_target, ["server-images.json", ARCHIVE]))

    def test_stat_is_bounded_read_only_and_keeps_the_exact_quoted_path(self):
        path = f"/path with 'quotes'/{ARCHIVE}"
        with patch.object(transfer.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, stdout="20:123 512 2026-11-22 01:02:03.123456789 +0000\n")) as run:
            self.assertEqual(transfer.remote_progress(path), sample(512, modified="2026-11-22 01:02:03.123456789 +0000"))
        argv = run.call_args.args[0]
        self.assertEqual(argv[:-1], ["ssh", "-n", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "deploy-target"])
        self.assertTrue(argv[-1].startswith(f"target={shlex.quote(path)}; "))
        self.assertIn('stat -c "%d:%i %s %y" -- "$target"', argv[-1])
        self.assertEqual(run.call_args.kwargs["timeout"], 6)

    def test_ssh_and_stat_failures_supply_no_observation(self):
        for status, data, expected in ((0, "absent\n", transfer.ABSENT), (255, "", None),
                                       (0, "unexpected stdout\n", None), (0, "20:123 -1 old\n", None)):
            with self.subTest(status=status, data=data), patch.object(transfer.subprocess, "run", return_value=
                    subprocess.CompletedProcess([], status, stdout=data)):
                self.assertEqual(transfer.remote_progress("/isolated"), expected)
        for problem in (OSError(), subprocess.TimeoutExpired("ssh", 6)):
            with self.subTest(error=type(problem).__name__), patch.object(transfer.subprocess, "run", side_effect=problem):
                self.assertIsNone(transfer.remote_progress("/isolated"))


class SimulatedTransfer:
    def __init__(self, completes_at):
        self.completes_at = completes_at
        self.now = 0

    def wait(self, timeout):
        if self.now + timeout >= self.completes_at:
            self.now = self.completes_at
            return 0
        self.now += timeout
        raise subprocess.TimeoutExpired("scp", timeout)

    def poll(self):
        return 0 if self.now >= self.completes_at else None


class ProgressPolicyTests(unittest.TestCase):
    def observe(self, observations, *, completes_at=720, baseline=transfer.ABSENT):
        process = SimulatedTransfer(completes_at)
        with (patch.object(transfer.time, "monotonic", side_effect=lambda: process.now),
              patch.object(transfer, "remote_progress", side_effect=observations) as progress,
              patch.object(transfer, "stop_owned_transfer", return_value=True) as stop):
            result = transfer.stop_if_slow(process, "/isolated upload", 287_806_000, baseline, 0)
            return result, process.now, progress.call_count, stop.call_count

    def test_healthy_transfer_does_not_wait_for_a_progress_probe(self):
        self.assertEqual(self.observe([], completes_at=90), (False, 90, 0, 0))

    def test_rc47_upper_bound_trickle_can_stop_only_after_two_windows(self):
        self.assertEqual(self.observe([sample(0), sample(2_350_080), sample(5_744_640)]), (True, 240, 3, 1))

    def test_a_single_slow_window_and_recovery_do_not_cancel(self):
        self.assertEqual(self.observe([sample(20_000_000), sample(20_010_000), sample(50_000_000)],
                                      completes_at=250), (False, 250, 3, 0))

    def test_unknown_stale_truncated_or_replaced_sample_defers_to_hard_cap(self):
        self.assertEqual(self.observe([], baseline=None), (False, 0, 0, 0))
        self.assertEqual(self.observe([sample(50)], baseline=sample(50)), (False, 120, 1, 0))
        for invalid in (None, transfer.ABSENT, sample(19), sample(25, identity="20:456")):
            with self.subTest(invalid=invalid):
                self.assertEqual(self.observe([sample(20), sample(21), invalid]), (False, 240, 3, 0))

    def test_full_size_and_deadline_delays_preserve_actual_scp_result(self):
        self.assertEqual(self.observe([sample(287_806_000)]), (False, 120, 1, 0))
        for code, expected in ((0, 0), (1, 1), (124, 124), (137, 137), (-9, 137), (-15, 143)):
            with self.subTest(code=code):
                self.assertEqual(transfer.shell_status(code), expected)


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("timeout"), "GNU timeout on Linux is required")
class LocalTransferProcessTests(unittest.TestCase):
    def test_slow_abort_reaps_only_its_writer_and_preserves_partial_file(self):
        with tempfile.TemporaryDirectory(prefix="detachym-transfer-test-") as temporary:
            path = Path(temporary) / "partial"
            writer = """import os, sys, time
from pathlib import Path
path = Path(sys.argv[1])
with path.open('wb', buffering=0) as staged:
    path.with_suffix('.pid').write_text(str(os.getpid()))
    while True:
        staged.write(b'x' * 512)
        time.sleep(.1)
"""
            with subprocess.Popen(["timeout", "--kill-after=1s", "6s", sys.executable, "-B", "-c", writer, str(path)],
                                  start_new_session=True) as owned, subprocess.Popen(
                                      [sys.executable, "-B", "-c", "import time; time.sleep(10)"],
                                      start_new_session=True) as untouched:
                started = time.monotonic()
                try:
                    with patch.object(transfer, "remote_progress", side_effect=lambda _: sample(path.stat().st_size)):
                        self.assertTrue(transfer.stop_if_slow(owned, str(path), 1024 * 1024, transfer.ABSENT, started,
                                                             deadline=6, warmup=0.3, interval=0.2))
                    self.assertLess(time.monotonic() - started, 5)
                    self.assertIsNotNone(owned.poll())
                    self.assertIsNone(untouched.poll())
                    self.assertLess(path.stat().st_size, 1024 * 1024)
                    pid = int(path.with_suffix(".pid").read_text())
                    self.assertFalse(Path(f"/proc/{pid}").exists(), "SCP writer was not reaped")
                finally:
                    transfer.stop_owned_transfer(owned)
                    untouched.terminate()
                    untouched.wait(timeout=2)

    def test_missing_stat_keeps_the_real_hard_timeout(self):
        with subprocess.Popen(["timeout", "--kill-after=1s", "0.3s", sys.executable, "-B", "-c", "import time; time.sleep(4)"],
                              start_new_session=True) as owned:
            self.assertFalse(transfer.stop_if_slow(owned, "/isolated", 50, None, time.monotonic()))
            self.assertEqual(owned.wait(timeout=2), 124)

    def test_canceling_supervisor_stops_its_scp_process_and_preserves_argv(self):
        with tempfile.TemporaryDirectory(prefix="detachym-transfer-cancel-") as temporary:
            folder = Path(temporary)
            source = folder / INSTALLER
            source.write_bytes(b"isolated transfer source")
            for name, script in (("ssh", "printf 'absent\\n'"), ("scp", r'''
printf '%s\0' "$@" > "$TRANSFER_ARGS"
printf 'partial fixture' > "$TRANSFER_PARTIAL"
printf '%s' "$$" > "$TRANSFER_PID"
exec sleep 10
''')):
                executable = folder / name
                executable.write_text("#!/bin/sh\n" + script + "\n")
                executable.chmod(0o700)
            pid_file = folder / "child-pid"
            env = {**os.environ, "PATH": f"{folder}{os.pathsep}{os.environ['PATH']}",
                   "TRANSFER_ARGS": str(folder / "argv"), "TRANSFER_PARTIAL": str(folder / "partial"),
                   "TRANSFER_PID": str(pid_file)}
            with subprocess.Popen([sys.executable, "-B", transfer.__file__, DESTINATION, str(source)], env=env) as parent:
                try:
                    ready_by = time.monotonic() + 2
                    while not pid_file.exists() and time.monotonic() < ready_by:
                        time.sleep(.02)
                    child = int(pid_file.read_text())
                    parent.terminate()
                    self.assertEqual(parent.wait(timeout=3), 143)
                    self.assertFalse(Path(f"/proc/{child}").exists(), "SCP process survived cancellation")
                    self.assertEqual((folder / "partial").read_bytes(), b"partial fixture")
                    self.assertEqual((folder / "argv").read_bytes().decode().split("\0"),
                                     ["-B", "--", str(source), DESTINATION, ""])
                finally:
                    if parent.poll() is None:
                        parent.terminate()
                        parent.wait(timeout=3)


class TransferWrapperTests(unittest.TestCase):
    def test_large_path_forwards_exact_arguments_and_keeps_exit_statuses(self):
        bash = shutil.which("bash")
        if os.name == "nt" and shutil.which("git"):
            git_bash = Path(shutil.which("git")).resolve().parents[1] / "bin/bash.exe"
            if git_bash.is_file():
                bash = str(git_bash)
        if not bash:
            self.skipTest("Bash is required to execute deployment guards")
        wrapper = Path(__file__).with_name("transfer_release_files.sh").resolve()
        script = r'''
python3() { printf '%s\0' "$@" > "$TEST_LOG"; return "$TEST_EXIT"; }
ssh() { exit 99; }
scp() { exit 99; }
timeout() { exit 99; }
export -f python3 ssh scp timeout
bash --noprofile --norc "$TRANSFER_WRAPPER" 12m "$TEST_DESTINATION" "$TEST_FILE"
'''
        with tempfile.TemporaryDirectory(prefix="detachym-transfer-wrapper-") as temporary:
            folder = Path(temporary) / "artifact dir"
            folder.mkdir()
            source = folder / INSTALLER
            with source.open("wb") as stream:
                stream.truncate(32 * 1024 * 1024)
            log = folder / "arguments"
            for code, hint in ((0, "SSH transfer finished"), (1, "failed (exit 1)"),
                               (75, "sustained slow progress"), (124, "exceeded its 12m limit"),
                               (137, "exceeded its 12m limit")):
                with self.subTest(code=code):
                    result = subprocess.run([bash, "--noprofile", "--norc"], input=script,
                                            env={**os.environ, "TEST_LOG": log.as_posix(), "TEST_FILE": source.as_posix(),
                                                 "TRANSFER_WRAPPER": wrapper.as_posix(), "TEST_EXIT": str(code),
                                                 "TEST_DESTINATION": DESTINATION}, text=True, capture_output=True, timeout=10)
                    self.assertEqual(result.returncode, code, result.stderr)
                    self.assertIn(hint, result.stdout + result.stderr)
                    if code:
                        self.assertIn("Service switch has not started. Rerun Deploy Server", result.stderr)
                    self.assertEqual(log.read_bytes().decode().split("\0"),
                                     ["-B", wrapper.with_name("supervise_release_transfer.py").as_posix(),
                                      DESTINATION, source.as_posix(), ""])


if __name__ == "__main__":
    unittest.main()
