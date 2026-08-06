import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "skills" / "track-project-progress" / "scripts" / "progress.py"
SPEC = importlib.util.spec_from_file_location("progress", SCRIPT)
progress = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = progress
SPEC.loader.exec_module(progress)


def sample_ledger():
    return {
        "schema_version": 1,
        "project": {
            "name": "Example",
            "goal": "Ship the requested behavior",
            "done_definition": "Acceptance test passes",
            "scope_source": "confirmed",
        },
        "tasks": [
            {
                "id": "discover",
                "title": "Discover scope",
                "required": True,
                "weight": 2,
                "status": "done",
                "progress": 1,
                "elapsed_minutes": 20,
                "remaining_minutes": 0,
                "uncertainty": "low",
                "blocking": False,
                "evidence": ["Requirements inspected"],
            },
            {
                "id": "build",
                "title": "Build feature",
                "required": True,
                "weight": 5,
                "status": "in_progress",
                "progress": 0.5,
                "elapsed_minutes": 30,
                "remaining_minutes": 45,
                "uncertainty": "medium",
                "blocking": False,
                "evidence": ["Core path implemented"],
            },
            {
                "id": "verify",
                "title": "Verify acceptance",
                "required": True,
                "weight": 3,
                "status": "not_started",
                "progress": 0,
                "elapsed_minutes": 0,
                "remaining_minutes": 30,
                "uncertainty": "medium",
                "blocking": False,
                "evidence": [],
            },
            {
                "id": "polish",
                "title": "Optional polish",
                "required": False,
                "weight": 8,
                "status": "not_started",
                "progress": 0,
                "elapsed_minutes": 0,
                "remaining_minutes": 120,
                "uncertainty": "high",
                "blocking": False,
                "evidence": [],
            },
        ],
    }


class ProgressTests(unittest.TestCase):
    def test_weighted_percent_excludes_optional_tasks(self):
        data = sample_ledger()
        self.assertEqual(progress.validate_ledger(data), [])
        metrics = progress.calculate(data)
        self.assertAlmostEqual(metrics.percent, 45.0)
        self.assertEqual(metrics.total_points, 10)
        self.assertIsNotNone(metrics.likely_minutes)

    def test_done_requires_evidence(self):
        data = sample_ledger()
        data["tasks"][0]["evidence"] = []
        errors = progress.validate_ledger(data)
        self.assertTrue(any("evidence needs at least one item" in item for item in errors))

    def test_blocker_pauses_rendered_eta(self):
        data = sample_ledger()
        data["tasks"][1]["status"] = "blocked"
        data["tasks"][1]["blocking"] = True
        metrics = progress.calculate(data)
        rendered = progress.render_text(data, metrics, 20, False)
        self.assertIn("ETA: paused by blocker", rendered)
        self.assertIn("Build feature", rendered)

    def test_render_shows_scope_and_required_goals(self):
        data = sample_ledger()
        metrics = progress.calculate(data)
        rendered = progress.render_text(data, metrics, 20, False)
        self.assertIn("Scope: confirmed", rendered)
        self.assertIn("Required goals:", rendered)
        self.assertIn("✓ Discover scope (100%)", rendered)
        self.assertNotIn("Optional polish", rendered)

    def test_cli_renders_ascii_and_json(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger = Path(directory) / "progress.json"
            ledger.write_text(json.dumps(sample_ledger()), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "render", str(ledger), "--ascii", "--json"],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["percent"], 45.0)
        self.assertIn("[#", payload["bar"])

    def test_completed_project_reports_zero_eta(self):
        data = sample_ledger()
        for task in data["tasks"]:
            if task["required"]:
                task["status"] = "done"
                task["progress"] = 1
                task["remaining_minutes"] = 0
                task["evidence"] = ["Verified"]
        metrics = progress.calculate(data)
        self.assertEqual(metrics.percent, 100)
        self.assertEqual(metrics.likely_minutes, 0)
        self.assertIn("ETA: complete", progress.render_text(data, metrics, 20, False))


if __name__ == "__main__":
    unittest.main()
