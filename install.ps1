# install.ps1 — 把 dsh-project-manager 安装为 DSH 插件（profile bundle）
param(
    [string]$Profile = 'web'
)
$ErrorActionPreference = 'Stop'

Write-Host "通过 dsh plugin 安装到 profile '$Profile' ..."
dsh plugin --profile $Profile add $PSScriptRoot
if ($LASTEXITCODE -ne 0) { throw "dsh plugin 安装失败（exit $LASTEXITCODE）" }

Write-Host ""
Write-Host "✅ 插件已安装到 profile '$Profile'。"
Write-Host "请【重启 dsh web】（退出当前 dsh web 进程后重新 dsh web）以生效。"
Write-Host "验证：dsh --profile $Profile --dump-config 应出现 id: project-manager 的行；"
Write-Host "      设置页 → 插件 应出现「项目管理」卡片（项目启停 / 热重载 / 日志）。"
