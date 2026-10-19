#!/usr/bin/env python3
"""向项目记忆追加一条记录（DSH 版）。

把 SKILL.md 里的三条硬约束做成硬检查：
  1. 只追加（永远不重写整个文件）
  2. 拒绝疑似密钥（只指出键名，不回显值）
  3. 同名标题不重复追加

用法
    echo "- 结论：..." | python append_memory.py --title "修 Docker 构建失败"
    python append_memory.py --title "备份只有 .dtk 一种格式" --file memory < note.md
    python append_memory.py --title "上 HTTPS" --file playbook --root /path/to/repo < note.md
    python append_memory.py --title "..." --dry-run < note.md

目标：<项目根>/.dsh/memory/{YYYY-MM-DD.md | MEMORY.md | PLAYBOOK.md}
项目根：从 --root（默认 cwd）向上找最近的含 .git 的祖先；找不到就用起点本身。
（故意不把 .dsh 当根标记 —— ~/.dsh 是 DSH 自己的 home，会把主目录误判成项目根。）

退出码
    0  写入成功，或该标题已存在（未重复写）
    2  命中疑似密钥
    1  其它错误（空内容、标题过长等）
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import sys
from pathlib import Path

# ── 密钥检测 ────────────────────────────────────────────────────────────

# 键名里出现这些词就进入检查（不区分大小写）
SENSITIVE_STEMS = (
    "jwt_secret",
    "smtp_pass",
    "mail_pass",
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "auth_code",
    "授权码",
    "密码",
    "密钥",
    "令牌",
)

# 直接扫「敏感词 + 分隔符 + 值」，不复用「key: value」的分词结果 ——
# 否则「配置：JWT_SECRET=xxx」会被切成 key=配置 / value=JWT_SECRET=xxx，
# 真正的键名藏在 value 里，整行后半段就此漏检。
SENSITIVE_RE = re.compile(
    r"(" + "|".join(re.escape(stem) for stem in SENSITIVE_STEMS) + r")\s*[:=：]\s*"
    # 值的结束符要含中文标点：否则 `JWT_SECRET=xxx」会被…` 会把整句中文当成值（误报）
    r"([^\s,;，；、。：:！？!?（）()【】「」『』“”\"'《》]+)",
    re.IGNORECASE,
)

# 裸 JWT（即使没写键名也要拦）
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}")

MASKED_HINT = ("*", "…", "***")


def _is_masked(value: str) -> bool:
    """星号、尖括号占位、环境变量引用、省略号这类不算泄密。"""
    v = value.strip()
    if not v or v.startswith("$") or v.startswith("<"):
        return True
    if any(hint in v for hint in MASKED_HINT):
        return True
    return False


def find_secrets(text: str) -> list[str]:
    """返回命中的**键名**列表（绝不返回值本身）。"""
    hits: list[str] = []

    for match in SENSITIVE_RE.finditer(text):
        key, value = match.group(1), match.group(2)
        if _is_masked(value):
            continue
        # 纯数字（max_tokens=16384）与过短的值（enabled=true）不算凭据
        if value.isdigit() or len(value) < 5:
            continue
        hits.append(key)

    if JWT_RE.search(text):
        hits.append("<JWT 令牌>")

    # 去重保序
    return list(dict.fromkeys(hits))


# ── 目标文件 ────────────────────────────────────────────────────────────

FILE_KINDS = {
    "day": "{date}.md",
    "memory": "MEMORY.md",
    "playbook": "PLAYBOOK.md",
}


def find_project_root(start: Path) -> Path:
    """与 DSH 的 findProjectRoot 一致：最近的含 .git 祖先，都没有就用 start 本身。"""
    current = start.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return current


def resolve_target(root: Path, kind: str, date: str) -> Path:
    name = FILE_KINDS[kind].format(date=date)
    return root / ".dsh" / "memory" / name


# ── 追加 ────────────────────────────────────────────────────────────────


def build_block(title: str, body: str) -> str:
    return f"\n## {title}\n\n{body.strip()}\n"


def already_present(existing: str, title: str) -> bool:
    """整行比对，不用子串 —— 否则「标题X」会被「标题X-补充说明」误判成已存在。"""
    wanted = {f"## 追加：{title}", f"## {title}"}
    return any(line.strip() in wanted for line in existing.splitlines())


def read_stdin_text() -> str:
    """按字节读 stdin 再按 UTF-8 解码，回退 GBK —— 管道与 cp936 控制台都能过。"""
    raw = sys.stdin.buffer.read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gbk", errors="replace")


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001 - 只是尽量让中文能打印
        pass

    parser = argparse.ArgumentParser(description="向项目记忆追加一条记录（只追加，不覆盖）")
    parser.add_argument("--title", required=True, help="一句话标题，如「修 Docker 构建失败」")
    parser.add_argument(
        "--file",
        choices=sorted(FILE_KINDS),
        default="day",
        help="day=当日日志（默认）、memory=MEMORY.md、playbook=PLAYBOOK.md",
    )
    parser.add_argument("--root", default=None, help="项目根目录；默认从当前目录往上找 .git")
    parser.add_argument("--date", default=None, help="覆盖日期（YYYY-MM-DD），仅用于调试")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写文件")
    parser.add_argument("--force", action="store_true", help="标题已存在时仍然追加")
    args = parser.parse_args()

    title = " ".join(args.title.split())
    if not title:
        print("错误：标题为空", file=sys.stderr)
        return 1
    if len(title) > 120:
        print("错误：标题超过 120 字符，写短一点", file=sys.stderr)
        return 1

    body = read_stdin_text()
    if not body.strip():
        print("错误：正文为空（从 stdin 传入）", file=sys.stderr)
        return 1

    secrets = find_secrets(body + "\n" + title)
    if secrets:
        print(
            "拒绝写入：正文疑似包含凭据 —— " + "、".join(secrets) + "\n"
            "  记忆里只记「配置在哪个文件的哪个键」，不要记值。\n"
            "  确认是误报可以先用 **** 遮掉再写。",
            file=sys.stderr,
        )
        return 2

    root = Path(args.root) if args.root else find_project_root(Path.cwd())
    date = args.date or dt.date.today().isoformat()
    target = resolve_target(root, args.file, date)

    existing = target.read_text(encoding="utf-8") if target.exists() else ""
    if existing and already_present(existing, title) and not args.force:
        print(f"已存在同名条目，跳过：{target}")
        return 0

    block = build_block(title, body)
    if args.file == "day" and not existing:
        # 当天文件首次创建：补上真实产物都有的 `# YYYY-MM-DD` 首行
        block = f"# {date}\n{block}"

    if args.dry_run:
        print(f"# 目标：{target}")
        print(block)
        return 0

    # 先编码再碰文件：编码失败不该留下 0 字节的目标文件
    encoded = block.encode("utf-8")
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("ab") as handle:
        if existing and not existing.endswith("\n"):
            handle.write(b"\n")
        handle.write(encoded)

    print(f"已追加到 {target}（+{block.count(chr(10))} 行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
