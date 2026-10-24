//! 杂项系统查询命令（V72 新增）。
//!
//! 目前只有「端口占用查询」一项：解析 `netstat -ano` 与 `tasklist`，
//! 给出「协议 / 本地地址:端口 / 状态 / PID / 进程名」的清单，供工具箱「端口占用查询」使用。

use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortEntry {
    pub protocol: String,
    pub local_address: String,
    pub local_port: u16,
    pub remote_address: String,
    pub state: String,
    pub pid: u32,
    pub process_name: String,
}

/// 解析一行 CSV（兼容带引号字段，如 tasklist 的 `"Image Name"`）。
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_quotes {
            if c == '"' {
                // 双引号转义：连续两个引号表示一个引号字符
                if i + 1 < chars.len() && chars[i + 1] == '"' {
                    current.push('"');
                    i += 2;
                    continue;
                }
                in_quotes = false;
            } else {
                current.push(c);
            }
        } else if c == '"' {
            in_quotes = true;
        } else if c == ',' {
            fields.push(current.clone());
            current.clear();
        } else {
            current.push(c);
        }
        i += 1;
    }
    fields.push(current);
    fields
}

/// 收集 PID -> 进程名（用于反查端口占用者）。
#[cfg(windows)]
fn gather_pid_names() -> std::collections::HashMap<u32, String> {
    let mut map = std::collections::HashMap::new();
    let output = match Command::new("tasklist").args(["/NH", "/FO", "CSV"]).output() {
        Ok(o) => o,
        Err(_) => return map,
    };
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        let fields = parse_csv_line(line);
        if fields.len() < 2 {
            continue;
        }
        if let Ok(pid) = fields[1].trim().parse::<u32>() {
            map.insert(pid, fields[0].trim().to_string());
        }
    }
    map
}

#[cfg(windows)]
fn parse_netstat(stdout: &str, pid_names: &std::collections::HashMap<u32, String>) -> Vec<PortEntry> {
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 4 {
            continue;
        }
        let protocol = tokens[0].to_uppercase();
        if protocol != "TCP" && protocol != "UDP" {
            continue;
        }
        let local_address = tokens[1].to_string();
        let _remote_address = tokens[2].to_string();
        let (state, pid_str) = if protocol == "TCP" {
            // TCP 列： Proto / 本地 / 远程 / 状态 / PID
            (tokens.get(3).unwrap_or(&"").to_string(), tokens.get(4).copied())
        } else {
            // UDP 列： Proto / 本地 / 远程 / PID（无状态）
            ("".to_string(), tokens.get(3).copied())
        };
        let pid_str = match pid_str {
            Some(s) => s,
            None => continue,
        };
        let pid: u32 = match pid_str.parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let local_port = local_address
            .rsplit(':')
            .next()
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        let process_name = pid_names
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| "未知".to_string());
        entries.push(PortEntry {
            protocol,
            local_address,
            local_port,
            remote_address: _remote_address,
            state,
            pid,
            process_name,
        });
    }
    entries
}

#[cfg(windows)]
#[tauri::command]
pub fn port_occupants() -> Result<Vec<PortEntry>, String> {
    let pid_names = gather_pid_names();
    let output = Command::new("cmd")
        .args(["/c", "netstat -ano"])
        .output()
        .map_err(|e| format!("执行 netstat 失败：{e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_netstat(&text, &pid_names))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn port_occupants() -> Result<Vec<PortEntry>, String> {
    Err("端口查询目前仅支持 Windows".to_string())
}
