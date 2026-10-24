#!/usr/bin/env bash
# rust-env.sh — 在 Git Bash 中注入 MSVC + cargo 环境。
# 用途：WorkBuddy 会话内 PowerShell 的 Start-Process 因环境块大小写重复键
#       (Path/PATH、http_proxy/HTTP_PROXY 等) 崩溃，cmd.exe 被安全层拦截，
#       因此所有 Rust 构建统一走：source 本脚本 + cargo 命令。
# 用法：source /d/_Projects/ops/handy/scripts/rust-env.sh && cargo check

export PATH="/c/Users/Administrator/.cargo/bin:/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC/14.44.35207/bin/Hostx64/x64:$PATH"

export INCLUDE='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\include;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\ucrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\um;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\shared;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\winrt;C:\Program Files (x86)\Windows Kits\10\Include\10.0.26100.0\cppwinrt'

export LIB='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207\lib\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\ucrt\x64;C:\Program Files (x86)\Windows Kits\10\Lib\10.0.26100.0\um\x64'

# MSVC 工具集/SDK 升级后需同步更新以上三个版本号：
#   MSVC 14.44.35207、Windows SDK 10.0.26100.0（与 scripts/msvc-env.ps1 的动态探测结果一致）
