# 一键构建便携版：前端 -> 打包 -> 写图标/版本信息 ->（可选）部署
#
# 用法：
#   .\build.ps1                    自动判断：父目录已有程序就覆盖部署，否则只构建
#   .\build.ps1 -DeployTo "D:\某处" 构建后部署到指定目录
#   .\build.ps1 -NoDeploy          只构建，产物留在 dist-out\win-unpacked
param(
  [string]$DeployTo,
  [switch]$NoDeploy
)

$ErrorActionPreference = 'Stop'

$SRC = Split-Path -Parent $MyInvocation.MyCommand.Path
$APP = Join-Path $SRC 'app'
$TOOLS = Join-Path $SRC 'tools'
$REDIT = Join-Path $TOOLS 'winCodeSign\rcedit-x64.exe'
$OUT = Join-Path $SRC 'dist-out\win-unpacked'
$EXE = Join-Path $OUT 'DeepSeek Chat.exe'

# 部署目标：显式指定 > 父目录（老用法：源码在程序目录里）> 不部署
if ($DeployTo) {
  $ROOT = $DeployTo
} elseif (Test-Path (Join-Path (Split-Path -Parent $SRC) 'DeepSeek Chat.exe')) {
  $ROOT = Split-Path -Parent $SRC
} else {
  $ROOT = $null
}
if ($NoDeploy) { $ROOT = $null }

# 覆盖部署会删掉旧文件，程序开着时强行做会留下“半删”的坏状态，所以先检查、再动手
function Assert-AppClosed {
  if (-not $ROOT) { return }
  $procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$ROOT\*" })
  if ($procs.Count -gt 0) {
    throw ("检测到程序正在运行（PID: " + ($procs.Id -join ', ') + "）。请先完全退出 DeepSeek Chat 再构建；本次未改动任何文件。")
  }
}

function Assert-DeployTargetsWritable {
  if (-not $ROOT) { return }
  $locked = @()
  Get-ChildItem $OUT -Force | ForEach-Object {
    $t = Join-Path $ROOT $_.Name
    if ((Test-Path $t -PathType Leaf)) {
      try {
        $fs = [IO.File]::Open($t, 'Open', 'ReadWrite', 'None')
        $fs.Close()
      } catch {
        $locked += $_.Name
      }
    }
  }
  if ($locked.Count -gt 0) {
    throw ("这些文件被占用，请先关闭程序：" + ($locked -join ', '))
  }
}

Assert-AppClosed

Write-Host '== 1/5 构建前端' -ForegroundColor Cyan
Push-Location (Join-Path $SRC 'chat-demo')
$env:NODE_ENV = 'production'
& npx rspack build -c portable.config.ts
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '前端构建失败' }
Pop-Location

Write-Host '== 2/5 同步到 app\web' -ForegroundColor Cyan
$web = Join-Path $APP 'web'
if (Test-Path $web) { Remove-Item $web -Recurse -Force }
Copy-Item (Join-Path $SRC 'chat-demo\dist') $web -Recurse

Write-Host '== 3/5 打包便携版' -ForegroundColor Cyan
Push-Location $APP
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
if (Test-Path $OUT) { Remove-Item $OUT -Recurse -Force }
& npx electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '打包失败' }
Pop-Location

Write-Host '== 4/5 写入图标与版本信息' -ForegroundColor Cyan
if (-not (Test-Path $REDIT)) {
  Write-Host '  缺少 rcedit，自动获取…' -ForegroundColor Yellow
  & (Join-Path $TOOLS 'get-rcedit.ps1')
}
if (-not (Test-Path $REDIT)) { throw "缺少 rcedit：$REDIT" }
& $REDIT $EXE `
  --set-icon (Join-Path $APP 'build\icon.ico') `
  --set-file-version '1.0.0.0' `
  --set-product-version '1.0.0.0' `
  --set-version-string 'ProductName' 'DeepSeek Chat' `
  --set-version-string 'FileDescription' 'DeepSeek Chat' `
  --set-version-string 'OriginalFilename' 'DeepSeek Chat.exe' `
  --set-version-string 'LegalCopyright' 'chat-demo frontend: MIT License'
if ($LASTEXITCODE -ne 0) { throw 'rcedit 失败' }

if (-not $ROOT) {
  Write-Host ''
  Write-Host '== 5/5 跳过部署（未指定目标，或父目录不是程序目录）==' -ForegroundColor Yellow
  Write-Host ("构建产物：" + $OUT)
  exit 0
}

Write-Host '== 5/5 部署到程序目录' -ForegroundColor Cyan
Assert-AppClosed
Assert-DeployTargetsWritable
# 只清理运行时会覆盖的文件，绝不碰 源码\ 和 data\
$keep = @('源码', 'data')
Get-ChildItem $OUT -Force | Where-Object { $keep -notcontains $_.Name } | ForEach-Object {
  $target = Join-Path $ROOT $_.Name
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
}
Copy-Item (Join-Path $OUT '*') $ROOT -Recurse -Force

# 裁掉用不到的语言包（只留简中与英文），省约 45MB
Get-ChildItem (Join-Path $ROOT 'locales') -Filter '*.pak' | Where-Object { $_.Name -notin @('zh-CN.pak', 'en-US.pak') } | Remove-Item -Force

Write-Host ''
Write-Host '完成：' -ForegroundColor Green
Write-Host ("  " + (Join-Path $ROOT 'DeepSeek Chat.exe'))
$size = (Get-ChildItem $ROOT -Recurse -File | Where-Object { $_.FullName -notlike '*\源码\*' -and $_.FullName -notlike '*\data\*' } | Measure-Object Length -Sum).Sum
Write-Host ("  运行文件合计 " + [math]::Round($size / 1MB, 1) + ' MB')