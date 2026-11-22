# 获取 rcedit（仅 Windows 构建需要）
# electron-builder 会尝试从 GitHub 下载 winCodeSign 工具包，国内常常卡死，
# 所以这里直接从 npmmirror 镜像取，且只解出需要的 rcedit-x64.exe。
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $here 'winCodeSign\rcedit-x64.exe'
if (Test-Path $target) {
  Write-Host "rcedit 已存在：$target"
  exit 0
}

$archive = Join-Path $here 'winCodeSign-2.6.0.7z'
$url = 'https://npmmirror.com/mirrors/electron-builder-binaries/winCodeSign-2.6.0/winCodeSign-2.6.0.7z'

if (-not (Test-Path $archive)) {
  Write-Host "下载 winCodeSign-2.6.0.7z …"
  & curl.exe -sL --max-time 300 -o $archive $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $archive)) { throw '下载失败，请检查网络或手动下载后放到 tools\ 目录' }
}

Write-Host '解出 rcedit …'
New-Item -ItemType Directory -Path (Join-Path $here 'winCodeSign') -Force | Out-Null
# Windows 自带的 bsdtar 能读 7z；只解需要的那一个文件
& tar.exe -xf $archive -C (Join-Path $here 'winCodeSign') 'rcedit-x64.exe' 2>$null
if (-not (Test-Path $target)) {
  # 兜底：整体解压（会多出一些用不到的文件）
  & tar.exe -xf $archive -C (Join-Path $here 'winCodeSign') 2>$null
}
if (-not (Test-Path $target)) { throw 'rcedit 解压失败' }

Remove-Item $archive -Force -ErrorAction SilentlyContinue
Write-Host "完成：$target"