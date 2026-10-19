#!/usr/bin/env python3
"""项目记忆收尾守卫 —— DSH 钩子（SessionStart / PostToolUse / Stop）的命令实现。

挂在 ~/.dsh/hooks.json：
    SessionStart  → 记下本会话的起点时间（记忆只要在起点之后写过就算数）
    PostToolUse   matcher=write|edit|str_replace_editor|pwsh|run_code → 只记账，恒 exit 0
    Stop          → 本周期动过手却没写记忆则 exit 2（阻塞，强制补写一轮）

退出码协议（@deepseek-ai/dsh-hook-protocol）：
    0    放行
    2    阻塞：stderr 全文作为阻塞理由交给模型（Stop → agent.steer，强制再跑一轮）
    其它 非阻塞错误，钩子被忽略

设计约束：DSH 的钩子桥 stop_hook_active 恒为 false，也没有连击上限，
所以自限次必须由本脚本自己做 —— 否则一个无条件阻塞的 Stop 钩子会无限续轮。

状态：<DSH_HOME>/memory-guard/<session_id>.json（默认 ~/.dsh/memory-guard/）。
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

FILE_TOOLS = {"write", "edit", "str_replace_editor"}
SHELL_TOOLS = {"pwsh", "run_code"}

MAX_BLOCKS_PER_CYCLE = int(os.environ.get("DSH_MEMORY_GUARD_MAX_BLOCKS", "1"))
MAX_BLOCKS_PER_SESSION = int(os.environ.get("DSH_MEMORY_GUARD_MAX_TOTAL", "6"))
STATE_TTL_SECONDS = 7 * 24 * 3600
ENABLED = os.environ.get("DSH_MEMORY_GUARD", "on").strip().lower() not in ("off", "0", "false", "no")

MODES = ("session-start", "post-tool-use", "stop")


def dsh_home() -> Path:
    home = os.environ.get("DSH_HOME")
    return Path(home) if home else Path.home() / ".dsh"


def state_dir() -> Path:
    return dsh_home() / "memory-guard"


def resolve_root(cwd: Path) -> Path:
    """与 DSH 的 findProjectRoot 一致：最近的含 .git 祖先，没有就用 cwd。"""
    current = cwd.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return current


def session_key(payload: dict) -> str:
    raw = str(payload.get("session_id") or "unknown")
    safe = "".join(c if (c.isalnum() or c in "-_") else "_" for c in raw)
    return (safe or "unknown")[:80]


def load_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def save_state(path: Path, state: dict) -> bool:
    """写状态；失败返回 False，由调用方说出来 —— 绝不静默假装成功。"""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        return True
    except Exception:
        return False


def prune_states(root: Path) -> None:
    cutoff = time.time() - STATE_TTL_SECONDS
    try:
        for item in root.glob("*.json"):
            if item.stat().st_mtime < cutoff:
                item.unlink()
    except Exception:
        pass


def memory_touched_since(memory_dir: Path, since: float) -> bool:
    """记忆目录里任一 .md 在 since 之后被写过 —— 不关心用哪个工具写的。"""
    try:
        for item in memory_dir.glob("*.md"):
            if item.is_file() and item.stat().st_mtime >= since:
                return True
    except Exception:
        return False
    return False


def new_cycle(previous: dict) -> dict:
    return {
        "cycle_start": time.time(),
        "file_writes": 0,
        "shell_calls": 0,
        "cycle_blocks": 0,
        "total_blocks": int(previous.get("total_blocks") or 0),
    }


def start_session(path: Path) -> bool:
    state = load_state(path)
    if "cycle_start" in state:
        return True
    return save_state(path, new_cycle(state))


def record_activity(payload: dict, path: Path) -> bool:
    tool = str(payload.get("tool_name") or "")
    if tool not in FILE_TOOLS and tool not in SHELL_TOOLS:
        return True
    state = load_state(path)
    if "cycle_start" not in state:
        state = new_cycle(state)
    if tool in FILE_TOOLS:
        state["file_writes"] = int(state.get("file_writes") or 0) + 1
    else:
        state["shell_calls"] = int(state.get("shell_calls") or 0) + 1
    return save_state(path, state)


def block_reason(root: Path, state: dict) -> str:
    memory_dir = root / ".dsh" / "memory"
    today = time.strftime("%Y-%m-%d")
    append_script = Path(__file__).resolve().with_name("append_memory.py")
    return (
        "[project-memory 守卫] 本次会话动过手（改文件 {fw} 次 / 执行命令 {sh} 次），"
        "但 {md} 里没有本周期写入。\n"
        "收尾前补上一条记忆：\n"
        "  · 当日日志：{md}\\{day}.md（追加一个「## 追加：<一句话标题>」段落）\n"
        "  · 长期规则：{md}\\MEMORY.md　· 操作手册：{md}\\PLAYBOOK.md\n"
        "  · 或直接用脚本（正文从 stdin 传入）：\"{py}\" \"{append}\" --root \"{root}\" --title \"<标题>\"\n"
        "只记读代码看不出来的东西：为什么这么做、下次别踩的坑、谁定的约束。\n"
        "确实无可沉淀（纯查证 / 纯答疑）时，先明确说一句「无需记录」+ 理由，再结束。\n"
        "（本守卫在本次工作周期只拦这一次；写完记忆后正常结束即可。）"
    ).format(
        fw=int(state.get("file_writes") or 0),
        sh=int(state.get("shell_calls") or 0),
        md=memory_dir,
        day=today,
        py=sys.executable,
        append=append_script,
        root=root,
    )


def decide(payload: dict) -> str | None:
    cwd = Path(str(payload.get("cwd") or os.getcwd()))
    root = resolve_root(cwd)
    path = state_dir() / (session_key(payload) + ".json")
    state = load_state(path)
    if not state:
        return None

    cycle_start = float(state.get("cycle_start") or 0)
    evidence = int(state.get("file_writes") or 0) >= 1 or int(state.get("shell_calls") or 0) >= 2
    if not evidence:
        return None

    if memory_touched_since(root / ".dsh" / "memory", cycle_start):
        state.update({"cycle_start": time.time(), "file_writes": 0, "shell_calls": 0, "cycle_blocks": 0})
        save_state(path, state)
        return None

    if int(state.get("cycle_blocks") or 0) >= MAX_BLOCKS_PER_CYCLE:
        return None
    if int(state.get("total_blocks") or 0) >= MAX_BLOCKS_PER_SESSION:
        return None

    state["cycle_blocks"] = int(state.get("cycle_blocks") or 0) + 1
    state["total_blocks"] = int(state.get("total_blocks") or 0) + 1
    save_state(path, state)
    return block_reason(root, state)


def main(argv: list[str]) -> int:
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except Exception:
            pass

    mode = argv[1] if len(argv) > 1 else "stop"
    if mode not in MODES:
        return 0

    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    try:
        if not ENABLED:
            return 0
        payload.setdefault("cwd", os.getcwd())
        states = state_dir()
        prune_states(states)
        state_path = states / (session_key(payload) + ".json")

        if mode == "session-start":
            if not start_session(state_path):
                sys.stderr.write(f"[project-memory 守卫] 状态目录不可写：{states}（本次会话不会拦截收尾）\n")
            return 0

        if mode == "post-tool-use":
            if not record_activity(payload, state_path):
                sys.stderr.write(f"[project-memory 守卫] 状态目录不可写：{states}（本次会话不会拦截收尾）\n")
            return 0

        reason = decide(payload)
        if reason is None:
            return 0
        sys.stderr.write(reason)
        sys.stderr.flush()
        return 2
    except Exception:
        return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
