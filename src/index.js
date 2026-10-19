/**
 * dsh-project-memory —— 把"收尾必须写项目记忆"变成硬保证的宿主侧插件。
 *
 * 三个挂点，都是 DSH 的原生扩展点，不依赖 @deepseek-ai/dsh-hooks-claude-code
 * 桥、不起子进程、不需要 hooks.json：
 *
 *   agent/created       会话开始 → 建周期起点；可选注入三行提醒
 *   tools/post-execute  工具跑完 → 只记账，恒走 next()（绝不阻塞工具）
 *   agent/turn-stopping 要收尾 → 没写记忆则 agent.steer(理由)，强制再跑一轮
 *
 * 判定逻辑全在 ./guard.js（纯函数，可裸 node 单测）。
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decide,
  loadState,
  newCycle,
  pruneStates,
  recordActivity,
  resolveProjectRoot,
  saveState,
} from "./guard.js";

export const name = "project-memory";

export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 相对项目根的记忆目录。 */
  memoryDir: z.string().default(".dsh/memory"),
  /** 每个"工作 → 收尾"周期最多拦几次。1 = 拦一次就够；调大能逼两轮。 */
  maxBlocksPerCycle: z.number().default(1),
  /** 全会话硬上限，防止反常会话被无限续轮。 */
  maxBlocksTotal: z.number().default(6),
  /** 会话开始注入三行提醒（约 100 tokens），只在真需要规范时加载 SKILL.md。 */
  reminder: z.boolean().default(true),
  /** 状态文件保留天数。 */
  stateTtlDays: z.number().default(7),
});

/** 注入内容与 steer 消息的来源标记，便于日志辨认。 */
const SOURCE = { kind: "project-memory" };

function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  return fromEnv && fromEnv.trim() ? fromEnv : join(homedir(), ".dsh");
}

function sessionKey(agent) {
  const raw = String(agent?.session?.header?.id ?? "unknown");
  return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "unknown";
}

function reminderText(memoryDir) {
  return [
    `本机项目记忆在 ${memoryDir}（收尾前必须写；Stop 会拦一次）。`,
    "格式与规范：`skill project-memory`。要写时优先用同包的 append_memory.py 追加，别手搓格式。",
    "确实无可沉淀时，明确说一句「无需记录」+ 一句理由。",
  ].join("\n");
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<z.infer<typeof Config>>} raw
 */
export function apply(ctx, raw = {}) {
  const settings = {
    enabled: raw.enabled !== false,
    memoryDir: raw.memoryDir ?? ".dsh/memory",
    maxBlocksPerCycle: Number(raw.maxBlocksPerCycle ?? 1),
    maxBlocksTotal: Number(raw.maxBlocksTotal ?? 6),
    reminder: raw.reminder !== false,
    stateTtlDays: Number(raw.stateTtlDays ?? 7),
  };
  if (!settings.enabled) return;

  const stateRoot = join(dshHome(), "project-memory", "state");
  const here = dirname(fileURLToPath(import.meta.url));
  const appendScript = join(here, "..", "skills", "project-memory", "scripts", "append_memory.py");
  const warned = new Set();

  const warnOnce = (key, message) => {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      ctx.logger?.warn?.(`project-memory: ${message}`);
    } catch {
      /* logger 不在时忽略 */
    }
  };

  const locate = (agent) => {
    const cwd = agent?.session?.header?.cwd ?? process.cwd();
    const root = resolveProjectRoot(cwd);
    return { root, memoryDir: join(root, settings.memoryDir) };
  };

  const stateFileOf = (agent) => join(stateRoot, `${sessionKey(agent)}.json`);

  ctx.on("agent/created", ({ agent } = {}) => {
    try {
      pruneStates(stateRoot, settings.stateTtlDays * 24 * 60 * 60 * 1000);
      const file = stateFileOf(agent);
      const state = loadState(file);
      if (!state.cycleStart && !saveState(file, newCycle(state))) {
        warnOnce("unwritable", `状态目录不可写：${stateRoot}（本次会话不会拦截收尾）`);
      }
      if (settings.reminder) {
        const { memoryDir } = locate(agent);
        agent?.inject?.(
          createUserMessage({
            content: [{ type: "text", text: reminderText(memoryDir) }],
            source: SOURCE,
          }),
        );
      }
    } catch (error) {
      warnOnce("created", `会话起点记录失败：${error?.message ?? String(error)}`);
    }
  });

  ctx.on("tools/post-execute", (exec, result, next) => {
    try {
      const file = stateFileOf(exec?.agent);
      const state = loadState(file);
      const nextState = recordActivity(state, String(exec?.name ?? ""));
      if (nextState !== state && !saveState(file, nextState)) {
        warnOnce("unwritable", `状态目录不可写：${stateRoot}（本次会话不会拦截收尾）`);
      }
    } catch (error) {
      warnOnce("record", `工具记账失败：${error?.message ?? String(error)}`);
    }
    return next();
  });

  ctx.on("agent/turn-stopping", ({ agent } = {}) => {
    try {
      const file = stateFileOf(agent);
      const state = loadState(file);
      const { root, memoryDir } = locate(agent);
      const outcome = decide({ state, root, memoryDir, settings, appendScript });
      if (outcome.state !== state) saveState(file, outcome.state);
      if (!outcome.block) return;
      agent?.steer?.(
        createUserMessage({
          content: [{ type: "text", text: outcome.reason }],
          source: SOURCE,
        }),
      );
    } catch (error) {
      warnOnce("stop", `收尾判定失败：${error?.message ?? String(error)}`);
    }
  });
}
