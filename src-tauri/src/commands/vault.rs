//! 密码存储器（M5）：主密码加密保险库（setup / status / unlock / lock / CRUD）。
//!
//! 数据契约：`db/migrations.rs` v3 迁移中的 `vault_meta` 与 `vault_items`
//! （**不可改表结构**）。明文字段**永不落盘**——所有机密字段以
//! `*_enc` BLOB 存储，格式为 `12 字节随机 nonce || AES-256-GCM 密文（含 tag）`，
//! 每次写入生成新随机 nonce，绝不与同一密钥复用 nonce。
//!
//! 主密码流程：
//!   - 首次（未初始化）：`vault_setup` 生成 16 字节随机盐，经 Argon2id 派生 32 字节
//!     密钥（OWASP 基线参数 m=19456 KiB / t=2 / p=1），把盐与校验密文 verifier
//!     （固定常量串的 AES-GCM 密文）写入 `vault_meta`；**不存密钥、不存主密码**；
//!   - `vault_unlock`：重新派生密钥，解密 verifier 并做常数时间比较，成功后把密钥
//!     保存在 Rust 进程内存（`Mutex<Option<[u8; 32]>>`），失败返回中文错误；
//!   - `vault_lock`：从内存清除密钥（先整体置零再丢弃）。
//!
//! 安全红线：
//!   - 任何日志（println!/tracing）**不得**出现明文密码 / 密钥 / 机密内容；
//!   - 数据库中只有密文；明文仅存在于命令入参 / 返回值的内存传输过程中；
//!   - 所有命令均为 `async fn`（项目 P0 教训：同步命令会卡死 WebView2 COM STA）。

use std::sync::{Mutex, MutexGuard, OnceLock};

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::db;

// —— 加密参数（常量，评审可追溯）——

/// Argon2id 内存成本（KiB），OWASP 基线 19 MiB。
const ARGON2_M_COST_KIB: u32 = 19_456;
/// Argon2id 时间成本（迭代轮数）。
const ARGON2_T_COST: u32 = 2;
/// Argon2id 并行度。
const ARGON2_P_COST: u32 = 1;
/// 派生密钥长度（AES-256 需要 32 字节）。
const KEY_LEN: usize = 32;
/// 随机盐长度（字节）。
const SALT_LEN: usize = 16;
/// AES-GCM nonce 长度（字节）。
const NONCE_LEN: usize = 12;
/// verifier 明文常量：解密结果与之常数时间比较即证明密钥正确。
const VERIFIER_PLAINTEXT: &[u8] = b"toolbox-vault-ok";

/// `vault_meta` 表中的盐条目键名。
const META_SALT: &str = "salt";
/// `vault_meta` 表中的校验密文条目键名。
const META_VERIFIER: &str = "verifier";

/// 合法条目类别。
const CATEGORIES: &[&str] = &["login", "secret", "note"];

// —— 进程内密钥状态 ——

/// 密钥槽：解锁后持有派生密钥；锁定时为 `None`（且清除前整体置零）。
fn key_slot() -> &'static Mutex<Option<[u8; KEY_LEN]>> {
    static SLOT: OnceLock<Mutex<Option<[u8; KEY_LEN]>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// 短暂锁定密钥槽（复制密钥后立即释放锁，避免跨 await 持锁）。
fn lock_slot() -> Result<MutexGuard<'static, Option<[u8; KEY_LEN]>>, String> {
    key_slot().lock().map_err(|_| "密码库内部状态异常".to_string())
}

/// 取当前解锁密钥；未解锁返回统一中文错误。
fn current_key() -> Result<[u8; KEY_LEN], String> {
    let guard = lock_slot()?;
    guard.ok_or_else(|| "密码库已锁定，请先解锁".to_string())
}

/// 清除密钥槽（整体置零后再置 `None`，尽量减少密钥残留在已释放内存中）。
fn clear_key_slot() {
    if let Ok(mut guard) = key_slot().lock() {
        if let Some(key) = guard.as_mut() {
            key.fill(0);
        }
        *guard = None;
    }
}

// —— 密钥派生与加解密 ——

/// 经 Argon2id 从主密码 + 盐派生 32 字节密钥。
fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_LEN], String> {
    let argon = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(ARGON2_M_COST_KIB, ARGON2_T_COST, ARGON2_P_COST, Some(KEY_LEN))
            .map_err(|err| format!("初始化密钥派生参数失败：{err}"))?,
    );
    let mut key = [0u8; KEY_LEN];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|err| format!("密钥派生失败：{err}"))?;
    Ok(key)
}

/// AES-256-GCM 加密：输出 `nonce(12) || ciphertext+tag`。每次调用生成新随机 nonce。
fn encrypt_bytes(key: &[u8; KEY_LEN], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|err| format!("加密失败：{err}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// AES-256-GCM 解密：输入 `nonce(12) || ciphertext+tag`。
/// 认证失败（密钥错误 / 数据被篡改）返回统一中文错误，不泄露细节。
fn decrypt_bytes(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() <= NONCE_LEN {
        return Err("解密失败：密文数据损坏".to_string());
    }
    let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| "解密失败：数据已损坏或密钥不匹配".to_string())
}

/// 加密字符串字段。
fn encrypt_str(key: &[u8; KEY_LEN], plaintext: &str) -> Result<Vec<u8>, String> {
    encrypt_bytes(key, plaintext.as_bytes())
}

/// 解密字符串字段（UTF-8 校验失败视为数据损坏）。
fn decrypt_str(key: &[u8; KEY_LEN], blob: &[u8]) -> Result<String, String> {
    let bytes = decrypt_bytes(key, blob)?;
    String::from_utf8(bytes).map_err(|_| "解密失败：密文数据损坏".to_string())
}

/// 常数时间字节比较（长度不同直接返回 false——长度本身不是机密）。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// —— 数据访问 ——

/// 打开独立短连接（与 `notes.rs` / `todos.rs` 同策略；WAL 下读写并发安全）。
fn connect(app: &AppHandle) -> Result<Connection, String> {
    let path = db::db_path(app)?;
    db::open(&path)
}

/// 读取 `vault_meta` 单条（无该键返回 `Ok(None)`）。
fn read_meta(conn: &Connection, name: &str) -> Result<Option<Vec<u8>>, String> {
    match conn.query_row("SELECT value FROM vault_meta WHERE key = ?1", params![name], |row| {
        row.get::<_, Vec<u8>>("value")
    }) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(format!("读取密码库元数据失败：{err}")),
    }
}

/// 写入（覆盖）`vault_meta` 单条。
fn write_meta(conn: &Connection, name: &str, value: &[u8]) -> Result<(), String> {
    conn.execute(
        "INSERT INTO vault_meta (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![name, value],
    )
    .map_err(|err| format!("写入密码库元数据失败：{err}"))?;
    Ok(())
}

/// 密码库状态。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// 是否已完成初始化（`vault_meta` 中存在盐）。
    pub initialized: bool,
    /// 密钥当前是否在内存中（已解锁）。
    pub unlocked: bool,
}

/// 机密条目（面向前端的**明文**视图；serde camelCase 对齐 `types/vault.ts`）。
///
/// 注意：仅在 IPC 返回值中短暂存在，绝不写日志、绝不落盘。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultItem {
    pub id: i64,
    /// `login` | `secret` | `note`
    pub category: String,
    pub title: String,
    /// login：用户名；其余类别为 `None`。
    pub username: Option<String>,
    /// login：密码；secret：密钥/Token/私钥；note：正文。
    pub secret: String,
    /// login：网址。
    pub url: Option<String>,
    /// 备注（note 类别可复用为补充说明）。
    pub notes: Option<String>,
    /// ISO-8601（UTC）文本时间戳，与表结构 TEXT 约定一致。
    pub created_at: String,
    pub updated_at: String,
}

/// `vault_items` 行 → 实体（需已解锁的密钥做逐字段解密）。
fn row_to_item(row: &Row, key: &[u8; KEY_LEN]) -> rusqlite::Result<VaultItem> {
    let username_enc: Option<Vec<u8>> = row.get("username_enc")?;
    let secret_enc: Vec<u8> = row.get("secret_enc")?;
    let url_enc: Option<Vec<u8>> = row.get("url_enc")?;
    let notes_enc: Option<Vec<u8>> = row.get("notes_enc")?;

    // 逐字段解密：任何字段损坏都会让整条读取失败（宁可报错不显示错数据）。
    // String 错误经 From impl 装箱为 rusqlite 期望的 `Box<dyn Error + Send + Sync>`。
    let username = match username_enc {
        Some(blob) => {
            Some(decrypt_str(key, &blob).map_err(|err| rusqlite::Error::ToSqlConversionFailure(err.into()))?)
        }
        None => None,
    };
    let secret =
        decrypt_str(key, &secret_enc).map_err(|err| rusqlite::Error::ToSqlConversionFailure(err.into()))?;
    let url = match url_enc {
        Some(blob) => {
            Some(decrypt_str(key, &blob).map_err(|err| rusqlite::Error::ToSqlConversionFailure(err.into()))?)
        }
        None => None,
    };
    let notes = match notes_enc {
        Some(blob) => {
            Some(decrypt_str(key, &blob).map_err(|err| rusqlite::Error::ToSqlConversionFailure(err.into()))?)
        }
        None => None,
    };

    Ok(VaultItem {
        id: row.get("id")?,
        category: row.get("category")?,
        title: row.get("title")?,
        username,
        secret,
        url,
        notes,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// 当前 UTC 时间的 ISO-8601 文本（`vault_items.created_at/updated_at` 为 TEXT）。
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// 校验条目类别合法性。
fn validate_category(category: &str) -> Result<(), String> {
    if CATEGORIES.contains(&category) {
        Ok(())
    } else {
        Err(format!("未知的条目类别：{category}"))
    }
}

// —— 命令：库生命周期 ——

/// 首次初始化密码库：生成盐 → 派生密钥 → 写入盐与 verifier，并直接进入解锁态。
///
/// 已初始化时拒绝重复执行（重置需用户显式删除数据库文件，避免误清空机密）。
#[tauri::command]
pub async fn vault_setup(app: AppHandle, master_password: String) -> Result<VaultStatus, String> {
    if master_password.chars().count() < 6 {
        return Err("主密码至少需要 6 位".to_string());
    }

    let conn = connect(&app)?;
    if read_meta(&conn, META_SALT)?.is_some() {
        return Err("密码库已初始化，无需重复设置".to_string());
    }

    // 16 字节随机盐 + 派生 32 字节密钥（密钥只存在于栈与内存槽，绝不落盘）
    let mut salt = [0u8; SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let key = derive_key(&master_password, &salt)?;

    // verifier：常量串的 AES-GCM 密文；解锁时解密并常数时间比较以验证密钥
    let verifier = encrypt_str(&key, std::str::from_utf8(VERIFIER_PLAINTEXT).expect("常量为合法 UTF-8"))?;

    write_meta(&conn, META_SALT, &salt)?;
    write_meta(&conn, META_VERIFIER, &verifier)?;

    // 设置完成即视为解锁（用户刚输入主密码，无需再输一遍）
    *lock_slot()? = Some(key);
    Ok(VaultStatus {
        initialized: true,
        unlocked: true,
    })
}

/// 查询密码库状态（不涉及机密，锁定态也可调用）。
#[tauri::command]
pub async fn vault_status(app: AppHandle) -> Result<VaultStatus, String> {
    let conn = connect(&app)?;
    let initialized = read_meta(&conn, META_SALT)?.is_some();
    let unlocked = lock_slot()?.is_some();
    Ok(VaultStatus {
        initialized,
        unlocked,
    })
}

/// 解锁：重新派生密钥并用 verifier 校验；成功后密钥驻留进程内存。
#[tauri::command]
pub async fn vault_unlock(app: AppHandle, master_password: String) -> Result<VaultStatus, String> {
    let conn = connect(&app)?;
    let salt = read_meta(&conn, META_SALT)?
        .ok_or_else(|| "密码库未初始化，请先设置主密码".to_string())?;
    let verifier = read_meta(&conn, META_VERIFIER)?
        .ok_or_else(|| "密码库数据损坏：缺少校验信息".to_string())?;

    let key = derive_key(&master_password, &salt)?;
    let plain = decrypt_bytes(&key, &verifier).map_err(|_| "主密码错误".to_string())?;
    if !constant_time_eq(&plain, VERIFIER_PLAINTEXT) {
        return Err("主密码错误".to_string());
    }

    *lock_slot()? = Some(key);
    Ok(VaultStatus {
        initialized: true,
        unlocked: true,
    })
}

/// 锁定：从内存清除密钥（置零后丢弃）。
#[tauri::command]
pub async fn vault_lock() -> Result<(), String> {
    clear_key_slot();
    Ok(())
}

// —— 命令：条目 CRUD ——

/// 列出全部条目（逐字段解密）。锁定态直接报错，前端据此回退锁定页。
#[tauri::command]
pub async fn vault_list(app: AppHandle) -> Result<Vec<VaultItem>, String> {
    let key = current_key()?;
    let conn = connect(&app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, category, title, username_enc, secret_enc, url_enc, notes_enc, created_at, updated_at \
             FROM vault_items \
             ORDER BY CASE category WHEN 'login' THEN 0 WHEN 'secret' THEN 1 ELSE 2 END, updated_at DESC",
        )
        .map_err(|err| format!("查询密码库条目失败：{err}"))?;
    let items = stmt
        .query_map([], |row| row_to_item(row, &key))
        .map_err(|err| format!("查询密码库条目失败：{err}"))?
        .collect::<rusqlite::Result<Vec<VaultItem>>>()
        .map_err(|err| format!("解密密码库条目失败：{err}"))?;
    Ok(items)
}

/// 新建条目入参。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultItemInput {
    /// `login` | `secret` | `note`
    pub category: String,
    pub title: String,
    /// login：用户名。
    #[serde(default)]
    pub username: Option<String>,
    /// login：密码 / secret：密钥内容 / note：正文。
    pub secret: String,
    /// login：网址。
    #[serde(default)]
    pub url: Option<String>,
    /// 备注。
    #[serde(default)]
    pub notes: Option<String>,
}

/// 新建条目：明文字段逐个加密（每字段独立随机 nonce）后落库。
#[tauri::command]
pub async fn vault_create(app: AppHandle, input: VaultItemInput) -> Result<VaultItem, String> {
    validate_category(&input.category)?;
    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("标题不能为空".to_string());
    }
    if input.secret.is_empty() {
        return Err("机密内容不能为空".to_string());
    }

    let key = current_key()?;
    let username_enc = match &input.username {
        Some(v) if !v.is_empty() => Some(encrypt_str(&key, v)?),
        _ => None,
    };
    let secret_enc = encrypt_str(&key, &input.secret)?;
    let url_enc = match &input.url {
        Some(v) if !v.is_empty() => Some(encrypt_str(&key, v)?),
        _ => None,
    };
    let notes_enc = match &input.notes {
        Some(v) if !v.is_empty() => Some(encrypt_str(&key, v)?),
        _ => None,
    };

    let now = now_iso();
    let conn = connect(&app)?;
    conn.execute(
        "INSERT INTO vault_items (category, title, username_enc, secret_enc, url_enc, notes_enc, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![input.category, title, username_enc, secret_enc, url_enc, notes_enc, now, now],
    )
    .map_err(|err| format!("创建密码库条目失败：{err}"))?;
    let id = conn.last_insert_rowid();

    Ok(VaultItem {
        id,
        category: input.category,
        title,
        username: input.username.filter(|v| !v.is_empty()),
        secret: input.secret,
        url: input.url.filter(|v| !v.is_empty()),
        notes: input.notes.filter(|v| !v.is_empty()),
        created_at: now.clone(),
        updated_at: now,
    })
}

/// 编辑条目入参（仅 `Some` 字段会被更新；类别不可修改）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultItemPatch {
    pub title: Option<String>,
    pub username: Option<String>,
    pub secret: Option<String>,
    pub url: Option<String>,
    pub notes: Option<String>,
}

/// 更新条目：仅重加密被修改的字段（未修改字段保留原密文与 nonce）。
#[tauri::command]
pub async fn vault_update(
    app: AppHandle,
    item_id: i64,
    patch: VaultItemPatch,
) -> Result<VaultItem, String> {
    let key = current_key()?;
    let conn = connect(&app)?;

    // 读取现有密文（不存在的条目直接报错）
    let existing: Option<(String, Option<Vec<u8>>, Vec<u8>, Option<Vec<u8>>, Option<Vec<u8>>)> = conn
        .query_row(
            "SELECT title, username_enc, secret_enc, url_enc, notes_enc FROM vault_items WHERE id = ?1",
            params![item_id],
            |row| {
                Ok((
                    row.get("title")?,
                    row.get("username_enc")?,
                    row.get("secret_enc")?,
                    row.get("url_enc")?,
                    row.get("notes_enc")?,
                ))
            },
        )
        .map(Some)
        .or_else(|err| match err {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("查询密码库条目失败：{other}")),
        })?;
    let (old_title, old_username_enc, old_secret_enc, old_url_enc, old_notes_enc) =
        existing.ok_or_else(|| "条目不存在或已被删除".to_string())?;

    // 逐字段计算新密文：Some → 重加密；None → 保留原密文
    let title = match &patch.title {
        Some(v) => {
            let trimmed = v.trim().to_string();
            if trimmed.is_empty() {
                return Err("标题不能为空".to_string());
            }
            trimmed
        }
        None => old_title,
    };
    let username_enc = match &patch.username {
        Some(v) if !v.is_empty() => Some(encrypt_str(&key, v)?),
        Some(_) => None,
        None => old_username_enc,
    };
    let secret_enc = match &patch.secret {
        Some(v) => {
            if v.is_empty() {
                return Err("机密内容不能为空".to_string());
            }
            encrypt_str(&key, v)?
        }
        None => old_secret_enc,
    };
    let url_enc = match &patch.url {
        Some(v) if !v.is_empty() => Some(encrypt_str(&key, v)?),
        Some(_) => None,
        None => old_url_enc,
    };
    let notes_enc = match &patch.notes {
        Some(v) if !v.is_empty() => Some(encrypt_str(&key, v)?),
        Some(_) => None,
        None => old_notes_enc,
    };

    let now = now_iso();
    conn.execute(
        "UPDATE vault_items SET title = ?1, username_enc = ?2, secret_enc = ?3, url_enc = ?4, notes_enc = ?5, updated_at = ?6 \
         WHERE id = ?7",
        params![title, username_enc, secret_enc, url_enc, notes_enc, now, item_id],
    )
    .map_err(|err| format!("更新密码库条目失败：{err}"))?;

    // 回读并解密返回最新明文视图
    let mut stmt = conn
        .prepare(
            "SELECT id, category, title, username_enc, secret_enc, url_enc, notes_enc, created_at, updated_at \
             FROM vault_items WHERE id = ?1",
        )
        .map_err(|err| format!("查询密码库条目失败：{err}"))?;
    stmt.query_row(params![item_id], |row| row_to_item(row, &key))
        .map_err(|err| format!("读取更新后的条目失败：{err}"))
}

/// 删除条目。
#[tauri::command]
pub async fn vault_delete(app: AppHandle, item_id: i64) -> Result<(), String> {
    let conn = connect(&app)?;
    let affected = conn
        .execute("DELETE FROM vault_items WHERE id = ?1", params![item_id])
        .map_err(|err| format!("删除密码库条目失败：{err}"))?;
    if affected == 0 {
        return Err("条目不存在或已被删除".to_string());
    }
    Ok(())
}
