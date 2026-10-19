/**
 * 决策核心 —— 不 import 任何宿主模块，所以能用裸 node 单测。
 *
 * 规则来自 memory_guard.py 的实测结论：
 *   1. 没动过手（无状态）→ 放行
 *   2. 改过文件，或跑过 ≥2 条命令 → 才算"动过手"
 *   3. 记忆目录里任一 *.md 的 mtime ≥ 本周期起点 → 已写，放行并开新周期
 *   4. 每周期最多拦 1 次、每会话最多拦 6 次 —— 必须自限次，
 *      因为 DSH 的 Stop 拦截会 agent.steer() 再来一轮，无条件阻塞会无限续轮
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

/** 一次调用就算"动过手"的工具。 */
export const FILE_TOOLS = new Set(["write", "edit", "str_replace_editor"]);

/** 要累计到阈值才算"动过手"的工具（纯查证不该触发拦截）。 */
export const SHELL_TOOLS = new Set(["pwsh", "bash", "run_code", "shell"]);

/** 与 DSH 的 findProjectRoot 一致：最近的含 .git 祖先，没有就用 cwd。
 *  故意不认 `.dsh` 标记 —— `~/.dsh` 是 DSH 自己的 home，会把主目录判成项目根。 */
export function resolveProjectRoot(cwd) {
  const start = resolve(cwd);
  let current = start;
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

/** 记忆目录里任一 *.md 在 sinceMs 之后被写过吗（不关心用什么工具写的）。 */
export function memoryTouchedSince(memoryDir, sinceMs) {
  let names;
  try {
    names = readdirSync(memoryDir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      if (statSync(join(memoryDir, name)).mtimeMs >= sinceMs) return true;
    } catch {
      /* 列目录后被删，忽略 */
    }
  }
  return false;
}

export function newCycle(previous = {}, now = Date.now()) {
  return {
    cycleStart: now,
    fileWrites: 0,
    shellCalls: 0,
    cycleBlocks: 0,
    totalBlocks: Number(previous?.totalBlocks) || 0,
  };
}

export function loadState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 写状态；失败返回 false，由调用方决定怎么说 —— 不静默假装成功。 */
export function saveState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), "utf8");
    return true;
  } catch {
    return false;
  }
}

export function pruneStates(dir, ttlMs, now = Date.now()) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      if (statSync(join(dir, name)).mtimeMs < now - ttlMs) unlinkSync(join(dir, name));
    } catch {
      /* 忽略 */
    }
  }
}

/** 记一次工具调用；未命中工具集合时原样返回。 */
export function recordActivity(state, toolName, now = Date.now()) {
  if (!FILE_TOOLS.has(toolName) && !SHELL_TOOLS.has(toolName)) return state;
  const next = state && state.cycleStart ? { ...state } : newCycle(state, now);
  if (FILE_TOOLS.has(toolName)) next.fileWrites = (Number(next.fileWrites) || 0) + 1;
  else next.shellCalls = (Number(next.shellCalls) || 0) + 1;
  return next;
}

/** 给模型的阻塞理由。 */
export function buildReason({ root, memoryDir, state, appendScript }) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `[project-memory] 本次会话动过手（改文件 ${Number(state.fileWrites) || 0} 次 / 执行命令 ${Number(state.shellCalls) || 0} 次），`,
    `但 ${memoryDir} 里没有本周期写入。`,
    "收尾前补上一条记忆：",
    `  · 当日日志：${join(memoryDir, `${today}.md`)}（追加一个「## <一句话标题>」段落）`,
    `  · 长期规则：${join(memoryDir, "MEMORY.md")}　· 操作手册：${join(memoryDir, "PLAYBOOK.md")}`,
  ];
  if (appendScript) {
    lines.push(`  · 或直接用脚本（正文从 stdin 传入）：python "${appendScript}" --root "${root}" --title "<标题>"`);
  }
  lines.push(
    "只记读代码看不出来的东西：为什么这么做、下次别踩的坑、谁定的约束。",
    "确实无可沉淀（纯查证 / 纯答疑）时，先明确说一句「无需记录」+ 理由，再结束。",
    "（本守卫在本次工作周期只拦这一次；写完记忆后正常结束即可。）",
  );
  return lines.join("\n");
}

/**
 * 收尾判定。返回 { block, state, reason }；state 是**应当持久化**的新状态。
 * 不改入参、不碰磁盘 —— 纯函数，便于单测。
 */
export function decide({ state, root, memoryDir, now = Date.now(), settings = {}, appendScript }) {
  if (!state || !state.cycleStart) return { block: false, state };

  const fileWrites = Number(state.fileWrites) || 0;
  const shellCalls = Number(state.shellCalls) || 0;
  if (fileWrites < 1 && shellCalls < 2) return { block: false, state };

  if (memoryTouchedSince(memoryDir, Number(state.cycleStart))) {
    return { block: false, state: newCycle(state, now) };
  }

  const maxPerCycle = Number(settings.maxBlocksPerCycle ?? 1);
  const maxTotal = Number(settings.maxBlocksTotal ?? 6);
  const cycleBlocks = Number(state.cycleBlocks) || 0;
  const totalBlocks = Number(state.totalBlocks) || 0;
  if (cycleBlocks >= maxPerCycle || totalBlocks >= maxTotal) return { block: false, state };

  const next = { ...state, cycleBlocks: cycleBlocks + 1, totalBlocks: totalBlocks + 1 };
  return { block: true, state: next, reason: buildReason({ root, memoryDir, state: next, appendScript }) };
}
