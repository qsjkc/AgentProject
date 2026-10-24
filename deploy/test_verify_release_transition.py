import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from verify_release_transition import migration_revisions, verify_transition, version_key


class ReleaseTransitionTests(unittest.TestCase):
    def test_rejects_the_accidental_main_downgrade(self):
        with self.assertRaisesRegex(ValueError, "downgrade"):
            verify_transition({"version": "1.1.0-rc.1", "revisions": ["014"]}, "1.0.0", {"006"})

    def test_version_bump_cannot_hide_missing_migration(self):
        with self.assertRaisesRegex(ValueError, "014"):
            verify_transition({"version": "1.1.0-rc.1", "revisions": ["014"]}, "1.1.0-rc.2", {"006"})

    def test_current_candidate_can_follow_live_release(self):
        revisions = migration_revisions(Path(__file__).resolve().parents[1] / "backend/alembic/versions")
        result = verify_transition({"version": "1.1.0-rc.1", "revisions": ["014"]}, "1.1.0-rc.2", revisions)
        self.assertEqual(result["status"], "passed")

    def test_missing_runtime_state_fails_closed(self):
        for revisions in (None, [], [None], "014"):
            with self.assertRaises(ValueError):
                verify_transition({"version": "1.1.0-rc.1", "revisions": revisions}, "1.1.0-rc.2", {"014"})

    def test_version_order_and_legacy_name(self):
        self.assertLess(version_key("DetachymAgentPet1.0"), version_key("1.1.0-rc.1"))
        self.assertLess(version_key("1.1.0-rc.2"), version_key("1.1.0-rc.10"))
        self.assertLess(version_key("1.1.0-rc.10"), version_key("1.1.0"))
        with self.assertRaises(ValueError):
            version_key("unknown")


class DeploymentSourceGuardTests(unittest.TestCase):
    SOURCE_EXPRESSION = "${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || github.sha }}"
    # Public commit IDs can coincidentally contain a short secret such as a port.
    SOURCE_SHA = "a" * 18 + "22" + "a" * 20
    OTHER_SHA = "b" * 40

    @classmethod
    def setUpClass(cls):
        cls.workflow = (Path(__file__).resolve().parents[1] / ".github/workflows/cd.yml").read_text(encoding="utf-8")
        cls.bash = shutil.which("bash")
        if os.name == "nt" and shutil.which("git"):
            git_bash = Path(shutil.which("git")).resolve().parents[1] / "bin/bash.exe"
            if git_bash.is_file():
                cls.bash = str(git_bash)

    def run_block(self, name):
        match = re.search(
            rf"      - name: {re.escape(name)}\n.*?        run: \|\n((?:          [^\n]*\n|\n)+)",
            self.workflow,
            re.DOTALL,
        )
        self.assertIsNotNone(match, name)
        return textwrap.dedent(match.group(1))

    def execute_guard(self, name, **changes):
        if not self.bash:
            self.skipTest("Bash is required to execute deployment guards")
        env = {
            **os.environ,
            "EVENT_NAME": "workflow_run", "INPUT_REF": "main", "GITHUB_REF": "refs/heads/main",
            "WORKFLOW_SHA": self.SOURCE_SHA, "WORKFLOW_BRANCH": "main", "WORKFLOW_EVENT": "push",
            "GITHUB_SHA": self.OTHER_SHA, "GITHUB_REPOSITORY": "test/project",
            "TEST_MAIN_SHA": self.SOURCE_SHA, "TEST_SUCCESSFUL_CI": "1",
            "SERVER_PORT_SECRET": "22",
            "DOCKER_USERNAME": "", "DOCKER_PASSWORD": "", "SERVER_HOST": "",
            "SERVER_USERNAME": "", "SERVER_PASSWORD": "", "SERVER_SSH_KEY": "",
            **changes,
        }
        # Resolve the event expression whose exact use at every consumer is
        # checked below, including a workflow_run whose github.sha is different.
        source = (env["WORKFLOW_SHA"] if env["EVENT_NAME"] == "workflow_run" else "") or env["GITHUB_SHA"]
        env["TEST_CHECKOUT_SHA"] = source
        env["DEPLOY_SOURCE_SHA"] = source
        mocks = '''
git() { printf '%s\\n' "$TEST_CHECKOUT_SHA"; }
gh() {
  case "$*" in
    *'/git/ref/heads/main'*) printf '%s\\n' "$TEST_MAIN_SHA" ;;
    *'/actions/workflows/ci.yml/runs'*) printf '%s\\n' "$TEST_SUCCESSFUL_CI" ;;
    *) return 2 ;;
  esac
}
'''
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "outputs"
            env["GITHUB_OUTPUT"] = output.as_posix()
            result = subprocess.run([self.bash, "--noprofile", "--norc"], input=mocks + self.run_block(name),
                                    text=True, capture_output=True, env=env, timeout=10)
            outputs = output.read_text(encoding="utf-8") if output.exists() else ""
        return result, outputs

    def test_every_checkout_and_provenance_binding_uses_the_same_immutable_event_sha(self):
        checkouts = re.findall(r"uses: actions/checkout@v4\n\s+with:\n(?:\s+#[^\n]*\n)*\s+ref: ([^\n]+)", self.workflow)
        self.assertEqual(checkouts, [self.SOURCE_EXPRESSION] * 4)
        bindings = re.findall(r"(?:EXPECTED_SOURCE_SHA|DEPLOY_SOURCE_SHA): ([^\n]+)", self.workflow)
        self.assertEqual(bindings, [self.SOURCE_EXPRESSION] * 2)
        self.assertNotIn("outputs.deploy_ref", self.workflow)
        self.assertNotIn('echo "deploy_ref=', self.workflow)
        preflight_guard = re.search(r"  preflight:\n    name: Preflight\n    if: ([^\n]+)", self.workflow)
        self.assertIsNotNone(preflight_guard)
        self.assertEqual(preflight_guard.group(1),
                         "github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'")

    def test_successful_auto_and_manual_events_emit_only_boolean_flags(self):
        cases = ({}, {"WORKFLOW_EVENT": "workflow_dispatch"},
                 {"EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": self.SOURCE_SHA,
                      "WORKFLOW_SHA": self.OTHER_SHA})
        for changes in cases:
            with self.subTest(changes=changes):
                result, outputs = self.execute_guard("Resolve deployment variables", **changes)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(set(outputs.splitlines()), {"docker_enabled=false", "server_enabled=false"})

    def test_preflight_rejects_stale_sha_wrong_branch_events_and_unverified_manual_ci(self):
        cases = (
            {"TEST_MAIN_SHA": self.OTHER_SHA},
            {"WORKFLOW_SHA": self.OTHER_SHA},
            {"WORKFLOW_BRANCH": "feature"},
            {"WORKFLOW_EVENT": "pull_request"},
            {"EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": self.OTHER_SHA},
            {"EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": self.SOURCE_SHA, "INPUT_REF": "feature"},
            {"EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": self.SOURCE_SHA, "GITHUB_REF": "refs/heads/feature"},
            {"EVENT_NAME": "workflow_dispatch", "GITHUB_SHA": self.SOURCE_SHA, "TEST_SUCCESSFUL_CI": "0"},
        )
        for changes in cases:
            with self.subTest(changes=changes):
                result, outputs = self.execute_guard("Resolve deployment variables", **changes)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(outputs, "")

    def test_main_is_rechecked_before_remote_mutations(self):
        result, _ = self.execute_guard("Recheck main before remote changes")
        self.assertEqual(result.returncode, 0, result.stderr)
        result, _ = self.execute_guard("Recheck main before remote changes", TEST_MAIN_SHA=self.OTHER_SHA)
        self.assertNotEqual(result.returncode, 0)
        self.assertLess(self.workflow.index("- name: Recheck main before remote changes"),
                        self.workflow.index("- name: Prepare remote directories"))


if __name__ == "__main__":
    unittest.main()
