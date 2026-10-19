<#
.SYNOPSIS
    安装 dsh-project-memory 到本机 DSH。

.DESCRIPTION
    两条路线：
      plugin（默认）—— 装技能到 %DSH_HOME%\skills，并把本插件 insert 进 profile 补丁。
                        收尾守卫由插件自己（原生扩展点）负责，无子进程。
      hooks         —— 装技能 + 落 hooks.json + 挂 @deepseek-ai/dsh-hooks-claude-code 钩子桥。
                        收尾守卫由 python 脚本负责，每次命中工具调用起一个进程。

    两条路线都先备份再改；重复运行不会重复插条目。
    改完 profile 补丁后必须重启 DSH 才生效。

    注意：本文件必须保持 UTF-8 **带 BOM**（PS 5.1 会按 ANSI 解码无 BOM 文件，中文会破坏语法）。

.PARAMETER Route
    plugin | hooks

.PARAMETER ProfileName
    profile 名，默认 desktop。别名 -Profile。

.PARAMETER DshHome
    DSH home，默认 $env:DSH_HOME，否则 %USERPROFILE%\.dsh。

.PARAMETER DryRun
    只打印将要做的动作，不写任何文件。
#>
[CmdletBinding()]
param(
    [ValidateSet('plugin', 'hooks')]
    [string]$Route = 'plugin',

    [Alias('Profile')]
    [string]$ProfileName = 'desktop',

    [string]$DshHome = '',

    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$PackageRoot = $PSScriptRoot
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

if (-not $DshHome -or -not $DshHome.Trim()) {
    if ($env:DSH_HOME -and $env:DSH_HOME.Trim()) { $DshHome = $env:DSH_HOME }
    else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$ProfileDir = Join-Path $DshHome (Join-Path 'profiles' $ProfileName)
$PatchPath = Join-Path $ProfileDir 'cordis.patch.yml'

function Write-Step([string]$Message) { Write-Host "  $Message" }
function Write-Plan([string]$Message) { Write-Host "  [dry-run] $Message" }

if (-not (Test-Path $ProfileDir)) {
    throw "找不到 profile 目录：$ProfileDir （先用 dsh 启动一次该 profile，或用 -ProfileName 指定）"
}
if (-not (Test-Path $PatchPath)) {
    throw "找不到 $PatchPath （该 profile 还没有用户补丁层）"
}

# ── 1. 技能文件 ─────────────────────────────────────────────────────────
$skillSrc = Join-Path $PackageRoot 'skills\project-memory'
$skillDst = Join-Path $DshHome 'skills\project-memory'
Write-Host "[1/3] 技能 → $skillDst"
if ($DryRun) {
    Write-Plan "复制 $skillSrc 到 $skillDst"
} else {
    if (Test-Path $skillDst) {
        $backup = "$skillDst.bak-$Stamp"
        Copy-Item $skillDst $backup -Recurse -Force
        Write-Step "已备份旧技能：$backup"
    }
    New-Item -ItemType Directory -Force $skillDst | Out-Null
    Copy-Item (Join-Path $skillSrc '*') $skillDst -Recurse -Force
    Write-Step '已复制 SKILL.md / references / scripts'
}

# ── 2. 收尾守卫 ─────────────────────────────────────────────────────────
function Add-PatchEntry([string]$Marker, [string]$Yaml) {
    $text = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($PatchPath))
    if ($text.Contains($Marker)) {
        Write-Step "profile 补丁里已有 $Marker，跳过（不重复插）"
        return
    }
    if ($DryRun) {
        Write-Plan "往 $PatchPath 追加 $Marker 条目"
        return
    }
    Copy-Item $PatchPath "$PatchPath.bak-memory-$Stamp" -Force
    Write-Step "已备份补丁：$PatchPath.bak-memory-$Stamp"
    if (-not $text.EndsWith("`n")) { $text = $text + "`n" }
    [System.IO.File]::WriteAllText($PatchPath, $text + $Yaml, $Utf8NoBom)
    Write-Step "已追加 $Marker 条目"
}

if ($Route -eq 'plugin') {
    Write-Host '[2/3] 收尾守卫：原生插件（无子进程）'

    $pluginYaml = @"

# dsh-project-memory：收尾必须写项目记忆（原生插件，agent/turn-stopping）
- insert:
    - id: project-memory
      name: "dsh-project-memory"
      config:
        enabled: true
        memoryDir: .dsh/memory
        maxBlocksPerCycle: 1
        maxBlocksTotal: 6
        reminder: true
"@
    Add-PatchEntry -Marker 'dsh-project-memory' -Yaml $pluginYaml

    Write-Step '还差一步：把 dsh-project-memory 装进该 profile 的依赖'
    Write-Step "          dsh plugin --profile $ProfileName add dsh-project-memory"
    Write-Step '          并确认该 profile 的 package.json 里 dsh.profile.bundles 含 dsh-project-memory'
}
else {
    Write-Host '[2/3] 收尾守卫：hooks 桥 + python 脚本'

    $guard = Join-Path $PackageRoot 'hooks\memory_guard.py'
    $template = Join-Path $PackageRoot 'hooks\hooks.json'

    $python = Get-ChildItem (Join-Path $DshHome 'dsh-runtimes') -Recurse -Filter 'python.exe' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\dependencies\\python\\python\.exe$' } |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $python) {
        $python = (Get-Command python -ErrorAction SilentlyContinue).Source
    }
    if (-not $python) {
        throw '找不到 python.exe：DSH 运行时里没有，PATH 里也没有。装一个 Python 3，或改用 -Route plugin。'
    }
    Write-Step "python：$python"

    $hooksDst = Join-Path $DshHome 'hooks.json'
    $json = [System.Text.Encoding]::UTF8.GetString([System.IO.File]::ReadAllBytes($template))
    $json = $json.Replace('{{PYTHON}}', $python.Replace('\', '\\')).Replace('{{GUARD}}', $guard.Replace('\', '\\'))

    if ($DryRun) {
        Write-Plan "写 $hooksDst （守卫脚本 $guard）"
    } else {
        if (Test-Path $hooksDst) {
            Copy-Item $hooksDst "$hooksDst.bak-$Stamp" -Force
            Write-Step "已备份旧 hooks.json：$hooksDst.bak-$Stamp"
        }
        [System.IO.File]::WriteAllText($hooksDst, $json, $Utf8NoBom)
        Write-Step "已写 $hooksDst"
    }

    $configPath = $hooksDst.Replace('\', '/')
    $hooksYaml = @"

# 收尾守卫：Claude Code 风格钩子桥（Stop 上阻塞 = 强制再跑一轮）
- insert:
    - id: hooks-claude-code
      name: "@deepseek-ai/dsh-hooks-claude-code"
      config:
        configPath: $configPath
        defaultTimeoutMs: 20000
"@
    Add-PatchEntry -Marker 'dsh-hooks-claude-code' -Yaml $hooksYaml
}

# ── 3. 收尾提示 ─────────────────────────────────────────────────────────
Write-Host '[3/3] 完成'
Write-Host ''
Write-Host '  必须重启 DSH 才会生效（profile 补丁只在启动时读一次）。'
Write-Host '  技能正文改动不需要重启（每次加载都重读文件）。'
if ($Route -eq 'hooks') {
    Write-Host '  钩子路线：每条命中工具调用会起一个 python 进程；确认 hooks.json 里的路径真实存在。'
} else {
    Write-Host '  插件路线：确认该 profile 的 dsh.profile.bundles 含 dsh-project-memory。'
}
