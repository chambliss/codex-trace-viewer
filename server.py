#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shlex
import threading
import time
import webbrowser
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

APP_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = APP_ROOT / "static"
FILENAME_TS_RE = re.compile(r"rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})")
SKILL_PATH_RE = re.compile(r"/(?:\.codex|\.agents)/skills/([^/]+)/SKILL\.md")
TOOL_CALL_RESPONSE_SUBTYPES = {
    "function_call",
    "custom_tool_call",
    "local_shell_call",
    "web_search_call",
}


@dataclass
class ConversationSummary:
    id: str
    thread_id: str | None
    path: str
    archived: bool
    title: str
    preview: str
    started_at: str | None
    updated_at: str | None
    started_ts: float
    updated_ts: float
    cwd: str | None
    model: str | None
    model_provider: str | None
    cli_version: str | None
    source: Any
    originator: str | None
    total_events: int
    turn_count: int
    message_count: int
    tool_call_count: int
    tool_result_count: int
    compaction_count: int
    token_samples: int
    max_total_tokens: int
    type_counts: dict[str, int]
    event_type_counts: dict[str, int]
    response_type_counts: dict[str, int]
    tool_analytics_counts: dict[str, Any]

    def to_api_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "thread_id": self.thread_id,
            "path": self.path,
            "archived": self.archived,
            "title": self.title,
            "preview": self.preview,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "cwd": self.cwd,
            "model": self.model,
            "model_provider": self.model_provider,
            "cli_version": self.cli_version,
            "source": self.source,
            "originator": self.originator,
            "total_events": self.total_events,
            "turn_count": self.turn_count,
            "message_count": self.message_count,
            "tool_call_count": self.tool_call_count,
            "tool_result_count": self.tool_result_count,
            "compaction_count": self.compaction_count,
            "token_samples": self.token_samples,
            "max_total_tokens": self.max_total_tokens,
            "type_counts": self.type_counts,
            "event_type_counts": self.event_type_counts,
            "response_type_counts": self.response_type_counts,
        }


@dataclass
class ParsedConversation:
    mtime: float
    raw_lines: list[str]
    events: list[dict[str, Any]]
    stats: dict[str, Any]
    token_series: list[dict[str, Any]]
    compaction_impacts: list[dict[str, Any]]
    turns: list[dict[str, Any]]
    tool_analytics_counts: dict[str, Any]


def parse_iso_ts(value: str | None) -> float:
    if not value or not isinstance(value, str):
        return 0.0
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def iso_from_epoch(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_text(value: str) -> str:
    return " ".join(value.split())


def truncate_text(value: str | None, limit: int = 180) -> str:
    if not value:
        return ""
    normalized = normalize_text(value)
    if len(normalized) <= limit:
        return normalized
    return normalized[: max(0, limit - 3)] + "..."


def file_id_for_path(path: Path) -> str:
    digest = hashlib.sha256(str(path).encode("utf-8")).hexdigest()[:16]
    return digest


def parse_filename_timestamp(path: Path) -> str | None:
    match = FILENAME_TS_RE.search(path.name)
    if not match:
        return None
    raw = match.group(1)
    try:
        parsed = datetime.strptime(raw, "%Y-%m-%dT%H-%M-%S")
        return parsed.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
    except ValueError:
        return None


def extract_message_text_from_content(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        text = item.get("text")
        if item_type in {
            "input_text",
            "output_text",
            "text",
            "summary_text",
            "reasoning_text",
        } and isinstance(text, str):
            parts.append(text)
    return "\n".join(parts)


def extract_any_message_text(top_type: str, payload: dict[str, Any]) -> str:
    if top_type == "event_msg":
        return payload.get("message") or payload.get("text") or ""

    if top_type == "response_item":
        if payload.get("type") == "message":
            return extract_message_text_from_content(payload.get("content"))
        if payload.get("type") == "reasoning":
            summary = payload.get("summary")
            if isinstance(summary, list):
                summary_text_parts = []
                for block in summary:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        summary_text_parts.append(block["text"])
                return "\n".join(summary_text_parts)
    return ""


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_token_usage_snapshot(
    info: dict[str, Any], previous_context_tokens: int | None = None
) -> dict[str, Any]:
    total_usage = (
        info.get("total_token_usage") if isinstance(info.get("total_token_usage"), dict) else {}
    )
    last_usage = info.get("last_token_usage") if isinstance(info.get("last_token_usage"), dict) else {}

    cumulative_total_tokens = safe_int(total_usage.get("total_tokens"))
    context_tokens = safe_int(last_usage.get("total_tokens"))
    if context_tokens <= 0:
        context_tokens = cumulative_total_tokens

    model_context_window = safe_int(info.get("model_context_window"))

    last_input_tokens = safe_int(last_usage.get("input_tokens"))
    last_cached_input_tokens = safe_int(last_usage.get("cached_input_tokens"))
    last_output_tokens = safe_int(last_usage.get("output_tokens"))
    last_reasoning_output_tokens = safe_int(last_usage.get("reasoning_output_tokens"))

    has_last_breakdown = any(
        value > 0
        for value in (
            last_input_tokens,
            last_cached_input_tokens,
            last_output_tokens,
            last_reasoning_output_tokens,
        )
    )

    # Some traces emit an inflated `last_token_usage.total_tokens` while the per-step
    # token breakdown is all zeros. Treat that as invalid for context tracking.
    if model_context_window > 0 and context_tokens > model_context_window:
        if has_last_breakdown:
            context_tokens = model_context_window
        elif previous_context_tokens is not None and previous_context_tokens > 0:
            context_tokens = previous_context_tokens
        else:
            context_tokens = model_context_window

    context_fill_percent = (
        (context_tokens / model_context_window * 100.0) if model_context_window > 0 else None
    )

    return {
        "total_usage": total_usage,
        "last_usage": last_usage,
        "cumulative_total_tokens": cumulative_total_tokens,
        "context_tokens": context_tokens,
        "model_context_window": model_context_window,
        "context_fill_percent": context_fill_percent,
        "last_input_tokens": last_input_tokens,
        "last_cached_input_tokens": last_cached_input_tokens,
        "last_output_tokens": last_output_tokens,
        "last_reasoning_output_tokens": last_reasoning_output_tokens,
    }


def is_probably_scaffolding_message(text: str) -> bool:
    lowered = text.lower()
    if "# agents.md instructions" in lowered:
        return True
    if "<environment_context>" in lowered:
        return True
    if "<collaboration_mode>" in lowered:
        return True
    return False


def new_tool_analytics_counts() -> dict[str, Any]:
    return {
        "tool_calls_total": 0,
        "tool_name_counts": {},
        "command_root_counts": {},
        "skill_counts": {},
        "mcp_tool_counts": {},
    }


def increment_name_count(counts_map: dict[str, int], name: str, delta: int = 1) -> None:
    if not name:
        return
    counts_map[name] = safe_int(counts_map.get(name), 0) + delta


def extract_command_root(command: str) -> str | None:
    raw = command.strip()
    if not raw:
        return None

    try:
        tokens = shlex.split(raw)
    except ValueError:
        tokens = raw.split()
    if not tokens:
        return None

    first = tokens[0]

    # Unwrap shell launchers.
    if first in {"bash", "zsh", "sh", "fish"} and len(tokens) >= 3 and tokens[1] == "-lc":
        inner = tokens[2].strip()
        try:
            inner_tokens = shlex.split(inner)
        except ValueError:
            inner_tokens = inner.split()
        if inner_tokens:
            tokens = inner_tokens
            first = tokens[0]

    # Unwrap common wrappers.
    if first == "devbox" and "--" in tokens:
        delim = tokens.index("--")
        if delim + 1 < len(tokens):
            first = tokens[delim + 1]

    # Skip leading `cd ... &&` wrappers to capture actual command root.
    if first == "cd" and "&&" in tokens:
        join_idx = tokens.index("&&")
        if join_idx + 1 < len(tokens):
            first = tokens[join_idx + 1]

    return first


def parse_tool_call_command(payload: dict[str, Any], subtype: str | None) -> str | None:
    raw_args: Any = None
    if subtype == "function_call":
        raw_args = payload.get("arguments")
    elif subtype in {"custom_tool_call", "local_shell_call", "web_search_call"}:
        raw_args = payload.get("input")

    parsed_args: dict[str, Any] | None = None
    if isinstance(raw_args, dict):
        parsed_args = raw_args
    elif isinstance(raw_args, str):
        stripped = raw_args.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                candidate = json.loads(stripped)
                if isinstance(candidate, dict):
                    parsed_args = candidate
            except json.JSONDecodeError:
                parsed_args = None

    if not isinstance(parsed_args, dict):
        return None

    command = parsed_args.get("cmd")
    if isinstance(command, str) and command.strip():
        return command
    command = parsed_args.get("command")
    if isinstance(command, str) and command.strip():
        return command
    return None


def extract_skill_mentions(text: str) -> list[str]:
    if not text:
        return []
    out: list[str] = []
    for match in SKILL_PATH_RE.finditer(text):
        skill = match.group(1).strip()
        if skill and re.fullmatch(r"[A-Za-z0-9._-]+", skill):
            out.append(skill)
    return out


def update_tool_analytics_counts_from_response_item(
    counts: dict[str, Any], payload: dict[str, Any], subtype: str | None
) -> None:
    if subtype not in TOOL_CALL_RESPONSE_SUBTYPES:
        return

    counts["tool_calls_total"] = safe_int(counts.get("tool_calls_total"), 0) + 1

    tool_name = payload.get("name")
    if isinstance(tool_name, str) and tool_name:
        increment_name_count(counts["tool_name_counts"], tool_name)
        if tool_name.startswith("mcp__"):
            increment_name_count(counts["mcp_tool_counts"], tool_name)

    command = parse_tool_call_command(payload, subtype)
    if command:
        root = extract_command_root(command)
        if root:
            increment_name_count(counts["command_root_counts"], root)
        for skill_name in extract_skill_mentions(command):
            increment_name_count(counts["skill_counts"], skill_name)

    raw_for_skills = ""
    if subtype == "function_call":
        raw_for_skills = payload.get("arguments") if isinstance(payload.get("arguments"), str) else ""
    else:
        raw_for_skills = payload.get("input") if isinstance(payload.get("input"), str) else ""
    if raw_for_skills:
        for skill_name in extract_skill_mentions(raw_for_skills):
            increment_name_count(counts["skill_counts"], skill_name)


def merge_tool_analytics_counts(target: dict[str, Any], source: dict[str, Any]) -> None:
    target["tool_calls_total"] = safe_int(target.get("tool_calls_total"), 0) + safe_int(
        source.get("tool_calls_total"), 0
    )
    for key in ("tool_name_counts", "command_root_counts", "skill_counts", "mcp_tool_counts"):
        source_map = source.get(key) if isinstance(source.get(key), dict) else {}
        target_map = target.get(key) if isinstance(target.get(key), dict) else {}
        for name, count in source_map.items():
            increment_name_count(target_map, str(name), safe_int(count, 0))
        target[key] = target_map


def top_entries_from_count_map(count_map: dict[str, int], limit: int = 12) -> list[dict[str, Any]]:
    counter = Counter({str(name): safe_int(count, 0) for name, count in count_map.items()})
    return [{"name": name, "count": count} for name, count in counter.most_common(limit)]


def serialize_tool_analytics(
    counts: dict[str, Any], threads_analyzed: int, limit: int = 12
) -> dict[str, Any]:
    tool_name_counts = counts.get("tool_name_counts") if isinstance(counts.get("tool_name_counts"), dict) else {}
    command_root_counts = (
        counts.get("command_root_counts") if isinstance(counts.get("command_root_counts"), dict) else {}
    )
    skill_counts = counts.get("skill_counts") if isinstance(counts.get("skill_counts"), dict) else {}
    mcp_tool_counts = counts.get("mcp_tool_counts") if isinstance(counts.get("mcp_tool_counts"), dict) else {}

    return {
        "threads_analyzed": safe_int(threads_analyzed, 0),
        "tool_calls_total": safe_int(counts.get("tool_calls_total"), 0),
        "top_tools": top_entries_from_count_map(tool_name_counts, limit=limit),
        "top_command_roots": top_entries_from_count_map(command_root_counts, limit=limit),
        "top_skills": top_entries_from_count_map(skill_counts, limit=limit),
        "top_mcp_tools": top_entries_from_count_map(mcp_tool_counts, limit=limit),
    }


def infer_event_category(top_type: str, subtype: str | None, payload: dict[str, Any]) -> str:
    if top_type in {"session_meta", "turn_context"}:
        return "context"
    if top_type == "compacted":
        return "compaction"

    if top_type == "event_msg":
        if subtype == "token_count":
            return "token"
        if subtype in {"user_message", "agent_message"}:
            return "message"
        if subtype and subtype.startswith("agent_reasoning"):
            return "reasoning"
        if subtype in {"exec_command_begin", "mcp_tool_call_begin", "web_search_begin"}:
            return "tool_call"
        if subtype in {
            "exec_command_end",
            "exec_command_output_delta",
            "mcp_tool_call_end",
            "web_search_end",
        }:
            return "tool_result"
        if subtype == "context_compacted":
            return "compaction"
        return "system"

    if top_type == "response_item":
        if subtype == "message":
            return "message"
        if subtype == "reasoning":
            return "reasoning"
        if subtype in {
            "function_call",
            "custom_tool_call",
            "local_shell_call",
            "web_search_call",
        }:
            return "tool_call"
        if subtype in {"function_call_output", "custom_tool_call_output"}:
            return "tool_result"
        if subtype in {"compaction", "compaction_summary"}:
            return "compaction"
        return "system"

    return "system"


def summarize_event(top_type: str, subtype: str | None, payload: dict[str, Any]) -> str:
    if top_type == "session_meta":
        cwd = payload.get("cwd") or "unknown cwd"
        source = payload.get("source") or payload.get("originator") or "unknown source"
        return f"Session metadata ({source}) in {cwd}"

    if top_type == "turn_context":
        model = payload.get("model") or "unknown-model"
        approval = payload.get("approval_policy") or "unknown"
        sandbox = payload.get("sandbox_policy")
        sandbox_type = sandbox.get("type") if isinstance(sandbox, dict) else sandbox
        return f"Turn context: model={model} approval={approval} sandbox={sandbox_type}"

    if top_type == "compacted":
        replacement = payload.get("replacement_history")
        replacement_count = len(replacement) if isinstance(replacement, list) else 0
        msg = payload.get("message") or ""
        if msg:
            return f"Compacted history ({replacement_count} replacement items): {truncate_text(msg, 120)}"
        return f"Compacted history ({replacement_count} replacement items)"

    if top_type == "event_msg":
        if subtype == "token_count":
            info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
            token_snapshot = parse_token_usage_snapshot(info)
            context_tokens = safe_int(token_snapshot.get("context_tokens"))
            cumulative_tokens = safe_int(token_snapshot.get("cumulative_total_tokens"))
            window = safe_int(token_snapshot.get("model_context_window"))
            if window > 0:
                pct = (context_tokens / window) * 100.0
                return (
                    f"Context tokens {context_tokens:,} / {window:,} ({pct:.1f}%), "
                    f"cumulative {cumulative_tokens:,}"
                )
            return f"Context tokens {context_tokens:,}, cumulative {cumulative_tokens:,}"
        if subtype in {"user_message", "agent_message", "agent_reasoning"}:
            text = payload.get("message") or payload.get("text") or ""
            return f"{subtype.replace('_', ' ').title()}: {truncate_text(text, 140)}"
        if subtype == "task_started":
            return "Turn started"
        if subtype == "task_complete":
            return "Turn complete"
        if subtype == "context_compacted":
            return "Context compacted"
        if subtype == "turn_aborted":
            reason = payload.get("reason") or "unknown"
            return f"Turn aborted ({reason})"
        return subtype.replace("_", " ").title() if subtype else "Event"

    if top_type == "response_item":
        if subtype == "message":
            role = payload.get("role") or "unknown"
            text = extract_message_text_from_content(payload.get("content"))
            return f"{role.title()} message: {truncate_text(text, 140)}"
        if subtype == "reasoning":
            summary = payload.get("summary")
            if isinstance(summary, list) and summary:
                text = extract_message_text_from_content(summary)
                if text:
                    return f"Reasoning: {truncate_text(text, 140)}"
            return "Reasoning item"
        if subtype == "function_call":
            name = payload.get("name") or "unknown_tool"
            return f"Tool call: {name}"
        if subtype == "function_call_output":
            call_id = payload.get("call_id") or "unknown"
            return f"Tool result for call {call_id}"
        if subtype == "custom_tool_call":
            name = payload.get("name") or "unknown_custom_tool"
            return f"Custom tool call: {name}"
        if subtype == "custom_tool_call_output":
            call_id = payload.get("call_id") or "unknown"
            return f"Custom tool result for call {call_id}"
        if subtype == "web_search_call":
            action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
            action_type = action.get("type") or "action"
            return f"Web search call: {action_type}"
        return subtype.replace("_", " ").title() if subtype else "Response item"

    return top_type.replace("_", " ").title()


def shrink_for_json(
    value: Any,
    max_depth: int = 9,
    max_items: int = 120,
    max_string: int = 12000,
    depth: int = 0,
) -> tuple[Any, bool]:
    if depth >= max_depth:
        return "[truncated: max depth reached]", True

    if isinstance(value, str):
        if len(value) <= max_string:
            return value, False
        omitted = len(value) - max_string
        return value[:max_string] + f"... [truncated {omitted} chars]", True

    if isinstance(value, list):
        truncated = False
        out = []
        for idx, item in enumerate(value):
            if idx >= max_items:
                out.append(f"[truncated {len(value) - max_items} more items]")
                truncated = True
                break
            shrunk, item_truncated = shrink_for_json(
                item,
                max_depth=max_depth,
                max_items=max_items,
                max_string=max_string,
                depth=depth + 1,
            )
            out.append(shrunk)
            truncated = truncated or item_truncated
        return out, truncated

    if isinstance(value, dict):
        truncated = False
        out: dict[str, Any] = {}
        items = list(value.items())
        for idx, (key, item_value) in enumerate(items):
            if idx >= max_items:
                out["__truncated__"] = f"{len(items) - max_items} more keys omitted"
                truncated = True
                break
            shrunk, item_truncated = shrink_for_json(
                item_value,
                max_depth=max_depth,
                max_items=max_items,
                max_string=max_string,
                depth=depth + 1,
            )
            out[str(key)] = shrunk
            truncated = truncated or item_truncated
        return out, truncated

    return value, False


class RolloutStore:
    def __init__(self, codex_home: Path):
        self.codex_home = codex_home
        self.sessions_dir = codex_home / "sessions"
        self.archived_dir = codex_home / "archived_sessions"

        self._lock = threading.Lock()
        self._index: dict[str, ConversationSummary] = {}
        self._path_to_id: dict[Path, str] = {}
        self._summary_cache: dict[Path, tuple[float, ConversationSummary]] = {}
        self._conversation_cache: dict[str, ParsedConversation] = {}
        self._last_scan_ts = 0.0

    def _iter_rollout_paths(self) -> list[Path]:
        paths: list[Path] = []
        if self.sessions_dir.exists():
            paths.extend(sorted(self.sessions_dir.rglob("rollout-*.jsonl")))
        if self.archived_dir.exists():
            paths.extend(sorted(self.archived_dir.glob("rollout-*.jsonl")))
        return paths

    def refresh_index(self, force: bool = False) -> None:
        now = time.time()
        with self._lock:
            if not force and now - self._last_scan_ts < 3.0:
                return

            seen_ids: set[str] = set()
            next_index: dict[str, ConversationSummary] = {}
            next_path_to_id: dict[Path, str] = {}

            for path in self._iter_rollout_paths():
                try:
                    file_id = file_id_for_path(path)
                    summary = self._summary_for_path(path, file_id)
                    if summary is None:
                        continue
                    seen_ids.add(file_id)
                    next_index[file_id] = summary
                    next_path_to_id[path] = file_id
                except Exception:
                    continue

            stale_ids = set(self._index.keys()) - seen_ids
            for stale_id in stale_ids:
                self._conversation_cache.pop(stale_id, None)

            self._index = next_index
            self._path_to_id = next_path_to_id
            self._last_scan_ts = now

    def _summary_for_path(self, path: Path, file_id: str) -> ConversationSummary | None:
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None

        cached = self._summary_cache.get(path)
        if cached and cached[0] == mtime:
            cached_summary = cached[1]
            if cached_summary.id != file_id:
                cached_summary.id = file_id
            return cached_summary

        summary = self._parse_summary(path, file_id)
        if summary:
            self._summary_cache[path] = (mtime, summary)
        return summary

    def _parse_summary(self, path: Path, file_id: str) -> ConversationSummary | None:
        archived = self.archived_dir in path.parents

        type_counts: Counter[str] = Counter()
        event_type_counts: Counter[str] = Counter()
        response_type_counts: Counter[str] = Counter()

        thread_id: str | None = None
        started_at: str | None = None
        updated_at: str | None = None
        cwd: str | None = None
        model: str | None = None
        model_provider: str | None = None
        cli_version: str | None = None
        source: Any = None
        originator: str | None = None
        first_user_message = ""
        fallback_user_message = ""
        total_events = 0
        turn_ids: set[str] = set()
        summary_category_counts: Counter[str] = Counter()
        compaction_count = 0
        in_compaction_block = False
        token_samples = 0
        max_total_tokens = 0
        prev_context_tokens: int | None = None
        tool_analytics_counts = new_tool_analytics_counts()

        try:
            with path.open("r", encoding="utf-8") as handle:
                for raw_line in handle:
                    line = raw_line.strip()
                    if not line:
                        continue

                    total_events += 1
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    timestamp = item.get("timestamp")
                    if isinstance(timestamp, str):
                        if started_at is None:
                            started_at = timestamp
                        updated_at = timestamp

                    top_type = item.get("type")
                    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
                    subtype = (
                        payload.get("type")
                        if isinstance(payload.get("type"), str)
                        and top_type in {"event_msg", "response_item"}
                        else None
                    )

                    if isinstance(top_type, str):
                        type_counts[top_type] += 1

                    if isinstance(top_type, str):
                        category = infer_event_category(top_type, subtype, payload)
                        summary_category_counts[category] += 1

                    line_has_compaction_signal = False

                    if top_type == "session_meta":
                        thread_id = payload.get("id") or thread_id
                        started_at = payload.get("timestamp") or started_at
                        cwd = payload.get("cwd") or cwd
                        model_provider = payload.get("model_provider") or model_provider
                        cli_version = payload.get("cli_version") or cli_version
                        source = payload.get("source") or source
                        originator = payload.get("originator") or originator

                    elif top_type == "turn_context":
                        model = payload.get("model") or model
                        cwd = payload.get("cwd") or cwd
                        turn_id = payload.get("turn_id")
                        if isinstance(turn_id, str):
                            turn_ids.add(turn_id)

                    elif top_type == "event_msg":
                        if isinstance(subtype, str):
                            event_type_counts[subtype] += 1
                            if subtype == "context_compacted":
                                line_has_compaction_signal = True
                            if subtype == "token_count":
                                token_samples += 1
                                info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                                token_snapshot = parse_token_usage_snapshot(
                                    info, previous_context_tokens=prev_context_tokens
                                )
                                context_tokens = safe_int(token_snapshot.get("context_tokens"))
                                if context_tokens > 0:
                                    prev_context_tokens = context_tokens
                                max_total_tokens = max(
                                    max_total_tokens,
                                    context_tokens,
                                )
                        turn_id = payload.get("turn_id")
                        if isinstance(turn_id, str):
                            turn_ids.add(turn_id)

                        if not first_user_message and subtype == "user_message":
                            candidate = truncate_text(payload.get("message") or "", 200)
                            if candidate and not fallback_user_message:
                                fallback_user_message = candidate
                            if candidate and not is_probably_scaffolding_message(candidate):
                                first_user_message = candidate

                    elif top_type == "response_item":
                        if isinstance(subtype, str):
                            response_type_counts[subtype] += 1
                            update_tool_analytics_counts_from_response_item(
                                tool_analytics_counts, payload, subtype
                            )
                        if (
                            not first_user_message
                            and subtype == "message"
                            and payload.get("role") == "user"
                        ):
                            candidate = truncate_text(
                                extract_message_text_from_content(payload.get("content")),
                                200,
                            )
                            if candidate and not fallback_user_message:
                                fallback_user_message = candidate
                            if candidate and not is_probably_scaffolding_message(candidate):
                                first_user_message = candidate

                    elif top_type == "compacted":
                        line_has_compaction_signal = True

                    if line_has_compaction_signal:
                        if not in_compaction_block:
                            compaction_count += 1
                        in_compaction_block = True
                    else:
                        in_compaction_block = False

        except OSError:
            return None

        if total_events == 0:
            return None

        if not started_at:
            started_at = parse_filename_timestamp(path) or iso_from_epoch(path.stat().st_mtime)
        if not updated_at:
            updated_at = started_at

        started_ts = parse_iso_ts(started_at)
        updated_ts = parse_iso_ts(updated_at)
        if updated_ts <= 0:
            updated_ts = path.stat().st_mtime
            updated_at = iso_from_epoch(updated_ts)
        if started_ts <= 0:
            started_ts = updated_ts

        preview = first_user_message or fallback_user_message or "No user message found in this rollout."
        title = preview
        if len(title) > 72:
            title = title[:69] + "..."
        if not title or title == "...":
            title = f"Conversation {thread_id[:8] if isinstance(thread_id, str) else file_id[:8]}"

        return ConversationSummary(
            id=file_id,
            thread_id=thread_id,
            path=str(path),
            archived=archived,
            title=title,
            preview=preview,
            started_at=started_at,
            updated_at=updated_at,
            started_ts=started_ts,
            updated_ts=updated_ts,
            cwd=cwd,
            model=model,
            model_provider=model_provider,
            cli_version=cli_version,
            source=source,
            originator=originator,
            total_events=total_events,
            turn_count=len(turn_ids),
            message_count=summary_category_counts.get("message", 0),
            tool_call_count=summary_category_counts.get("tool_call", 0),
            tool_result_count=summary_category_counts.get("tool_result", 0),
            compaction_count=compaction_count,
            token_samples=token_samples,
            max_total_tokens=max_total_tokens,
            type_counts=dict(type_counts),
            event_type_counts=dict(event_type_counts),
            response_type_counts=dict(response_type_counts),
            tool_analytics_counts=tool_analytics_counts,
        )

    def list_conversations(
        self,
        query: str | None = None,
        include_archived: bool = True,
        limit: int | None = None,
    ) -> list[ConversationSummary]:
        self.refresh_index()
        with self._lock:
            summaries = list(self._index.values())

        if not include_archived:
            summaries = [item for item in summaries if not item.archived]

        if query:
            lowered = query.lower()
            summaries = [
                item
                for item in summaries
                if lowered in item.title.lower()
                or lowered in item.preview.lower()
                or lowered in (item.thread_id or "").lower()
                or lowered in (item.cwd or "").lower()
                or lowered in item.path.lower()
            ]

        summaries.sort(key=lambda item: item.updated_ts, reverse=True)
        if limit is not None and limit >= 0:
            summaries = summaries[:limit]
        return summaries

    def get_summary(self, conversation_id: str) -> ConversationSummary | None:
        self.refresh_index()
        with self._lock:
            return self._index.get(conversation_id)

    def get_default_conversation_id(self) -> str | None:
        conversations = self.list_conversations(limit=1)
        if not conversations:
            return None
        return conversations[0].id

    def get_tool_analytics(self, include_archived: bool = True, limit: int = 12) -> dict[str, Any]:
        combined = new_tool_analytics_counts()
        analyzed_threads = 0

        conversations = self.list_conversations(include_archived=include_archived)
        for summary in conversations:
            analyzed_threads += 1
            merge_tool_analytics_counts(combined, summary.tool_analytics_counts)

        return serialize_tool_analytics(combined, threads_analyzed=analyzed_threads, limit=limit)

    def parse_conversation(self, conversation_id: str) -> ParsedConversation | None:
        summary = self.get_summary(conversation_id)
        if summary is None:
            return None

        path = Path(summary.path)
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return None

        with self._lock:
            cached = self._conversation_cache.get(conversation_id)
            if cached and cached.mtime == mtime:
                return cached

        try:
            with path.open("r", encoding="utf-8") as handle:
                raw_lines = [line.strip() for line in handle if line.strip()]
        except OSError:
            return None

        events: list[dict[str, Any]] = []
        token_series: list[dict[str, Any]] = []
        turn_stats: dict[str, dict[str, Any]] = defaultdict(
            lambda: {
                "turn_id": None,
                "start_event": None,
                "end_event": None,
                "start_time": None,
                "end_time": None,
                "event_count": 0,
                "message_count": 0,
                "tool_call_count": 0,
                "tool_result_count": 0,
                "token_samples": 0,
                "max_total_tokens": 0,
            }
        )
        current_turn_id: str | None = None
        tool_name_by_call_id: dict[str, str] = {}
        tool_analytics_counts = new_tool_analytics_counts()
        prev_context_tokens: int | None = None

        category_counts: Counter[str] = Counter()
        compaction_markers: list[int] = []
        in_compaction_block = False

        for index, raw_line in enumerate(raw_lines):
            top_type = "invalid"
            payload: dict[str, Any] = {}
            subtype: str | None = None
            timestamp = None
            role = None
            parse_error = None

            try:
                item = json.loads(raw_line)
                top_type = item.get("type", "invalid")
                timestamp = item.get("timestamp")
                payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
                if top_type in {"event_msg", "response_item"}:
                    subtype = payload.get("type") if isinstance(payload.get("type"), str) else None
                if top_type == "response_item" and subtype == "message":
                    role = payload.get("role") if isinstance(payload.get("role"), str) else None
            except json.JSONDecodeError as exc:
                parse_error = str(exc)

            event_turn_id = None

            if top_type == "turn_context":
                maybe_turn = payload.get("turn_id")
                if isinstance(maybe_turn, str) and maybe_turn:
                    current_turn_id = maybe_turn
                    event_turn_id = maybe_turn

            if top_type == "event_msg":
                maybe_turn = payload.get("turn_id")
                if isinstance(maybe_turn, str) and maybe_turn:
                    current_turn_id = maybe_turn
                    event_turn_id = maybe_turn
                elif subtype == "task_started":
                    maybe_turn = payload.get("turn_id")
                    if isinstance(maybe_turn, str) and maybe_turn:
                        current_turn_id = maybe_turn
                        event_turn_id = maybe_turn

            if event_turn_id is None:
                event_turn_id = current_turn_id

            if top_type == "response_item":
                call_id = payload.get("call_id") if isinstance(payload.get("call_id"), str) else None
                if subtype in {"function_call", "custom_tool_call"} and call_id:
                    name = payload.get("name") if isinstance(payload.get("name"), str) else subtype
                    tool_name_by_call_id[call_id] = name
                update_tool_analytics_counts_from_response_item(
                    tool_analytics_counts, payload, subtype
                )

            category = infer_event_category(top_type, subtype, payload)
            category_counts[category] += 1
            if category == "compaction":
                if not in_compaction_block:
                    compaction_markers.append(index)
                in_compaction_block = True
            else:
                in_compaction_block = False

            summary_text = summarize_event(top_type, subtype, payload)
            preview_text = ""

            if top_type in {"event_msg", "response_item"}:
                preview_text = truncate_text(extract_any_message_text(top_type, payload), 180)
            if not preview_text and subtype in {"function_call", "custom_tool_call"}:
                args = payload.get("arguments") or payload.get("input")
                if isinstance(args, str):
                    preview_text = truncate_text(args, 180)
            if not preview_text and subtype in {"function_call_output", "custom_tool_call_output"}:
                output = payload.get("output")
                if isinstance(output, str):
                    preview_text = truncate_text(output, 180)
                elif isinstance(output, list):
                    preview_text = truncate_text(extract_message_text_from_content(output), 180)

            if subtype in {"function_call_output", "custom_tool_call_output"}:
                call_id = payload.get("call_id") if isinstance(payload.get("call_id"), str) else None
                tool_name = tool_name_by_call_id.get(call_id or "")
                if tool_name:
                    summary_text = f"Tool result from {tool_name} (call {call_id})"

            event_call_id: str | None = None
            event_tool_name: str | None = None
            if top_type == "response_item":
                maybe_call_id = payload.get("call_id")
                if isinstance(maybe_call_id, str) and maybe_call_id:
                    event_call_id = maybe_call_id
                if subtype in {"function_call", "custom_tool_call"}:
                    maybe_name = payload.get("name")
                    if isinstance(maybe_name, str) and maybe_name:
                        event_tool_name = maybe_name
                elif event_call_id:
                    event_tool_name = tool_name_by_call_id.get(event_call_id)
            elif top_type == "event_msg":
                maybe_call_id = payload.get("call_id") or payload.get("id")
                if isinstance(maybe_call_id, str) and maybe_call_id:
                    event_call_id = maybe_call_id
                maybe_name = payload.get("name") or payload.get("tool_name")
                if isinstance(maybe_name, str) and maybe_name:
                    event_tool_name = maybe_name

            event = {
                "index": index,
                "timestamp": timestamp,
                "timestamp_ts": parse_iso_ts(timestamp) if isinstance(timestamp, str) else 0.0,
                "top_type": top_type,
                "subtype": subtype,
                "category": category,
                "role": role,
                "turn_id": event_turn_id,
                "summary": summary_text,
                "preview": preview_text,
                "call_id": event_call_id,
                "tool_name": event_tool_name,
                "line_size": len(raw_line),
                "parse_error": parse_error,
            }
            events.append(event)

            if event_turn_id:
                turn_data = turn_stats[event_turn_id]
                turn_data["turn_id"] = event_turn_id
                turn_data["event_count"] += 1
                if turn_data["start_event"] is None:
                    turn_data["start_event"] = index
                    turn_data["start_time"] = timestamp
                turn_data["end_event"] = index
                turn_data["end_time"] = timestamp
                if category == "message":
                    turn_data["message_count"] += 1
                elif category == "tool_call":
                    turn_data["tool_call_count"] += 1
                elif category == "tool_result":
                    turn_data["tool_result_count"] += 1

            if top_type == "event_msg" and subtype == "token_count":
                info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
                token_snapshot = parse_token_usage_snapshot(
                    info, previous_context_tokens=prev_context_tokens
                )
                total_usage = (
                    token_snapshot.get("total_usage")
                    if isinstance(token_snapshot.get("total_usage"), dict)
                    else {}
                )
                last_usage = (
                    token_snapshot.get("last_usage")
                    if isinstance(token_snapshot.get("last_usage"), dict)
                    else {}
                )
                model_window = safe_int(token_snapshot.get("model_context_window"))
                cumulative_total_tokens = safe_int(token_snapshot.get("cumulative_total_tokens"))
                context_tokens = safe_int(token_snapshot.get("context_tokens"))
                fill_percent = token_snapshot.get("context_fill_percent")
                if context_tokens > 0:
                    prev_context_tokens = context_tokens

                token_point = {
                    "event_index": index,
                    "timestamp": timestamp,
                    "timestamp_ts": parse_iso_ts(timestamp) if isinstance(timestamp, str) else 0.0,
                    "turn_id": event_turn_id,
                    "total_tokens": context_tokens,
                    "cumulative_total_tokens": cumulative_total_tokens,
                    "input_tokens": safe_int(total_usage.get("input_tokens")),
                    "cached_input_tokens": safe_int(total_usage.get("cached_input_tokens")),
                    "output_tokens": safe_int(total_usage.get("output_tokens")),
                    "reasoning_output_tokens": safe_int(total_usage.get("reasoning_output_tokens")),
                    "last_total_tokens": safe_int(last_usage.get("total_tokens")),
                    "last_input_tokens": safe_int(token_snapshot.get("last_input_tokens")),
                    "last_cached_input_tokens": safe_int(
                        token_snapshot.get("last_cached_input_tokens")
                    ),
                    "last_output_tokens": safe_int(token_snapshot.get("last_output_tokens")),
                    "last_reasoning_output_tokens": safe_int(
                        token_snapshot.get("last_reasoning_output_tokens")
                    ),
                    "model_context_window": model_window,
                    "context_fill_percent": fill_percent,
                }
                token_series.append(token_point)

                if event_turn_id:
                    turn_data = turn_stats[event_turn_id]
                    turn_data["token_samples"] += 1
                    turn_data["max_total_tokens"] = max(
                        safe_int(turn_data.get("max_total_tokens")), context_tokens
                    )

        turns = sorted(
            [value for value in turn_stats.values() if value.get("turn_id")],
            key=lambda item: item.get("start_event") or 0,
        )

        max_context_window = max(
            [safe_int(point.get("model_context_window")) for point in token_series],
            default=0,
        )
        max_total_tokens = max(
            [safe_int(point.get("total_tokens")) for point in token_series],
            default=0,
        )

        compaction_impacts: list[dict[str, Any]] = []
        seen_pairs: set[tuple[int | None, int | None]] = set()
        for compaction_index in compaction_markers:
            before = None
            after = None
            for point in token_series:
                if safe_int(point.get("event_index")) <= compaction_index:
                    before = point
                elif safe_int(point.get("event_index")) > compaction_index:
                    after = point
                    break

            before_event_index = safe_int(before.get("event_index")) if before else None
            after_event_index = safe_int(after.get("event_index")) if after else None
            pair_key = (before_event_index, after_event_index)
            if pair_key in seen_pairs:
                continue
            seen_pairs.add(pair_key)

            impact = {
                "compaction_event_index": compaction_index,
                "before_event_index": before_event_index,
                "after_event_index": after_event_index,
                "before_total_tokens": safe_int(before.get("total_tokens")) if before else None,
                "after_total_tokens": safe_int(after.get("total_tokens")) if after else None,
                "delta_tokens": None,
                "before_fill_percent": before.get("context_fill_percent") if before else None,
                "after_fill_percent": after.get("context_fill_percent") if after else None,
            }
            if before and after:
                impact["delta_tokens"] = safe_int(after.get("total_tokens")) - safe_int(
                    before.get("total_tokens")
                )
            compaction_impacts.append(impact)

        stats = {
            "event_count": len(events),
            "turn_count": len(turns),
            "message_count": category_counts.get("message", 0),
            "reasoning_count": category_counts.get("reasoning", 0),
            "tool_call_count": category_counts.get("tool_call", 0),
            "tool_result_count": category_counts.get("tool_result", 0),
            "context_event_count": category_counts.get("context", 0),
            "system_event_count": category_counts.get("system", 0),
            "token_event_count": category_counts.get("token", 0),
            "compaction_signal_count": category_counts.get("compaction", 0),
            "compaction_event_count": len(compaction_impacts),
            "max_total_tokens": max_total_tokens,
            "max_context_window": max_context_window,
            "peak_fill_percent": (
                (max_total_tokens / max_context_window) * 100.0
                if max_context_window > 0
                else None
            ),
            "line_count": len(raw_lines),
        }

        parsed = ParsedConversation(
            mtime=mtime,
            raw_lines=raw_lines,
            events=events,
            stats=stats,
            token_series=token_series,
            compaction_impacts=compaction_impacts,
            turns=turns,
            tool_analytics_counts=tool_analytics_counts,
        )

        with self._lock:
            self._conversation_cache[conversation_id] = parsed

        return parsed


class TraceViewerHandler(SimpleHTTPRequestHandler):
    def __init__(
        self,
        *args: Any,
        store: RolloutStore,
        directory: str,
        **kwargs: Any,
    ) -> None:
        self.store = store
        super().__init__(*args, directory=directory, **kwargs)

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def end_headers(self) -> None:
        # Prevent stale frontend assets from being cached between rapid UI iterations.
        self.send_header("Cache-Control", "no-store, max-age=0, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self) -> None:
        parsed_url = urlparse(self.path)
        if parsed_url.path.startswith("/api/"):
            self._handle_api(parsed_url)
            return

        if parsed_url.path in {"", "/"}:
            self.path = "/index.html"
        elif "." not in Path(parsed_url.path).name:
            self.path = "/index.html"

        super().do_GET()

    def _send_json(self, payload: Any, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_error_json(self, status: int, message: str) -> None:
        self._send_json({"error": message, "status": status}, status=status)

    def _handle_api(self, parsed_url: Any) -> None:
        path_parts = [segment for segment in parsed_url.path.split("/") if segment]
        query = parse_qs(parsed_url.query)

        try:
            if path_parts == ["api", "health"]:
                self._send_json({"ok": True, "time": iso_from_epoch(time.time())})
                return

            if path_parts == ["api", "bootstrap"]:
                include_archived = query.get("include_archived", ["1"])[0] != "0"
                conversations = self.store.list_conversations(
                    include_archived=include_archived,
                    limit=200,
                )
                default_id = conversations[0].id if conversations else None
                self._send_json(
                    {
                        "default_conversation_id": default_id,
                        "conversation_count": len(conversations),
                        "conversations": [item.to_api_dict() for item in conversations],
                    }
                )
                return

            if path_parts == ["api", "tool-analytics"]:
                include_archived = query.get("include_archived", ["1"])[0] != "0"
                limit_raw = query.get("limit", ["12"])[0]
                limit = int(limit_raw) if isinstance(limit_raw, str) and limit_raw.isdigit() else 12
                analytics = self.store.get_tool_analytics(
                    include_archived=include_archived,
                    limit=max(4, min(limit, 30)),
                )
                self._send_json(analytics)
                return

            if path_parts == ["api", "conversations"]:
                include_archived = query.get("include_archived", ["1"])[0] != "0"
                limit = query.get("limit", [None])[0]
                parsed_limit = int(limit) if limit and limit.isdigit() else None
                search = query.get("q", [""])[0].strip() or None
                conversations = self.store.list_conversations(
                    query=search,
                    include_archived=include_archived,
                    limit=parsed_limit,
                )
                self._send_json(
                    {
                        "conversation_count": len(conversations),
                        "conversations": [item.to_api_dict() for item in conversations],
                    }
                )
                return

            if (
                len(path_parts) == 4
                and path_parts[0] == "api"
                and path_parts[1] == "conversations"
                and path_parts[3] == "events"
            ):
                conversation_id = path_parts[2]
                summary = self.store.get_summary(conversation_id)
                if summary is None:
                    self._send_error_json(404, f"Conversation not found: {conversation_id}")
                    return

                parsed = self.store.parse_conversation(conversation_id)
                if parsed is None:
                    self._send_error_json(500, "Failed to parse conversation")
                    return

                self._send_json(
                    {
                        "conversation": summary.to_api_dict(),
                        "stats": parsed.stats,
                        "token_series": parsed.token_series,
                        "compaction_impacts": parsed.compaction_impacts,
                        "turns": parsed.turns,
                        "events": parsed.events,
                        "tool_analytics": serialize_tool_analytics(
                            parsed.tool_analytics_counts,
                            threads_analyzed=1,
                            limit=12,
                        ),
                    }
                )
                return

            if (
                len(path_parts) == 5
                and path_parts[0] == "api"
                and path_parts[1] == "conversations"
                and path_parts[3] == "events"
            ):
                conversation_id = path_parts[2]
                event_index_raw = path_parts[4]
                if not event_index_raw.isdigit():
                    self._send_error_json(400, "Event index must be an integer")
                    return

                event_index = int(event_index_raw)
                parsed = self.store.parse_conversation(conversation_id)
                if parsed is None:
                    self._send_error_json(404, "Conversation not found")
                    return

                if event_index < 0 or event_index >= len(parsed.raw_lines):
                    self._send_error_json(404, "Event index out of bounds")
                    return

                raw_line = parsed.raw_lines[event_index]
                full_mode = query.get("full", ["0"])[0] == "1"
                try:
                    parsed_line = json.loads(raw_line)
                except json.JSONDecodeError as exc:
                    self._send_json(
                        {
                            "event_index": event_index,
                            "raw": raw_line,
                            "parse_error": str(exc),
                            "full": True,
                        }
                    )
                    return

                payload_to_send: Any = parsed_line
                truncated = False
                if not full_mode:
                    payload_to_send, truncated = shrink_for_json(parsed_line)

                event_meta = parsed.events[event_index]
                detail = render_event_detail(parsed_line)

                self._send_json(
                    {
                        "event_index": event_index,
                        "event_meta": event_meta,
                        "detail": detail,
                        "raw": payload_to_send,
                        "raw_truncated": truncated,
                        "full": full_mode,
                    }
                )
                return

            self._send_error_json(404, f"Unknown API route: {parsed_url.path}")

        except Exception as exc:
            print(f"[trace-viewer] API error for {parsed_url.path}: {exc}")
            self._send_error_json(500, "Internal server error")


def parse_json_string_if_possible(value: str) -> Any:
    try:
        return json.loads(value)
    except Exception:
        return None


def render_event_detail(event_line: dict[str, Any]) -> dict[str, Any]:
    top_type = event_line.get("type")
    payload = event_line.get("payload") if isinstance(event_line.get("payload"), dict) else {}

    if top_type == "session_meta":
        return {
            "kind": "session_meta",
            "thread_id": payload.get("id"),
            "timestamp": payload.get("timestamp"),
            "cwd": payload.get("cwd"),
            "originator": payload.get("originator"),
            "source": payload.get("source"),
            "cli_version": payload.get("cli_version"),
            "model_provider": payload.get("model_provider"),
            "git": payload.get("git"),
            "base_instructions": (
                payload.get("base_instructions", {}).get("text")
                if isinstance(payload.get("base_instructions"), dict)
                else None
            ),
        }

    if top_type == "turn_context":
        sandbox = payload.get("sandbox_policy") if isinstance(payload.get("sandbox_policy"), dict) else {}
        return {
            "kind": "turn_context",
            "turn_id": payload.get("turn_id"),
            "cwd": payload.get("cwd"),
            "approval_policy": payload.get("approval_policy"),
            "sandbox_policy": sandbox,
            "model": payload.get("model"),
            "personality": payload.get("personality"),
            "collaboration_mode": payload.get("collaboration_mode"),
            "effort": payload.get("effort"),
            "summary": payload.get("summary"),
            "truncation_policy": payload.get("truncation_policy"),
            "user_instructions": payload.get("user_instructions"),
            "developer_instructions": payload.get("developer_instructions"),
        }

    if top_type == "event_msg":
        subtype = payload.get("type")
        if subtype in {"user_message", "agent_message", "agent_reasoning"}:
            return {
                "kind": "event_message",
                "subtype": subtype,
                "text": payload.get("message") or payload.get("text"),
                "images": payload.get("images"),
                "local_images": payload.get("local_images"),
                "text_elements": payload.get("text_elements"),
                "turn_id": payload.get("turn_id"),
            }

        if subtype == "token_count":
            info = payload.get("info") if isinstance(payload.get("info"), dict) else {}
            token_snapshot = parse_token_usage_snapshot(info)
            total_usage = (
                token_snapshot.get("total_usage")
                if isinstance(token_snapshot.get("total_usage"), dict)
                else {}
            )
            last_usage = (
                token_snapshot.get("last_usage")
                if isinstance(token_snapshot.get("last_usage"), dict)
                else {}
            )
            window = safe_int(token_snapshot.get("model_context_window"))
            cumulative_total = safe_int(token_snapshot.get("cumulative_total_tokens"))
            context_total = safe_int(token_snapshot.get("context_tokens"))
            fill_pct = token_snapshot.get("context_fill_percent")
            return {
                "kind": "token_count",
                "context_tokens": context_total,
                "cumulative_tokens": cumulative_total,
                "total_usage": total_usage,
                "last_usage": last_usage,
                "model_context_window": window,
                "context_fill_percent": fill_pct,
                "rate_limits": payload.get("rate_limits"),
            }

        if subtype in {
            "exec_command_begin",
            "exec_command_end",
            "exec_command_output_delta",
            "mcp_tool_call_begin",
            "mcp_tool_call_end",
            "web_search_begin",
            "web_search_end",
        }:
            text_fields: dict[str, str] = {}
            for key in ("message", "output", "delta", "stdout", "stderr"):
                value = payload.get(key)
                if isinstance(value, str) and value:
                    text_fields[key] = value
            phase = "call" if subtype.endswith("_begin") else "result"
            return {
                "kind": "tool_event",
                "subtype": subtype,
                "phase": phase,
                "call_id": payload.get("call_id") or payload.get("id"),
                "name": payload.get("name") or payload.get("tool_name"),
                "status": payload.get("status"),
                "exit_code": payload.get("exit_code"),
                "duration_ms": payload.get("duration_ms") or payload.get("duration"),
                "text_fields": text_fields,
                "payload": payload,
            }

        return {
            "kind": "event",
            "subtype": subtype,
            "payload": payload,
        }

    if top_type == "response_item":
        subtype = payload.get("type")

        if subtype == "message":
            segments = []
            content = payload.get("content") if isinstance(payload.get("content"), list) else []
            for item in content:
                if not isinstance(item, dict):
                    continue
                item_type = item.get("type")
                if item_type in {"input_text", "output_text", "text", "summary_text"}:
                    segments.append({"kind": "text", "text": item.get("text")})
                elif item_type in {"input_image", "output_image"}:
                    segments.append({"kind": "image", "image_url": item.get("image_url")})
                else:
                    segments.append({"kind": item_type or "unknown", "value": item})

            return {
                "kind": "message",
                "role": payload.get("role"),
                "phase": payload.get("phase"),
                "segments": segments,
            }

        if subtype == "reasoning":
            summary = payload.get("summary") if isinstance(payload.get("summary"), list) else []
            summary_blocks = []
            for block in summary:
                if isinstance(block, dict):
                    summary_blocks.append(block.get("text") or block)
            return {
                "kind": "reasoning",
                "summary": summary_blocks,
                "has_encrypted_content": bool(payload.get("encrypted_content")),
            }

        if subtype in {"function_call", "custom_tool_call"}:
            raw_input = payload.get("arguments") if subtype == "function_call" else payload.get("input")
            parsed_input = parse_json_string_if_possible(raw_input) if isinstance(raw_input, str) else None
            return {
                "kind": "tool_call",
                "subtype": subtype,
                "name": payload.get("name"),
                "call_id": payload.get("call_id"),
                "status": payload.get("status"),
                "input_raw": raw_input,
                "input_parsed": parsed_input,
            }

        if subtype in {"function_call_output", "custom_tool_call_output"}:
            output = payload.get("output")
            output_text = None
            parsed_output = None

            if isinstance(output, str):
                parsed_candidate = parse_json_string_if_possible(output)
                if isinstance(parsed_candidate, (dict, list)):
                    parsed_output = parsed_candidate
                else:
                    output_text = output
            elif isinstance(output, (dict, list)):
                parsed_output = output

            return {
                "kind": "tool_result",
                "subtype": subtype,
                "call_id": payload.get("call_id"),
                "output_text": output_text,
                "output": output,
                "output_parsed": parsed_output,
            }

        if subtype == "web_search_call":
            return {
                "kind": "web_search_call",
                "status": payload.get("status"),
                "action": payload.get("action"),
            }

        return {
            "kind": "response_item",
            "subtype": subtype,
            "payload": payload,
        }

    if top_type == "compacted":
        replacement_history = payload.get("replacement_history")
        replacement_count = len(replacement_history) if isinstance(replacement_history, list) else 0
        return {
            "kind": "compacted",
            "message": payload.get("message"),
            "replacement_history_count": replacement_count,
        }

    return {"kind": "unknown", "event": event_line}


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Codex trace viewer")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind")
    parser.add_argument("--port", type=int, default=8123, help="Port to bind")
    parser.add_argument(
        "--codex-home",
        default=os.environ.get("CODEX_HOME", str(Path.home() / ".codex")),
        help="Path to CODEX_HOME (default: ~/.codex)",
    )
    parser.add_argument(
        "--open",
        action="store_true",
        help="Open browser to the trace viewer after server start",
    )
    return parser


def run_server(host: str, port: int, store: RolloutStore, open_browser: bool = False) -> None:
    handler_factory = partial(
        TraceViewerHandler,
        store=store,
        directory=str(STATIC_ROOT),
    )

    httpd = ThreadingHTTPServer((host, port), handler_factory)

    default_id = store.get_default_conversation_id()
    if default_id:
        launch_url = f"http://{host}:{port}/?conversation={default_id}"
    else:
        launch_url = f"http://{host}:{port}/"

    print(f"Trace viewer running at {launch_url}")
    print(f"Using CODEX_HOME={store.codex_home}")

    if open_browser:
        webbrowser.open(launch_url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


def main() -> None:
    parser = build_arg_parser()
    args = parser.parse_args()

    codex_home = Path(args.codex_home).expanduser().resolve()
    store = RolloutStore(codex_home)
    store.refresh_index(force=True)

    run_server(args.host, args.port, store, open_browser=args.open)


if __name__ == "__main__":
    main()
