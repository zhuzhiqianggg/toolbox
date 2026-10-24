/**
 * smartArrange（智能桌面整理 · 纯函数引擎）回归 —— V49。
 *
 * 背景：方案定位「每次整理都能让桌面展出最佳布局」。本套件把归组与盒内排序的
 * 决策钉死，防止将来移植 / 重构时「最佳布局」悄悄跑偏。它镜像 Rust `grid.rs` 的
 * `arrange_group_of` / `arrange_group_rank` 语义。
 *
 * 锚点：
 *  - `.lnk` / 系统入口 → 左侧竖条（loose），不进盒子；
 *  - 文件夹自成「文件夹」盒；
 *  - 只有一个条目的非文件夹盒并入「其他」（不把桌面切成碎片）；
 *  - 盒内排序 = 置顶(sort) → 修改时间新在前 → 名称。
 */
const { arrangePlan, groupKeyOf, sortGridItems, planStats } = await import(
  '../../src/lib/smartArrange.ts'
);

let pass = 0;
const fails = [];
function check(name, got, want) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) {
    pass += 1;
  } else {
    fails.push(`FAIL | ${name} | got=${a} want=${b}`);
  }
}

/** 便捷构造一个条目 */
function item(name, opts = {}) {
  const ext = opts.ext ?? '';
  return {
    name,
    isDir: opts.isDir ?? false,
    isLnk: opts.isLnk ?? false,
    ext,
    category: opts.category ?? (opts.isDir ? '' : undefined),
    mtime: opts.mtime ?? 1000,
    sort: opts.sort ?? undefined,
  };
}

// ---------- 1) 归组 ----------
check('dir → 文件夹', groupKeyOf(item('工作', { isDir: true })), '文件夹');
check('lnk → 竖条(loose)', groupKeyOf(item('微信.lnk', { isLnk: true })), '');
check('图片类别原样', groupKeyOf(item('a.png', { category: '图片' })), '图片');
check('文档类别原样', groupKeyOf(item('b.docx', { category: '文档' })), '文档');
check('音视频类别 → 媒体', groupKeyOf(item('c.mp3', { category: '视频' })), '媒体');
check('其它→其他', groupKeyOf(item('d.tt', { category: '其它' })), '其他');
check('category 缺失 + 媒体扩展 → 媒体', groupKeyOf(item('e.mp4', { ext: '.mp4' })), '媒体');
check('category 缺失 + 普通扩展 → 其他', groupKeyOf(item('f.xyz', { ext: '.xyz' })), '其他');

// ---------- 2) arrangePlan：整体归组 + 单条目合并 + 盒子顺序 ----------
{
  const plan = arrangePlan([
    item('微信.lnk', { isLnk: true }),
    item('此电脑', { isLnk: true }),
    item('工作', { isDir: true, mtime: 100 }),
    item('素材', { isDir: true, mtime: 200 }),
    item('照片1.png', { category: '图片', mtime: 300 }),
    item('报告.docx', { category: '文档', mtime: 400 }),
    item('软件.zip', { category: '压缩包', mtime: 500 }),
    item('孤单一.html', { category: 'HTML' }), // 单条目非文件夹 → 并入其他
  ]);
  const labels = plan.boxes.map((b) => b.label);
  check('盒子顺序(文件夹→图片→文档→压缩包→其他)', labels, ['文件夹', '图片', '文档', '压缩包', '其他']);
  check('单条目 HTML 并入其他', labels.includes('HTML'), false);
  check('lnk 进 loose', plan.loose.map((l) => l.name), ['微信.lnk', '此电脑']);
  const folder = plan.boxes.find((b) => b.label === '文件夹');
  check('文件夹内容', folder.items.map((i) => i.name), ['素材', '工作']); // mtime 200 在 100 前
}

// ---------- 3) 盒内排序 ----------
{
  const sorted = sortGridItems([
    item('c', { mtime: 1 }),
    item('a', { mtime: 3 }),
    item('b', { mtime: 2 }),
  ]);
  check('mtime 新在前', sorted.map((i) => i.name), ['a', 'b', 'c']);
  // 用户排列位（sort）优先于 recency：即便 a 的 mtime 更晚，按用户排的 pin→a→b 走
  const pinned = sortGridItems([
    item('b', { sort: 2, mtime: 900 }),
    item('a', { sort: 1, mtime: 100 }),
    item('pin', { sort: 0, mtime: 50 }),
  ]);
  check('用户排列位(sort)优先于 recency', pinned.map((i) => i.name), ['pin', 'a', 'b']);
  // 同 sort 同 mtime → 名称数字感知
  const named = sortGridItems([item('b10'), item('b2')]);
  check('名称数字感知', named.map((i) => i.name), ['b2', 'b10']);
}

// ---------- 4) planStats ----------
{
  const stats = planStats([
    item('微信.lnk', { isLnk: true }),
    item('工作', { isDir: true }),
    item('a.png', { category: '图片' }),
  ]);
  check('boxes=2(folder/图片) boxed=2 loose=1', stats, { boxes: 2, boxed: 2, loose: 1 });
}

// ---------- 结果 ----------
console.log(`smartArrange：${pass} 通过，${fails.length} 失败`);
for (const line of fails) console.log(line);
process.exit(fails.length === 0 ? 0 : 1);