import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unicodedata import east_asian_width


MONITOR = Path(__file__).with_name("monitor.py")


class MonitorTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.run_dir = Path(temporary.name)
        self.now = datetime.now(timezone.utc)

    def snapshot(self, elapsed=0, pid=None):
        updated = self.now - timedelta(seconds=elapsed)
        return {"pid": pid or os.getpid(), "updated_at": updated.isoformat()}

    def write(self, name, value):
        path = self.run_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def run_monitor(self):
        result = subprocess.run(
            [sys.executable, str(MONITOR), str(self.run_dir), "--once"],
            env={**os.environ, "COLUMNS": "32"}, capture_output=True,
            encoding="utf-8", timeout=5,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def write_progress(self, elapsed=0, pid=None):
        self.write("progress.json", {
            **self.snapshot(elapsed, pid), "status": "running",
            "message": "model-body-canary", "phase": "credential-canary",
            "generation": {"done": 12, "total": 12, "valid": 12, "status": "passed"},
            "evaluation": {
                "done": 2, "total": 10, "labels_done": 45, "labels_total": 200,
                "contexts_done": 0, "contexts_total": 2, "status": "running",
                "started_at": (self.now - timedelta(seconds=60 + elapsed)).isoformat(),
            },
        })

    def write_api(self, elapsed=0, pid=None):
        self.write("api/stats.json", {
            **self.snapshot(elapsed, pid), "slots": [
                {"id": "key-3", "http_in_flight": 0, "max_concurrent": 2,
                 "rpm_60s": 0, "tpm_60s": 0},
                {"id": "key-1", "http_in_flight": 6, "max_concurrent": 8,
                 "rpm_60s": 18, "tpm_60s": 54700, "waiting": 100,
                 "host": "credential-canary"},
                {"id": "credential-canary", "http_in_flight": 17},
            ],
        })

    def test_snapshot_displays_measured_values_without_leaking_raw_fields(self):
        self.write_progress()
        self.write_api()
        output = self.run_monitor()
        self.assertRegex(output, re.compile(r"^key-1\s+6/8\s+18\s+54,700$", re.M))
        self.assertRegex(output, re.compile(r"^key-2\s+--/--\s+--\s+--$", re.M))
        self.assertRegex(output, re.compile(r"^key-3\s+0/2\s+0\s+0$", re.M))
        self.assertIn("4m00s", output)
        for value in ("12/12", "2/10", "45/200", "0/2"):
            self.assertIn(value, output)
        self.assertNotIn("canary", output)
        self.assertNotIn("\x1b", output)
        for line in output.splitlines():
            self.assertLess(sum(2 if east_asian_width(c) in "WF" else 1 for c in line), 32)

    def test_expired_snapshots_keep_progress_but_suppress_eta_and_live_gauges(self):
        self.write_progress(elapsed=90)
        self.write_api(elapsed=90)
        output = self.run_monitor()
        self.assertIn("更新停滞", output)
        self.assertIn("2/10", output)
        self.assertNotIn("4m00s", output)
        self.assertNotIn("54,700", output)
        self.assertIn("--/8", output)

    def test_exited_pid_is_stopped_even_with_fresh_snapshot(self):
        with subprocess.Popen([sys.executable, "-c", "pass"]) as child:
            child.wait(timeout=5)
        self.write_progress(pid=child.pid)
        self.write_api(pid=child.pid)
        output = self.run_monitor()
        self.assertIn("已停止", output)
        self.assertNotIn("4m00s", output)
        self.assertNotIn("54,700", output)

    def test_absent_malformed_and_future_snapshots_keep_all_key_rows(self):
        empty_output = self.run_monitor()
        (self.run_dir / "progress.json").write_text("{", encoding="utf-8")
        self.write_api(elapsed=-3600)
        future_output = self.run_monitor()
        for output in (empty_output, future_output):
            for alias in ("key-1", "key-2", "key-3"):
                self.assertIn(alias, output)
            self.assertNotIn("54,700", output)


if __name__ == "__main__":
    unittest.main()
