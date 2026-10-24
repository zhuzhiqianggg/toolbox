//! IPC 命令汇总。
//!
//! 约定：命令名 `snake_case`，统一返回 `Result<T, String>`，`String` 为面向用户的中文可读信息。

pub mod app;
pub mod backup;
pub mod bar;
pub mod grid;
pub mod http;
pub mod misc;
pub mod notes;
pub mod organizer;
pub mod sys;
pub mod todos;
pub mod vault;
