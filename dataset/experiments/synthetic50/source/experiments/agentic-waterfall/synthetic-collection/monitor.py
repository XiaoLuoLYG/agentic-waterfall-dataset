#!/usr/bin/env python3
"""Read-only terminal dashboard for the Waterfall synthetic experiment."""

import argparse
import json
import os
import shutil
import sys
import textwrap
import time
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from unicodedata import east_asian_width


KEY_ALIASES = ("key-1", "key-2", "key-3")
REFRESH_SECONDS = 4
PROGRESS_MAX_AGE = 30
API_MAX_AGE = 12
RUN_LABELS = {
    "preparing": "预检中", "running": "运行中", "blocked": "已阻断",
    "completed": "已完成", "failed": "失败", "stopped": "已停止",
}
STAGE_LABELS = {
    "waiting": "等待", "running": "运行中", "checking": "验收中",
    "passed": "验收通过", "completed": "已完成", "blocked": "已阻断",
}


def record(value):
    return value if isinstance(value, dict) else {}


def read_snapshot(path):
    try:
        return record(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError, RecursionError):
        return {}


def timestamp(value):
    if type(value) in (int, float) and 0 <= value < 253402300800:
        return float(value)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp()
        except (OSError, ValueError, OverflowError):
            return None
    return None


def count(snapshot, name):
    value = snapshot.get(name)
    return value if type(value) is int and 0 <= value <= sys.maxsize else None


def format_count(value):
    return "--" if value is None else f"{value:,}"


def snapshot_issue(snapshot, updated, now, max_age):
    if not snapshot:
        return "等待快照"
    pid = count(snapshot, "pid")
    if pid and pid < 2**31:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return "已停止"
        except PermissionError:
            pass
    if updated is None or updated > now + REFRESH_SECONDS:
        return "快照时间未知"
    return "更新停滞" if now - updated > max_age else ""


def estimate(done, total, started, updated):
    if not (done and total and done < total and started is not None and updated > started):
        return None
    # shortcut: stage-average ETA assumes similar remaining work, use recent completions if pace drifts.
    return max(1, round((total - done) * (updated - started) / done))


def format_eta(remaining):
    if remaining is None:
        return "--"
    minutes, seconds = divmod(remaining, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m" if hours else f"{minutes}m{seconds:02d}s"


def fixed_tail_seconds(run_dir, stage):
    """The single local BGE worker can outlast the faster API tracks."""
    started = timestamp(stage.get("started_at"))
    total = count(stage, "contexts_total")
    if started is None or not total:
        return None
    times = []
    for path in (run_dir / "comparison" / "runs").glob("*/*/fixed-retrieval.json.gz"):
        try:
            times.append(path.stat().st_mtime)
        except OSError:
            continue
    remaining = total - len(times)
    fresh = sorted(at for at in times if at >= started)[-6:]
    gaps = [b - a for a, b in zip(fresh, fresh[1:]) if b - a >= 5]
    return max(1, round(remaining * median(gaps))) if remaining > 0 and gaps else None


def stage_lines(title, stage, run_label, updated, bar_width, tail=None):
    done, total = count(stage, "done"), count(stage, "total")
    status = stage.get("status")
    label = STAGE_LABELS.get(status, "等待") if isinstance(status, str) else "等待"
    if status in ("running", "checking") and run_label != RUN_LABELS["running"]:
        label = run_label
    filled = bar_width * min(done, total) // total if done is not None and total else 0
    bar = "#" * filled + "-" * (bar_width - filled)
    eta = None
    if status == "running" and label == RUN_LABELS["running"]:
        baseline = count(stage, "baseline_done") or 0
        if done is not None and total is not None and baseline <= done <= total:
            eta = estimate(done - baseline, total - baseline, timestamp(stage.get("started_at")), updated)
        if tail is not None:
            eta = max(eta or 0, tail)
    return [f"{title} {format_count(done)}/{format_count(total)} · {label}", f"[{bar}] ETA {format_eta(eta)}"]


def api_lines(stats, now):
    issue = snapshot_issue(stats, timestamp(stats.get("updated_at")), now, API_MAX_AGE)
    raw_slots = stats.get("slots")
    slots = {
        slot["id"]: slot for slot in raw_slots
        if isinstance(slot, dict) and slot.get("id") in KEY_ALIASES
    } if isinstance(raw_slots, list) else {}
    columns = "{:<5} {:>7} {:>4} {:>8}"
    lines = [f"API 近60秒 · {issue or 'HTTP 在途/上限'}", columns.format("", "HTTP", "RPM", "TPM")]
    for alias in KEY_ALIASES:
        slot = slots.get(alias, {})
        cap = format_count(count(slot, "max_concurrent"))
        active = slot if not issue else {}
        inflight = format_count(count(active, "http_in_flight"))
        rpm = format_count(count(active, "rpm_60s"))
        tpm = format_count(count(active, "tpm_60s"))
        lines.append(columns.format(alias, f"{inflight}/{cap}", rpm, tpm))
    return lines


def render(run_dir, columns):
    progress = read_snapshot(run_dir / "progress.json")
    stats = read_snapshot(run_dir / "api" / "stats.json")
    now = time.time()
    updated = timestamp(progress.get("updated_at"))
    issue = snapshot_issue(progress, updated, now, PROGRESS_MAX_AGE)
    status = progress.get("status")
    run_label = RUN_LABELS.get(status, "状态未知") if isinstance(status, str) else "状态未知"
    if issue and status not in ("blocked", "completed", "failed", "stopped"):
        run_label = issue

    width = max(12, columns - 1)
    bar_width = min(18, max(6, width - 16))
    generation = record(progress.get("generation"))
    evaluation = record(progress.get("evaluation"))
    lines = [f"Waterfall 自采 · {run_label}", ""]
    lines.extend(stage_lines("轨迹生成", generation, run_label, updated, bar_width))
    lines.extend([f"有效 {format_count(count(generation, 'valid'))}", ""])
    lines.extend(stage_lines("五方法对比", evaluation, run_label, updated, bar_width, fixed_tail_seconds(run_dir, evaluation)))
    labels_done = format_count(count(evaluation, "labels_done"))
    labels_total = format_count(count(evaluation, "labels_total"))
    contexts_done = format_count(count(evaluation, "contexts_done"))
    contexts_total = format_count(count(evaluation, "contexts_total"))
    lines.extend([f"标注 {labels_done}/{labels_total} · 上下文 {contexts_done}/{contexts_total}", ""])
    lines.extend(api_lines(stats, now))
    return "\n".join(
        textwrap.fill(line, max(8, width - sum(east_asian_width(c) in "WF" for c in line)),
                      subsequent_indent="  ", break_on_hyphens=False)
        for line in lines
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_dir", type=Path, metavar="RUN_DIR")
    parser.add_argument("--once", action="store_true", help="print one snapshot and exit")
    args = parser.parse_args()
    if args.once or not sys.stdout.isatty() or os.environ.get("TERM") == "dumb":
        print(render(args.run_dir, shutil.get_terminal_size().columns))
        return

    try:
        print("\x1b[?1049h\x1b[?25l", end="", flush=True)
        while True:
            frame = render(args.run_dir, shutil.get_terminal_size().columns)
            print("\x1b[H" + "\x1b[K\n".join(frame.splitlines()) + "\x1b[J", end="", flush=True)
            time.sleep(REFRESH_SECONDS)
    except KeyboardInterrupt:
        pass
    finally:
        print("\x1b[?25h\x1b[?1049l", end="", flush=True)


if __name__ == "__main__":
    main()
