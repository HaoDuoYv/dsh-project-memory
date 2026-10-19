import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decide,
  memoryTouchedSince,
  newCycle,
  recordActivity,
  resolveProjectRoot,
} from "../src/guard.js";

function makeProject({ git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pm-guard-"));
  if (git) mkdirSync(join(root, ".git"));
  return root;
}

function touchMemory(memoryDir, mtimeMs, name = "2026-10-20.md") {
  mkdirSync(memoryDir, { recursive: true });
  const file = join(memoryDir, name);
  writeFileSync(file, "## 测试\n\n- 一条记忆\n", "utf8");
  const seconds = mtimeMs / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}

const SETTINGS = { maxBlocksPerCycle: 1, maxBlocksTotal: 6 };

test("没动过手（无状态）→ 放行", () => {
  const root = makeProject();
  const out = decide({ state: {}, root, memoryDir: join(root, ".dsh/memory"), settings: SETTINGS });
  assert.equal(out.block, false);
});

test("一条命令不算动手，两条才算", () => {
  const root = makeProject();
  const memoryDir = join(root, ".dsh/memory");
  let state = newCycle({}, 1000);
  state = recordActivity(state, "pwsh", 1000);
  assert.equal(decide({ state, root, memoryDir, settings: SETTINGS, now: 2000 }).block, false);

  state = recordActivity(state, "pwsh", 2100);
  const out = decide({ state, root, memoryDir, settings: SETTINGS, now: 2200 });
  assert.equal(out.block, true);
  assert.match(out.reason, /没有本周期写入/);
  assert.match(out.reason, /\.dsh[\\/]memory/);
  assert.match(out.reason, /无需记录/);
});

test("改文件一次就算动手", () => {
  const root = makeProject();
  const state = recordActivity(newCycle({}, 1000), "write", 1000);
  const out = decide({ state, root, memoryDir: join(root, ".dsh/memory"), settings: SETTINGS });
  assert.equal(out.block, true);
});

test("同一周期只拦一次（自限次）", () => {
  const root = makeProject();
  const memoryDir = join(root, ".dsh/memory");
  const first = decide({
    state: recordActivity(newCycle({}, 1000), "write", 1000),
    root,
    memoryDir,
    settings: SETTINGS,
    now: 2000,
  });
  assert.equal(first.block, true);
  assert.equal(first.state.cycleBlocks, 1);

  const second = decide({ state: first.state, root, memoryDir, settings: SETTINGS, now: 3000 });
  assert.equal(second.block, false);
});

test("定稿后写过记忆 → 放行并开新周期", () => {
  const root = makeProject();
  const memoryDir = join(root, ".dsh/memory");
  const cycleStart = 10_000;
  const state = recordActivity(newCycle({}, cycleStart), "write", cycleStart);
  touchMemory(memoryDir, cycleStart + 5_000);

  const out = decide({ state, root, memoryDir, settings: SETTINGS, now: cycleStart + 9_000 });
  assert.equal(out.block, false);
  assert.equal(out.state.cycleBlocks, 0);
  assert.equal(out.state.fileWrites, 0);
  assert.ok(out.state.cycleStart > cycleStart, "应当开启新周期");
});

test("起点之前写的旧记忆顶不了账", () => {
  const root = makeProject();
  const memoryDir = join(root, ".dsh/memory");
  const now = Date.now();
  const cycleStart = now - 10_000;
  touchMemory(memoryDir, cycleStart - 60_000);
  const state = recordActivity(newCycle({}, cycleStart), "write", cycleStart);

  assert.equal(decide({ state, root, memoryDir, settings: SETTINGS, now }).block, true);
});

test("全会话硬上限到了就放行（防无限续轮）", () => {
  const root = makeProject();
  const memoryDir = join(root, ".dsh/memory");
  const state = { ...recordActivity(newCycle({}, 1000), "write", 1000), totalBlocks: 6 };
  assert.equal(decide({ state, root, memoryDir, settings: SETTINGS, now: 2000 }).block, false);
});

test("无关工具不记账（返回同一引用）", () => {
  const state = newCycle({}, 1000);
  assert.equal(recordActivity(state, "read", 1000), state);
  assert.equal(recordActivity(state, "todo_write", 1000), state);
});

test("resolveProjectRoot：有 .git 上溯，没有就用 cwd", () => {
  const plain = makeProject();
  assert.equal(resolveProjectRoot(plain), plain);

  const repo = makeProject({ git: true });
  const deep = join(repo, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  assert.equal(resolveProjectRoot(deep), repo);
});

test("memoryTouchedSince 只认 *.md", () => {
  const root = makeProject();
  const memoryDir = join(root, ".dsh/memory");
  touchMemory(memoryDir, 20_000, "notes.txt");
  assert.equal(memoryTouchedSince(memoryDir, 10_000), false);
  touchMemory(memoryDir, 20_000, "2026-10-20.md");
  assert.equal(memoryTouchedSince(memoryDir, 10_000), true);
  assert.equal(memoryTouchedSince(join(root, "nope"), 10_000), false);
});

test("总次数累加：第二次拦截要等新周期", () => {
  const root = makeProject();
  const memoryDir = join(root, ".dsh/memory");
  const settings = { maxBlocksPerCycle: 1, maxBlocksTotal: 6 };

  const first = decide({ state: recordActivity(newCycle({}, 1000), "write", 1000), root, memoryDir, settings, now: 2000 });
  assert.equal(first.state.totalBlocks, 1);

  // 写完记忆 → 新周期
  touchMemory(memoryDir, 3000);
  const afterWrite = decide({ state: first.state, root, memoryDir, settings, now: 3500 });
  assert.equal(afterWrite.block, false);

  // 新周期里又动手又没写 → 再拦一次，总次数累到 2
  const again = recordActivity(afterWrite.state, "write", 4000);
  const second = decide({ state: again, root, memoryDir, settings, now: 5000 });
  assert.equal(second.block, true);
  assert.equal(second.state.totalBlocks, 2);
});
