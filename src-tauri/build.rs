fn main() {
    // V55：强制 cargo 在 dist 目录变化时重新嵌入前端资源。
    // 默认 tauri_build 不会 emit rerun-if-changed 指向 frontendDist，
    // 导致前端改了但 cargo 增量编译跳过 build.rs → 嵌入的是旧资源。
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=../dist/index.html");
    tauri_build::build()
}
