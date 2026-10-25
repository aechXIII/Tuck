"""Exports that were waiting or running, kept on disk so they survive Tuck closing."""

from __future__ import annotations

import contextlib
import json
import logging
import os
import re
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path

from .models import EncodePlan
from .models.cutting import CutPlan

logger = logging.getLogger(__name__)

STORE_VERSION = 1
STORE_NAME = "unfinished-exports.json"

_ITEM_ID = re.compile(r"[0-9a-f]{12}")


@dataclass(frozen=True)
class SavedExport:
    item_id: str
    plan: EncodePlan | CutPlan
    added_at: str
    # it had started, so it left scratch files behind and starts over from the beginning
    was_running: bool


def export_record(
    item_id: str, plan: EncodePlan | CutPlan, added_at: str, *, running: bool
) -> dict[str, object]:
    kind = "cut" if isinstance(plan, CutPlan) else "encode"
    return {
        "id": item_id,
        "kind": kind,
        "running": running,
        "added_at": added_at,
        "plan": plan.to_dict(),
    }


def _saved_export(raw: object) -> SavedExport:
    if not isinstance(raw, dict):
        raise ValueError("expected an export object")
    kind, plan_data = raw.get("kind"), raw.get("plan")
    if not isinstance(plan_data, dict):
        raise ValueError("expected a plan object")
    plan: EncodePlan | CutPlan
    if kind == "cut":
        plan = CutPlan.from_dict(plan_data)
    elif kind == "encode":
        plan = EncodePlan.from_dict(plan_data)
        if not isinstance(plan.source, str) or not isinstance(plan.output, str):
            raise ValueError("expected source and output paths")
    else:
        raise ValueError(f"unknown export kind {kind!r}")
    item_id = raw.get("id")
    added_at = raw.get("added_at")
    return SavedExport(
        item_id=item_id
        if isinstance(item_id, str) and _ITEM_ID.fullmatch(item_id)
        else uuid.uuid4().hex[:12],
        plan=plan,
        added_at=added_at if isinstance(added_at, str) else "",
        was_running=raw.get("running") is True,
    )


class UnfinishedExportStore:
    """One JSON file in Tuck's data folder, replaced whole on every change.

    Writes come from whichever thread changed the queue. Each takes a ticket while the queue
    is locked, and a write older than one already on disk is dropped, so a slow writer can't
    bring back exports that have since finished.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = threading.Lock()
        self._issued = 0
        self._written = 0

    @property
    def path(self) -> Path:
        return self._path

    def ticket(self) -> int:
        with self._lock:
            self._issued += 1
            return self._issued

    def save(self, revision: int, records: list[dict[str, object]]) -> None:
        with self._lock:
            if revision <= self._written:
                return
            try:
                self._write(records)
            except (OSError, TypeError, ValueError) as exc:
                # the exports keep running; only their return after a restart is at risk
                logger.warning("Could not save the unfinished exports to %s: %s", self._path, exc)
                return
            self._written = revision

    def _write(self, records: list[dict[str, object]]) -> None:
        if not records:
            self._path.unlink(missing_ok=True)
            return
        data = json.dumps({"version": STORE_VERSION, "exports": records}, ensure_ascii=False)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_name(f".{self._path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8") as handle:
                handle.write(data)
                handle.flush()
                # a restart right after the write is the case this file is for
                os.fsync(handle.fileno())
            temporary.replace(self._path)
        except BaseException:
            with contextlib.suppress(OSError):
                temporary.unlink(missing_ok=True)
            raise

    def load(self) -> list[SavedExport]:
        """The saved exports in queue order; an unreadable file is set aside, never guessed at."""
        try:
            text = self._path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return []
        except OSError as exc:
            logger.warning("Could not read the unfinished exports in %s: %s", self._path, exc)
            return []
        try:
            document = json.loads(text)
            if not isinstance(document, dict) or document.get("version") != STORE_VERSION:
                raise ValueError("unknown file version")
            entries = document.get("exports")
            if not isinstance(entries, list):
                raise ValueError("expected a list of exports")
        except ValueError as exc:
            self._set_aside(exc)
            return []
        saved: list[SavedExport] = []
        seen: set[str] = set()
        for entry in entries:
            try:
                export = _saved_export(entry)
            except (TypeError, ValueError, KeyError) as exc:
                logger.warning("Skipped an unfinished export Tuck couldn't read: %s", exc)
                continue
            if export.item_id in seen:
                export = SavedExport(
                    uuid.uuid4().hex[:12], export.plan, export.added_at, export.was_running
                )
            seen.add(export.item_id)
            saved.append(export)
        return saved

    def _set_aside(self, reason: Exception) -> None:
        # kept for a bug report; the next change to the queue writes a fresh file
        unreadable = self._path.with_name(self._path.name + ".unreadable")
        logger.warning(
            "The unfinished exports in %s can't be read (%s); moved to %s",
            self._path,
            reason,
            unreadable.name,
        )
        try:
            self._path.replace(unreadable)
        except OSError as exc:
            logger.warning("Could not move %s aside: %s", self._path, exc)
