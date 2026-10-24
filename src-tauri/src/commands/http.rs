//! 接口测试工具（api-tester，V28）—— Rust 侧直发 HTTP 请求。
//!
//! # 为什么必须走 Rust 而不是 webview `fetch`
//!
//! webview 里的 `fetch` 受 **CORS** 约束：目标服务器不回 `Access-Control-Allow-Origin`
//! 就只能拿到不可读的 opaque 响应（status 0、body 读不到）。而「接口测试」恰恰要
//! 测**任意来源**的接口（自己的后端、内网服务、不配 CORS 的第三方），所以请求必须
//! 由 Rust 侧发出 —— 与 Postman 同一条路，天然无 CORS。
//!
//! 浏览器预览（`npm run dev` / 冒烟）里没有 Tauri IPC，前端自动降级为 webview `fetch`
//! （此时受 CORS 限制，UI 有明确提示）。
//!
//! # 安全边界
//!
//! 这是用户本机的开发辅助：请求目标完全由用户输入决定（同 curl / Postman 等价），
//! 不做白名单；头部值、请求体只在内存中出现，**不落盘、不打日志**（项目红线：
//! 禁止明文日志敏感信息）。超时必设（默认 30 s），防止界面被一个不回包的服务卡死。

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// 请求头（行模型，与前端编辑列表一致）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeaderInput {
    pub key: String,
    pub value: String,
}

/// 请求描述（唯一入参）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestInput {
    /// HTTP 方法（GET / POST / ...，大小写不敏感）
    pub method: String,
    /// 完整 URL（含查询串；本工具不做参数表拆装，交给用户粘贴完整 URL）
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HttpHeaderInput>,
    /// 请求体原始文本（无体请求传空）
    #[serde(default)]
    pub body: String,
    /// 超时毫秒数（缺省 30 000；上限 120 000，防止把后端线程挂太久）
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// 响应头（返回给前端展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeaderOutput {
    pub name: String,
    pub value: String,
}

/// 响应描述。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponseOutput {
    /// HTTP 状态码（传输层失败时为 0）
    pub status: u16,
    /// 状态文本（如 "OK"；传输失败时为空串）
    pub status_text: String,
    /// 是否 2xx
    pub ok: bool,
    /// 从发起到收完响应体的耗时
    pub duration_ms: u64,
    /// 响应体字节数
    pub size_bytes: u64,
    /// 响应头（顺序保留）
    pub headers: Vec<HttpHeaderOutput>,
    /// 响应体文本（非 UTF-8 字节按替换符展示；二进制响应请看体积）
    pub body: String,
    /// 最终 URL（跟随重定向后的地址）
    pub final_url: String,
}

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

/// 发送一次 HTTP 请求。
///
/// 4xx / 5xx **不是错误**（照常返回完整响应，前端按状态分档着色）；
/// 只有 DNS / 连接 / 超时等传输层失败才走 `Err`（中文可读信息）。
#[tauri::command]
pub async fn http_request(input: HttpRequestInput) -> Result<HttpResponseOutput, String> {
    let timeout_ms = input
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1, MAX_TIMEOUT_MS);

    let method = reqwest::Method::from_bytes(input.method.trim().to_ascii_uppercase().as_bytes())
        .map_err(|_| format!("不支持的 HTTP 方法：{}", input.method.trim()))?;

    let url = reqwest::Url::parse(input.url.trim())
        .map_err(|e| format!("URL 无效：{e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("仅支持 http(s) 协议".to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        // 不自动启用 gzip：避免「体积与 body 对不上」的困惑，也让 sizeBytes 恒等于真实字节数
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))?;

    let mut request = client.request(method, url);
    for header in &input.headers {
        let key = header.key.trim();
        if key.is_empty() {
            continue;
        }
        let name = reqwest::header::HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("头部名无效：「{key}」（只能含 ASCII 可打印字符）"))?;
        let value = reqwest::header::HeaderValue::from_str(header.value.as_str())
            .map_err(|_| format!("头部值无效：「{key}」（值里不能有换行或非 ASCII 控制字符）"))?;
        request = request.header(name, value);
    }
    // GET / HEAD 不带体（reqwest 会拒绝 body on GET）
    let has_body = !input.body.is_empty()
        && !matches!(input.method.trim().to_uppercase().as_str(), "GET" | "HEAD");
    if has_body {
        request = request.body(input.body.clone());
    }

    let started = Instant::now();
    let response = request
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求超时（{timeout_ms} ms）—— 服务无响应或网络不通")
            } else if e.is_connect() {
                format!("连接失败：{e}")
            } else if e.is_decode() {
                format!("响应读取失败：{e}")
            } else {
                format!("请求失败：{e}")
            }
        })?;

    let status = response.status();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let final_url = response.url().to_string();
    let mut headers = Vec::new();
    for (name, value) in response.headers() {
        headers.push(HttpHeaderOutput {
            name: name.as_str().to_string(),
            value: String::from_utf8_lossy(value.as_bytes()).to_string(),
        });
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("响应体读取失败：{e}"))?;
    let duration_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);

    Ok(HttpResponseOutput {
        status: status.as_u16(),
        status_text,
        ok: status.is_success(),
        duration_ms,
        size_bytes: bytes.len() as u64,
        headers,
        body: String::from_utf8_lossy(&bytes).to_string(),
        final_url,
    })
}
