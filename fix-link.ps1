# 修复 dsh-rooms 的链接
#
# 为什么需要这个：
#   profile 的 package.json 里 dsh-rooms 是 `link:` 到本目录。
#   pnpm install 有时会把 `link:E:/...` 当成相对路径，拼成
#   `C:\...\profiles\desktop\E:\...` 这种不存在的目标，
#   结果是 DSH 找不到插件、整个群功能消失（2026-11-16 发生过一次）。
#
# 用法（在 PowerShell 里）：
#   pwsh -File .\fix-link.ps1
#
# 幂等：链接正常时什么都不做。

$ErrorActionPreference = 'Stop'

$target = $PSScriptRoot
$profileDir = Join-Path $env:USERPROFILE '.dsh\profiles\desktop'
$link = Join-Path $profileDir 'node_modules\dsh-rooms'

if (-not (Test-Path $target)) {
  Write-Host "插件目录不存在: $target" -ForegroundColor Red
  exit 1
}

if (Test-Path $link) {
  $item = Get-Item $link -Force
  $actual = @($item.Target) -join ''
  if ($item.LinkType -eq 'Junction' -and $actual -eq $target) {
    Write-Host "链接正常: $link" -ForegroundColor Green
    exit 0
  }
  Write-Host "链接指向错误: $actual" -ForegroundColor Yellow
  Write-Host "重新建立..." -ForegroundColor Yellow
  # rmdir 只摘掉 junction，不会删目标目录里的文件
  cmd /c rmdir "$link" | Out-Null
}

New-Item -ItemType Junction -Path $link -Target $target | Out-Null
$item = Get-Item $link -Force
Write-Host "已修复: $link" -ForegroundColor Green
Write-Host "     -> $(@($item.Target) -join '')" -ForegroundColor Green
Write-Host ""
Write-Host "需要重启 DSH 才能让插件重新加载。" -ForegroundColor Cyan
