// 发布构建下隐藏 Windows 控制台窗口；调试构建保留控制台便于查看日志
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    handy_lib::run();
}
