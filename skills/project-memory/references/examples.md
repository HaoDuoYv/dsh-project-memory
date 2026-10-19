# 好条目与坏条目

下面全是真实发生过的记录。看**为什么**好、为什么坏，比背模板有用。

## 一、症状要写成能被搜到的样子

**坏**：

```markdown
- 修了云端部署的数据库报错，是权限问题，chown 一下就好了。
```

三个月后真遇到这个问题的人，搜不到「权限」「chown」以外的任何关键词，
而他的报错长这样：`SqliteError: attempt to write a readonly database`。
这条记录等于没写。

**好**：

```markdown
## 追加：线上 SQLITE_READONLY（数据目录属主不对）

报错：`SqliteError: attempt to write a readonly database` at `issueCode`。

- 不是代码 bug：容器 `USER node`(uid 1000)，compose 把宿主机 `./data` 挂进去，
  而目录属主是 root → 启动能过（目录已存在），第一次写库才炸
- 修法（**宿主机上**，别进容器改）：`sudo chown -R 1000:1000 ./data` + restart
- SELinux 场景（`getenforce` = Enforcing）：`chcon -Rt svirt_sandbox_file_t ./data`
```

关键：**原样贴报错串**，加上「为什么会这样」那一句 —— 后者是读代码永远看不出来的。

## 二、结论 + 理由，不是只有动作

**坏**：

```markdown
- 删掉了 JSON 备份通道，统一用 .dtk。
```

**好**：

```markdown
- 备份只保留 `.dtk` 一种格式：JSON 把图片 base64 内嵌，8MB 的库导出后体积翻几倍、
  导出时容易 OOM，而且两条通道意味着两套导入代码要同时维护
```

理由才是将来有人想"要不加回 JSON 吧"时要读的东西。

## 三、要记"反直觉"，不要记"顺利"

顺利做完的事，代码和 git log 都说得清。值得写的是**猜错的地方**：

**好**：

```markdown
- **坑**：`package.json` 写的是 `^11.5.0`，但 lockfile 实际锁的是 11.10.0。
  查镜像产物时按 11.5.0 查，会得到"镜像上没有"的错误结论
```

```markdown
- 图片跨设备靠 mediaId，不靠文件名：块内容是 `"<mediaId>|<uri>"`。
  **别再回到 `block.content.contains("media/xxx")`** —— 内部路径是 `images/img_xxx.png`，
  恒匹配不上（历史 bug：同机看不出来、换机全是裂图）
```

注意这两条都写了「**别再**」—— 记忆的一个重要作用是挡住"看起来更简洁"的回头路。

## 四、长期文件只留规则

`MEMORY.md` 是规则清单，不是流水账。同一个事实，日志里可以有过程，MEMORY 里只有一句。

**日志里**（可以有过程、端口、报错原文）：

```markdown
## 追加：adb 位置复核

- 两个 adb：MuMu 自带 36.0.0、SDK 自带 37.0.0，都不在 PATH
- 端口这次是 16525（历史是 16384），会变
- 判断模拟器是否在跑：有 MuMuNxMain 不算，要看有没有 nemu/qemu 虚拟机进程
```

**MEMORY / PLAYBOOK 里**（只留可执行的规则）：

```markdown
## 本地调试云端服务
- 环境有 `http_proxy`：curl 打本机 8787 会被代理拦（报"目标计算机积极拒绝"）
  → 必须 `--noproxy "*"`
- bash 调用结束会回收该次起的后台进程 → 起服务 + 发请求要写在**同一次调用**里
```

## 五、绝对不要写进去的

```markdown
- JWT_SECRET=4e66d5f0aaa114eff2227f950328ff79...   ← 永远不要
- SMTP_PASS=kjqxasfwzpaadfaj                        ← 永远不要
```

正确写法：

```markdown
- 已按用户给的值写好 `server/.env`：SMTP 走 smtp.qq.com/465，`REQUIRE_EMAIL_VERIFICATION=true`。
  **密钥本身不进记忆**
```

只记「哪个文件的哪个键、怎么配、验证过没有」，不记值。密钥会过期、会轮换，
写进记忆只会让它多一处泄露面，还容易过时。

## 六、不要把交付物写进记忆

**坏**（把回答当成了记忆的替代）：

```markdown
- 用户问 adb 在哪，我告诉他 adb 在 MuMu 目录下。
```

这不是记忆，这是对话记录。记忆里该留的是**下次还用得上的结论**（两个 adb 的路径与版本、
怎么判断模拟器有没有真启动），而且要在**回答用户之后**才写。

## 七、DSH 侧的位置与守卫（别写错路径）

- 项目记忆在 `<项目根>/.dsh/memory/`，**不是** `~/.dsh/memory/`，也不是旧的 `.workbuddy/memory/`。
- 项目根 = 最近的含 `.git` 的祖先目录；没有 `.git` 时就是会话 cwd。
- 收尾守卫（`~/.dsh/hooks.json` → `skills/project-memory/scripts/memory_guard.py`）会在
  「本次会话动过手但 `.dsh/memory/` 没有本周期写入」时用 `Stop` 钩子拦一次，
  用 `exit 2` + stderr 文字强制补写。**被拦了就立刻补写，别重复解释。**
