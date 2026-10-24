#!/usr/bin/env bash
# RichMarkdown「代码块里的回车」回归驱动（V67）。
#
# # 为什么是独立脚本、不能塞进 smoke-richmarkdown.js
#
# `smoke-richmarkdown.js` 是一个 IIFE，靠 `execCommand('insertText' | 'insertParagraph')`
# 驱动 —— 这两条命令**不触发 keydown**，而代码块的换行逻辑（`handlePreEnter` /
# `insertNewlineInPre`）全挂在 `onKeyDown` 上。要测它就必须用**真实按键**，
# 也就是 `agent-browser press Enter`，那是 shell 侧的事。所以另开这一个。
#
# # 用法
#
#   bash scripts/smoke-richmarkdown-enter.sh                 # 自己起 vite（[::1]:1420）
#   BASE=http://[::1]:1420 bash scripts/smoke-richmarkdown-enter.sh
#
# 需要 `agent-browser` 在 PATH 上。断言失败以非 0 退出。
#
# # 钉住的四条行为（前三条都是 09-22 用户「便签 markdown 编辑器有问题」的现场）
#
# 1. **挂载态回车必须换行**：从库里读回来的代码块内容以 `\n` 收尾，旧判据把它当成
#    「用户刚换过行」→ 第一下回车被判成收尾，不换行还把人踢出块外。
# 2. **换行之后敲的字必须落在下一行**：旧写法把 `\n` 插成独立文本节点，Chrome 会把
#    「节点开头的换行」当成上一行行尾，接着敲的字全被插到换行**之前**（两行粘一起）。
# 3. **连按两下回车才收尾**，单次回车永不收尾、也永不吞内容。
# 4. 普通段落回车不受影响。
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

SEL='[aria-label="所见即所得输入框"]'
VITE_PID=''
BASE="${BASE:-http://[::1]:1420}"

if [ -z "${BASE_READY:-}" ]; then
  node node_modules/vite/bin/vite.js --port 1420 --strictPort >/dev/null 2>&1 &
  VITE_PID=$!
  for _ in $(seq 1 30); do
    sleep 1
    curl -s -o /dev/null "http://[::1]:1420/index.html" && break
  done
fi
URL="$BASE/index.html?demo=richmarkdown"

PASS=0
FAIL=0
ok() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
no() { echo "  FAIL  $1"; echo "        want: $2"; echo "        got:  $3"; FAIL=$((FAIL + 1)); }

# `agent-browser eval` 的返回值是一个 JSON 编码过的字符串 → 解两层取字段。
# 值为「可见化」过的文本：换行显示成字面 `\n`、零宽空格显示成 `<Z>`。
field() {
  python -c "
import json, sys
raw = sys.stdin.read().strip()
if raw.startswith('\"'):
    raw = json.loads(raw)
try:
    print(json.loads(raw).get('$1', '<missing>'))
except Exception:
    print('<unparseable>')
"
}
# 逐字符输入：每字符等 30ms 让 React 刷一帧，等价于真人敲键
# （`agent-browser keyboard type` 零间隔，React 侧会漏事件 —— 与 smoke-richmarkdown.js 同一结论）
TYPE_JS='(async () => { const ed = document.querySelector("[aria-label=\"所见即所得输入框\"]"); ed.focus(); for (const ch of (window.__t || "")) { document.execCommand("insertText", false, ch); await new Promise((r) => setTimeout(r, 30)); } return "ok"; })()'
REPORT_JS='(() => { const ed = document.querySelector("[aria-label=\"所见即所得输入框\"]"); const vis = (s) => String(s == null ? "" : s).replace(/\u200B/g, "<Z>").replace(/\n/g, "\\n"); const sel = window.getSelection(); const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null; const pre = ed.querySelector("pre"); const srcEl = document.querySelector("[data-testid=\"md-source\"]"); return JSON.stringify({ codeText: vis(ed.querySelector("pre code") ? ed.querySelector("pre code").textContent : "-"), source: vis(srcEl ? srcEl.textContent : ""), inPre: pre !== null && r !== null && pre.contains(r.startContainer) }); })()'
MOUNT_JS='(() => { const ed = document.querySelector("[aria-label=\"所见即所得输入框\"]"); ed.focus(); ed.innerHTML = "<pre><code class=\"language-shell\">测试\n</code></pre>"; const code = ed.querySelector("pre code"); const r = document.createRange(); r.selectNodeContents(code); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return "mounted"; })()'

type_text() {
  agent-browser eval "window.__t=$(printf '%s' "$1" | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))'); $TYPE_JS" >/dev/null 2>&1
}
reload() {
  agent-browser open "$URL" >/dev/null 2>&1
  agent-browser wait --load load >/dev/null 2>&1
  agent-browser click "$SEL" >/dev/null 2>&1
}
# 用 `?md=<百分号编码>` 灌初值再打开 —— 走的是**真实挂载路径**
# （`root.innerHTML = renderMarkdown(value)` + 补尾锚 + 上色），见 RichMarkdownDemo 的注释。
reload_md() {
  local enc
  enc=$(printf '%s' "$1" | python -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.stdin.read()))')
  agent-browser open "$BASE/index.html?demo=richmarkdown&md=$enc" >/dev/null 2>&1
  agent-browser wait --load load >/dev/null 2>&1
  agent-browser click "$SEL" >/dev/null 2>&1
}
# 把光标放到代码块里**第 n 个可见字符**处（零宽锚点不计）—— 只动选区、不碰 DOM，
# 所以挂载路径留下的尾锚原样保留（这正是 ⑤ 要验的东西）。
caret_visible() {
  agent-browser eval "(() => { const ed = document.querySelector('[aria-label=\"所见即所得输入框\"]'); ed.focus(); const code = ed.querySelector('pre code'); const w = document.createTreeWalker(code, NodeFilter.SHOW_TEXT); let n = w.nextNode(); let seen = 0; const want = $1; while (n) { const cells = Array.from(n.nodeValue || ''); let vis = 0; for (let i = 0; i < cells.length; i += 1) { const ch = cells[i]; if (ch === '\u200B') { continue; } if (seen + vis === want) { const r = document.createRange(); r.setStart(n, i); r.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return 'ok'; } vis += 1; } if (seen + vis === want) { const r = document.createRange(); r.setStart(n, cells.length); r.collapse(true); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); return 'ok'; } seen += vis; n = w.nextNode(); } return 'miss'; })()" >/dev/null 2>&1
}
# 把光标放到代码块**内容的最后**（元素级：`selectNodeContents` + `collapse(false)`）——
# 「用户点到最后一行末尾接着写」就是这个位置，也最容易踩「以 `\n` 收尾」那个坑。
caret_end() {
  agent-browser eval "(() => { const ed = document.querySelector('[aria-label=\"所见即所得输入框\"]'); ed.focus(); const code = ed.querySelector('pre code'); const s = window.getSelection(); const r = document.createRange(); r.selectNodeContents(code); r.collapse(false); s.removeAllRanges(); s.addRange(r); return 'ok'; })()" >/dev/null 2>&1
}
expect() { # label field want
  local got
  got=$(field "$2" < /tmp/v67-last.json)
  if [ "$got" = "$3" ]; then ok "$1"; else no "$1" "$3" "$got"; fi
}
grab() { agent-browser eval "$REPORT_JS" > /tmp/v67-last.json; }

echo "== ① 挂载态（内容以 \\n 收尾）回车必须换行、且字落在下一行 =="
reload
agent-browser eval "$MOUNT_JS" >/dev/null 2>&1
grab;           expect "挂载后光标在代码块里" inPre True
agent-browser press Enter >/dev/null 2>&1
grab;           expect "第一下回车插入换行而非收尾" inPre True
# V68 起 DOM 里会**保留**零宽锚点（`<Z>` 是脚本里对 ZWSP 的可见化写法）：
# 每一行的行首那颗 ZWSP 既是空行的支撑、也是「接着敲的字落这一行」的锚。它们不进 Markdown。
expect "换行之后块内文本多了一行" codeText '测试\n<Z>\n<Z>'
type_text '第二行'
grab;           expect "新敲的字落在换行之后" codeText '测试\n<Z>\n<Z>第二行'
expect "光标仍在代码块内（没被踢出去）" inPre True

echo "== ② 三行代码块（\`\`\` ⏎ shell ⏎ AB ⏎ CD ⏎ EF） =="
reload
type_text '```';   agent-browser press Enter >/dev/null 2>&1
type_text 'shell'; agent-browser press Enter >/dev/null 2>&1
type_text 'AB';    agent-browser press Enter >/dev/null 2>&1
type_text 'CD';    agent-browser press Enter >/dev/null 2>&1
type_text 'EF'
# 每行行首那颗 `<Z>` 是**该行自己的锚点**（回车时插进去的，V68 起能在高亮重建中存活）；
# 关键断言是下一行的 `source`：零宽锚点不进 Markdown，源文本仍是干净的三行。
grab;           expect "三行各占一行" codeText '<Z>AB\n<Z>CD\n<Z>EF'
expect "语言名认成围栏语言（source 里带 shell）" source '```shell\nAB\nCD\nEF\n```'
expect "写第三行时光标仍在块内" inPre True

echo "== ③ 单次回车只换行、连按两下才收尾、收尾不吞内容 =="
agent-browser press Enter >/dev/null 2>&1
grab;           expect "第一下回车不收尾" inPre True
agent-browser press Enter >/dev/null 2>&1
grab;           expect "第二下回车收尾跳出" inPre False
expect "收尾不吞内容" codeText 'AB\nCD\nEF'

echo "== ④ 普通段落回车不受影响 =="
reload
type_text 'abc'; agent-browser press Enter >/dev/null 2>&1; type_text 'def'
grab;           expect "段落回车正常分行" source 'abc\ndef'

echo "== ⑤ V68：等一次高亮重建（>400ms 去抖）之后再敲，换行不许自己消失 =="
# 用户 09-22 的现场：「markdown code 里面我有时候回车换行自己又删除换行到上一行后面了」。
# `applyHighlight` 每 400ms 重建一次 `code > innerHTML`，而重建喂的是 `stripZwsp(文本)` ——
# 于是「靠 ZWSP 撑着的那个空行」被抹掉、后面的字并回上一行。V68 改成重建后把锚点按位塞回去。
#
# 这里**必须**用 `?md=` 灌初值走真实挂载路径：真机内容是从库里读回来经 `renderMarkdown`
# 挂上去的，直接抄 innerHTML 会绕过挂载 effect（= 绕过本次修复）。
reload_md '```shell
AB
```'
sleep 1                      # 挂载路径跑完：renderMarkdown + 补尾锚 + 上色
caret_visible 2              # 光标落在 `AB` 后面（第 2 个可见字符之后）
agent-browser press Enter >/dev/null 2>&1
sleep 1                      # ★ 跨过 400ms 去抖，逼高亮重建一次 —— 用户那句话就发生在这之后
type_text 'CD'
grab;           expect "重建后换行仍在、字落在新行" source '```shell\nAB\nCD\n```'
expect "仍然待在代码块里" inPre True
type_text 'EF'
grab;           expect "同一行内继续输入不受影响（不粘到上一行）" source '```shell\nAB\nCDEF\n```'

agent-browser close >/dev/null 2>&1
if [ -n "$VITE_PID" ]; then kill "$VITE_PID" >/dev/null 2>&1; fi

echo
echo "== 结果：PASS $PASS / FAIL $FAIL =="
[ "$FAIL" = "0" ]
