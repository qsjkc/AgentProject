import unittest
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
