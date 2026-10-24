/**
 * SQL 示例库（工具 + 学习两用）。
 *
 * # 定位
 *
 * 用户原话：「我们系统既是便携工具也是学习指导，例如 sql 里面就可以将 sql 的语法藏在示例中，
 * 方便使用的过程中也学习」。
 *
 * 所以这里的每一条示例都不是「随机一段 SQL」，而是**带讲解的教学样例**：
 *   - `sql`      —— 可直接跑 / 可照着改的真语句；
 *   - `takeaway` —— 一句话说清这条语句解决什么问题；
 *   - `points`   —— 这条语句里出现的语法点，逐条讲「是什么 + 注意什么」。
 *
 * # 口径
 *
 * SQL 按 **MySQL 8.0** 写（项目日常接触的就是 MySQL / 类 MySQL 环境）。
 * 少数语法在其他库里名字不同（例如 `LIMIT` / 窗口函数在 PostgreSQL 同样可用，
 * 但 `ON DUPLICATE KEY UPDATE` 是 MySQL 专有），示例里会点出来。
 */

export interface SqlSample {
  /** 稳定 id（列表 key 用） */
  id: string;
  /** 示例名，同时也是「点下去会填什么」的说明 */
  title: string;
  /** 难度 / 用途 */
  level: '基础' | '进阶' | '运维' | '数据变更' | '结构';
  /** 示例 SQL 本体 */
  sql: string;
  /** 一句话：这条语句解决什么问题 */
  takeaway: string;
  /** 语法点讲解（逐条说人话） */
  points: readonly string[];
}

export interface SqlSampleGroup {
  id: string;
  /** 分组名 */
  name: string;
  /** 分组说明（一句话） */
  blurb: string;
  samples: readonly SqlSample[];
}

export const SQL_SAMPLE_GROUPS: readonly SqlSampleGroup[] = [
  {
    id: 'basic',
    name: '基础查询',
    blurb: 'SELECT / WHERE / ORDER BY / LIMIT —— 日常九成查询的骨架',
    samples: [
      {
        id: 'basic-select',
        title: '单表条件查询',
        level: '基础',
        takeaway: '最小可用的查询：选字段、筛条件、排序、限量。',
        points: [
          '`SELECT 字段列表 FROM 表`：字段用逗号分隔，`*` 表示全部列（排查方便，写进代码建议显式列名）。',
          '`WHERE 条件`：在分组之前逐行过滤；多个条件用 `AND` / `OR` 连接。',
          '`ORDER BY 列 DESC`：`DESC` 倒序、`ASC` 正序（默认正序）。',
          '`LIMIT n`：只取前 n 条，避免手一抖拉回全表。',
        ],
        sql: `select id, name, email, created_at
from users
where status = 1
  and age >= 18
order by created_at desc
limit 20`,
      },
      {
        id: 'basic-where-ops',
        title: '各类 WHERE 谓词',
        level: '基础',
        takeaway: '把常用的筛选谓词放一条里对照着记。',
        points: [
          '`BETWEEN a AND b`：闭区间，等价于 `>= a AND <= b`。',
          '`IN (…, …)`：集合成员判断，比一长串 `OR` 清楚。',
          '`LIKE \'张%\'`：前缀匹配能用上索引；`LIKE \'%张\'` 前缀模糊会让索引失效。',
          '`IS NULL` / `IS NOT NULL`：判空只能用 `IS`，不能用 `= NULL`。',
        ],
        sql: `select id, name, phone
from users
where created_at between '2026-01-01' and '2026-06-30'
  and city in ('成都', '重庆', '西安')
  and name like '张%'
  and deleted_at is null`,
      },
      {
        id: 'basic-distinct',
        title: '去重取唯一值',
        level: '基础',
        takeaway: '想知道「有哪些城市」而不是「每个城市的记录」。',
        points: [
          '`SELECT DISTINCT 列`：对结果集去重，多列时按「组合」去重。',
          '去重有排序开销；数据量大且只是想「每个值取一条」时，窗口函数通常更快更可控。',
        ],
        sql: `select distinct city
from users
where status = 1
order by city`,
      },
    ],
  },
  {
    id: 'join',
    name: '多表连接',
    blurb: 'JOIN / ON / LEFT JOIN —— 关系型数据库的看家本领',
    samples: [
      {
        id: 'join-inner',
        title: '内连接：两表都有的才留下',
        level: '进阶',
        takeaway: '把用户和他们的订单拼在一起，只保留有订单的用户。',
        points: [
          '`A JOIN B ON 条件` = `INNER JOIN`：只保留两边都匹配上的行。',
          '`ON` 后面写「两表怎么对应」，最常见是主外键相等。',
          '给表起短别名（`u` / `o`）后，字段要写成 `别名.字段`，避免同名字段歧义。',
        ],
        sql: `select u.id, u.name, o.order_no, o.amount
from users u
join orders o on o.user_id = u.id
where o.created_at >= '2026-01-01'
order by o.amount desc`,
      },
      {
        id: 'join-left',
        title: '左连接：找「没有关联数据」的行',
        level: '进阶',
        takeaway: 'LEFT JOIN + IS NULL 是「找出从没下过单的用户」的标准写法。',
        points: [
          '`LEFT JOIN`：保留左表全部行，右表没匹配上的补 NULL。',
          '`WHERE o.id IS NULL`：右表是 NULL ⇒ 这条左表记录没有对应的右表数据。',
          '注意区别：写在 `ON` 里是「连接条件」，写在 `WHERE` 里是「连接后过滤」—— `LEFT JOIN` 后把右表条件写进 WHERE 会退化成内连接。',
        ],
        sql: `select u.id, u.name
from users u
left join orders o on o.user_id = u.id
where o.id is null
order by u.id`,
      },
      {
        id: 'join-using',
        title: 'USING：同名字段的简写',
        level: '进阶',
        takeaway: '两表关联字段同名时，`USING` 比 `ON` 更短。',
        points: [
          '`JOIN B USING (user_id)` 等价于 `ON a.user_id = b.user_id`。',
          '用 `USING` 后结果集里该列只出现一次，`SELECT *` 时不会出现两列同名字段。',
        ],
        sql: `select u.name, o.order_no
from users u
join orders using (user_id)
where o.amount > 100`,
      },
    ],
  },
  {
    id: 'aggregate',
    name: '聚合与分组',
    blurb: 'GROUP BY / HAVING / 聚合函数 —— 出报表的核心',
    samples: [
      {
        id: 'agg-group',
        title: '分组统计 + 过滤分组',
        level: '进阶',
        takeaway: '每个用户的下单笔数与总额，并只看下单超过 3 笔的。',
        points: [
          '聚合函数把多行压成一个值：`COUNT` 计数、`SUM` 求和、`AVG` 平均、`MAX/MIN` 极值。',
          '`GROUP BY 列`：按列分组，不在聚合函数里的字段都要出现在 GROUP BY 中。',
          '`WHERE` 在分组**之前**过滤行；`HAVING` 在分组**之后**过滤组 —— 这是最容易搞混的一点。',
        ],
        sql: `select u.id,
       u.name,
       count(o.id) as order_count,
       sum(o.amount) as total_amount
from users u
left join orders o on o.user_id = u.id
where o.status <> 'canceled'
group by u.id, u.name
having count(o.id) > 3
order by total_amount desc`,
      },
      {
        id: 'agg-count-distinct',
        title: 'COUNT 的三种写法',
        level: '进阶',
        takeaway: 'count(*) / count(列) / count(distinct 列) 结果是不一样的，别混用。',
        points: [
          '`COUNT(*)`：数行数，含 NULL。',
          '`COUNT(列)`：只数该列**不为 NULL** 的行数。',
          '`COUNT(DISTINCT 列)`：数去重后的非空值个数。',
          '`SUM(x) / COUNT(*)` 与 `AVG(x)` 不等价 —— 后者会忽略 NULL 行。',
        ],
        sql: `select count(*) as all_rows,
       count(city) as city_not_null,
       count(distinct city) as city_kinds
from users
where status = 1`,
      },
      {
        id: 'agg-case',
        title: 'CASE WHEN 分组打标',
        level: '进阶',
        takeaway: '把连续值切成几档（低/中/高消费），SQL 里的 if/else。',
        points: [
          '`CASE WHEN 条件 THEN 值 … ELSE 兜底 END`：按顺序判断，命中即返回。',
          '必须写 `ELSE`，否则不匹配的行返回 NULL。',
          '`CASE` 还可以用在 `ORDER BY` 里做自定义排序（把指定状态排最前）。',
        ],
        sql: `select case
         when amount >= 1000 then '高'
         when amount >= 200 then '中'
         else '低'
       end as amount_level,
       count(*) as order_count
from orders
where status = 'paid'
group by amount_level
order by order_count desc`,
      },
    ],
  },
  {
    id: 'subquery',
    name: '子查询与 CTE',
    blurb: 'IN / EXISTS / FROM 子查询 / WITH —— 把复杂查询拆成几步',
    samples: [
      {
        id: 'sub-in',
        title: 'IN 子查询：按另一张表的结果筛选',
        level: '进阶',
        takeaway: '查「买过某个商品的所有用户」。',
        points: [
          '`IN (SELECT …)`：先算出内层结果集，再判断外层某列是否属于它。',
          '内层结果列必须只有一列，否则报错。',
          '数据量大时 `EXISTS` 往往比 `IN` 更友好（`IN` 可能把整份结果拉进内存）。',
        ],
        sql: `select id, name
from users
where id in (
  select distinct user_id
  from orders
  where product_id = 1001
)`,
      },
      {
        id: 'sub-exists',
        title: 'EXISTS：只关心「有没有」',
        level: '进阶',
        takeaway: 'EXISTS 遇到第一条匹配就返回真，比 IN 省事。',
        points: [
          '`EXISTS (SELECT 1 … WHERE 关联条件)`：内层返回空集 = 假，非空 = 真。',
          '内层 `SELECT` 写什么字段无所谓，惯用 `SELECT 1`。',
          '关联条件写在子查询里（相关子查询），执行计划通常是半连接，效率高。',
          '`NOT EXISTS` 找「不存在对应记录」的行，比 `NOT IN` 安全 —— `NOT IN` 遇到 NULL 会整个失效。',
        ],
        sql: `select u.id, u.name
from users u
where not exists (
  select 1
  from orders o
  where o.user_id = u.id
    and o.created_at >= '2026-01-01'
)`,
      },
      {
        id: 'sub-cte',
        title: 'WITH（CTE）：把查询拆成几步',
        level: '进阶',
        takeaway: '复杂统计不要写成一坨嵌套括号，用 WITH 命名每一步。',
        points: [
          '`WITH 名字 AS (SELECT …), 名字2 AS (SELECT …) SELECT …`：先定义再引用。',
          '可读性远好于嵌套子查询，且同一个 CTE 可以被引用多次。',
          'CTE 只是写法上的「具名子查询」，MySQL 8.0 之前不支持；PostgreSQL / SQL Server 都支持。',
        ],
        sql: `with user_amount as (
  select user_id, sum(amount) as total
  from orders
  where status = 'paid'
  group by user_id
)
select u.name, ua.total
from user_amount ua
join users u on u.id = ua.user_id
where ua.total > 1000
order by ua.total desc`,
      },
    ],
  },
  {
    id: 'window',
    name: '窗口函数',
    blurb: 'OVER() / ROW_NUMBER —— 不合并行也能做「组内计算」',
    samples: [
      {
        id: 'win-rank',
        title: '组内排名',
        level: '进阶',
        takeaway: '每个用户按金额给自己的订单排名，行数不变（这是它和 GROUP BY 的本质区别）。',
        points: [
          '窗口函数 = 函数 + `OVER (...)`；`PARTITION BY` 相当于「分组」，但不合并行。',
          '`ROW_NUMBER()` 强制不重复（1,2,3），`RANK()` 并列后跳号（1,2,2,4），`DENSE_RANK()` 并列不跳号（1,2,2,3）。',
          '不带 `PARTITION BY` 就是全表一个窗口。',
        ],
        sql: `select user_id,
       order_no,
       amount,
       row_number() over (partition by user_id order by amount desc) as rn,
       rank() over (partition by user_id order by amount desc) as rnk
from orders
where status = 'paid'`,
      },
      {
        id: 'win-topn',
        title: '分组取 Top-N（套一层再筛）',
        level: '进阶',
        takeaway: '「每个用户金额最高的 2 笔订单」—— 经典面试题，也是日常真需求。',
        points: [
          '窗口函数不能直接写在 `WHERE` 里（WHERE 比窗口计算更早执行），必须先算出行号再外套一层查询。',
          '外层筛选 `rn <= 2` 就是 Top-2。',
          '换成 `rn = 1` 即可实现「取每组最新一条」，是替代 `GROUP BY + MAX` 的通用写法。',
        ],
        sql: `select user_id, order_no, amount
from (
  select user_id, order_no, amount,
         row_number() over (partition by user_id order by amount desc) as rn
  from orders
  where status = 'paid'
) ranked
where rn <= 2
order by user_id, amount desc`,
      },
      {
        id: 'win-cumulative',
        title: '累计值与移动窗口',
        level: '进阶',
        takeaway: '按天累计销售额、算 7 天移动平均。',
        points: [
          '`ORDER BY` + 默认窗口框架 = 从第一行累计到当前行，天然就是「累计值」。',
          '`ROWS BETWEEN 6 PRECEDING AND CURRENT ROW`：只算「当前行 + 前 6 行」，即 7 行移动窗口。',
          '`SUM(...) OVER ()`（括号空着）表示不做累计，直接是整个分区的总和。',
        ],
        sql: `select stat_date,
       amount,
       sum(amount) over (order by stat_date) as running_total,
       avg(amount) over (order by stat_date rows between 6 preceding and current row) as ma7
from daily_sales`,
      },
    ],
  },
  {
    id: 'dml',
    name: '数据变更',
    blurb: 'INSERT / UPDATE / DELETE —— 带 WHERE 再按回车',
    samples: [
      {
        id: 'dml-insert',
        title: '批量插入',
        level: '数据变更',
        takeaway: '一次插多行比循环单行插快一个数量级。',
        points: [
          '`INSERT INTO 表 (列…) VALUES (值…), (值…)`：一组 `VALUES` 一行。',
          '显式列出列名：表结构变化时不会错位，`NOT NULL` 无默认值的列也不会静默失败。',
          '插入大量数据时把多行合并进一条语句（或事务包起来），能显著减少往返与刷盘次数。',
        ],
        sql: `insert into audit_log (id, action, actor, created_at)
values
  (1, 'login', 'zhuzhiqiang', now()),
  (2, 'export', 'zhuzhiqiang', now()),
  (3, 'logout', 'zhuzhiqiang', now())`,
      },
      {
        id: 'dml-update-safe',
        title: '安全的 UPDATE 套路',
        level: '数据变更',
        takeaway: '先 SELECT 确认影响范围，再把同样的 WHERE 搬进 UPDATE。',
        points: [
          '`UPDATE 表 SET 列 = 值 WHERE 条件`；**WHERE 漏写就是全表更新**，这是最经典的生产事故。',
          '标准动作：先把 `UPDATE … SET` 换成 `SELECT *` 跑一遍，确认行数与内容，再改回去执行。',
          '批量改动前 `BEGIN` 开事务，确认无误再 `COMMIT`，有问题 `ROLLBACK`。',
        ],
        sql: `-- 第一步：先看会影响哪些行
select id, name, status
from users
where last_login_at < '2025-01-01'
  and status = 1;

-- 第二步：确认后照搬 WHERE
update users
set status = 2, updated_at = now()
where last_login_at < '2025-01-01'
  and status = 1;`,
      },
      {
        id: 'dml-upsert',
        title: 'UPSERT：有则更新、无则插入',
        level: '数据变更',
        takeaway: '统计表 / 配置表常用：一次语句搞定「存在就改，不存在就加」。',
        points: [
          'MySQL：`INSERT … ON DUPLICATE KEY UPDATE`，靠唯一索引 / 主键判断冲突。',
          'PostgreSQL：`INSERT … ON CONFLICT (列) DO UPDATE SET`；SQL Server 用 `MERGE`。',
          '`VALUES(列)` 在 MySQL 里指「本次准备插入的那个值」，用来做自增式累加（如 `count = count + 1`）。',
        ],
        sql: `insert into daily_stat (stat_date, product_id, order_count, total_amount)
values ('2026-09-15', 1001, 1, 199.00)
on duplicate key update
  order_count = order_count + 1,
  total_amount = total_amount + values(total_amount)`,
      },
    ],
  },
  {
    id: 'ddl',
    name: '表结构',
    blurb: 'CREATE / ALTER / DROP —— 建表与改结构',
    samples: [
      {
        id: 'ddl-create',
        title: '建表（含主键、索引、默认值）',
        level: '结构',
        takeaway: '规范建表：主键、非空、默认值、注释、时间戳一次给全。',
        points: [
          '`id bigint unsigned not null auto_increment primary key`：自增主键，`unsigned` 扩大正数范围。',
          '`created_at datetime not null default current_timestamp`：插入时自动带时间。',
          '`on update current_timestamp`：每次更新自动刷新该列，省得应用层漏写。',
          '`key idx_xxx (列)` 建二级索引；`unique key` 建唯一约束。',
          '`ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`：InnoDB 支持事务，utf8mb4 才能存 emoji。',
        ],
        sql: `create table orders (
  id          bigint unsigned not null auto_increment,
  user_id     bigint unsigned not null comment '下单用户',
  order_no    varchar(64)  not null comment '订单号',
  amount      decimal(12,2) not null default 0.00 comment '金额',
  status      varchar(16)  not null default 'created' comment '状态',
  created_at  datetime not null default current_timestamp,
  updated_at  datetime not null default current_timestamp on update current_timestamp,
  primary key (id),
  unique key uk_order_no (order_no),
  key idx_user_created (user_id, created_at)
) engine=InnoDB default charset=utf8mb4 comment='订单表'`,
      },
      {
        id: 'ddl-alter',
        title: '加列 / 改索引 / 加索引',
        level: '结构',
        takeaway: '线上改表要注意：加列一般很快，改类型/加索引可能锁表。',
        points: [
          '`ALTER TABLE 表 ADD COLUMN 列 类型`：新增列。给了 `default` 才允许加到已有数据的表上。',
          '`ALTER TABLE 表 ADD INDEX 名 (列)`：加索引；大表建议用 `ALGORITHM=INPLACE, LOCK=NONE` 或 gh-ost / pt-osc 工具在线加。',
          '`MODIFY COLUMN` 改类型、`CHANGE COLUMN` 改名 + 改类型；`DROP COLUMN` 删列（数据不可恢复）。',
          'DDL 在多数数据库里是隐式提交的，不能靠 ROLLBACK 撤销，操作前先备份。',
        ],
        sql: `alter table orders
  add column channel varchar(32) not null default 'web' comment '下单渠道',
  add index idx_status_created (status, created_at);`,
      },
      {
        id: 'ddl-index',
        title: '建索引与最左前缀',
        level: '结构',
        takeaway: '联合索引 (a, b, c) 能用上 a、a+b、a+b+c，单查 b 用不上。',
        points: [
          '`CREATE INDEX 名 ON 表 (列1, 列2)`：联合索引的列顺序决定它能不能被用上。',
          '最左前缀原则：查询条件必须从索引第一列开始连续匹配才走索引。',
          '把区分度高（重复值少）的列放前面通常更划算。',
          '索引不是越多越好：每个索引都会拖慢写入、占磁盘。',
        ],
        sql: `create index idx_status_created on orders (status, created_at);
create unique index uk_order_no on orders (order_no);`,
      },
    ],
  },
  {
    id: 'optimize',
    name: '索引与性能',
    blurb: 'EXPLAIN / 索引失效 —— 慢查询排查第一步',
    samples: [
      {
        id: 'opt-explain',
        title: 'EXPLAIN 慢查询',
        level: '运维',
        takeaway: '不真正执行，先看优化器打算怎么取数。',
        points: [
          '`type`：访问类型，`ALL` = 全表扫描（差），`ref` / `range` 表示用上了索引。',
          '`key`：实际使用的索引；为 `NULL` 说明没走索引。',
          '`rows`：预估扫描行数，越小越好。',
          '`Extra`：`Using filesort`（额外排序）、`Using temporary`（临时表）都是需要关注的字样。',
          '`EXPLAIN ANALYZE`（MySQL 8.0.18+）会真的执行并给出实际耗时，比只看预估更准。',
        ],
        sql: `explain
select u.name, count(o.id) as cnt
from users u
join orders o on o.user_id = u.id
where o.created_at >= '2026-01-01'
group by u.name;`,
      },
      {
        id: 'opt-index-miss',
        title: '索引失效的四种常见写法',
        level: '运维',
        takeaway: '索引建了却没用上，多半是下面这几种把列「包」住了。',
        points: [
          '列上做函数运算：`where date(created_at) = \'2026-09-15\'` → 改成范围 `created_at >= \'2026-09-15\' and created_at < \'2026-09-16\'`。',
          '列上做隐式类型转换：`where phone = 13800000000`（phone 是 varchar）→ 加引号写成字符串。',
          '前导模糊：`like \'%abc\'` 用不上索引，`like \'abc%\'` 才能用。',
          '`or` 连接的条件里有一边没索引 → 整体退化全表扫描，可考虑改写成 `union all`。',
        ],
        sql: `-- 不走索引（列被函数包住）
select * from orders where date(created_at) = '2026-09-15';

-- 改成范围条件，索引可用
select * from orders
where created_at >= '2026-09-15 00:00:00'
  and created_at <  '2026-09-16 00:00:00';`,
      },
      {
        id: 'opt-deep-page',
        title: '深分页优化',
        level: '运维',
        takeaway: 'LIMIT 100000, 20 会先扫掉 10 万行再丢掉，越翻越慢。',
        points: [
          '`LIMIT offset, n` 的 offset 越大越慢 —— 数据库必须先生成并丢弃前 offset 行。',
          '优化一：用「上次最后一条的 id」做游标：`where id > 上次最大id order by id limit 20`（要求按 id 有序翻页）。',
          '优化二：先用覆盖索引取出主键，再回表取详情。',
          '业务上通常可以限制「最多翻前 N 页」，从根上避免。',
        ],
        sql: `-- 慢：扫描 100000 行后丢弃
select id, order_no, amount from orders order by id limit 100000, 20;

-- 快：游标翻页（记住上一页最大的 id）
select id, order_no, amount
from orders
where id > 100000
order by id
limit 20;`,
      },
    ],
  },
  {
    id: 'ops',
    name: '运维诊断',
    blurb: '连接 / 表大小 / 锁等待 —— 出事时先看这几条',
    samples: [
      {
        id: 'ops-processlist',
        title: '当前连接与长事务',
        level: '运维',
        takeaway: '卡住了先看谁在跑、跑了多久。',
        points: [
          '`SHOW PROCESSLIST` 或 `information_schema.processlist`：列出当前连接、执行的 SQL、已耗时（`TIME` 秒）。',
          '关注 `COMMAND = Sleep` 但 `TIME` 很大的连接：可能是应用没关连接池，也可能是长事务占着锁。',
          '`information_schema.innodb_trx`：查活跃事务，`trx_started` 很早的就是长事务。',
          '真要杀掉用 `KILL 连接id`；杀之前确认不是在跑备份 / 大导入。',
        ],
        sql: `select id, user, host, db, command,
       time, state, left(info, 80) as sql_head
from information_schema.processlist
where command <> 'Sleep' or time > 60
order by time desc;`,
      },
      {
        id: 'ops-tablesize',
        title: '库表大小排行',
        level: '运维',
        takeaway: '磁盘告警时先定位是哪张表在长。',
        points: [
          '`information_schema.tables` 里 `data_length` 是数据大小、`index_length` 是索引大小。',
          '按总大小倒序排，前几张往往就是「元凶」。',
          '注意 `data_length` 是统计值（InnoDB 可能是估算），精确值要用 `SHOW TABLE STATUS` 或统计文件大小。',
        ],
        sql: `select table_schema as db_name,
       table_name,
       table_rows,
       round((data_length + index_length) / 1024 / 1024, 2) as size_mb
from information_schema.tables
where table_schema not in ('mysql', 'information_schema', 'performance_schema', 'sys')
order by (data_length + index_length) desc
limit 20;`,
      },
      {
        id: 'ops-lock',
        title: '锁等待与阻塞源',
        level: '运维',
        takeaway: '「谁挡住了我」比「我被挡住了」更重要。',
        points: [
          '`data_locks` 看锁（MySQL 8.0；5.7 用 `innodb_locks`），`blocking_thread` 指出是被哪个连接挡住的。',
          '`data_lock_waits` 直接给出「等待者 ↔ 阻塞者」的对应关系，是排障最省事的一张表。',
          '找到阻塞连接后，看它在跑什么（`processlist`），确认是长事务还是没提交的显式事务。',
          '根治通常是让应用及时提交、缩短事务、按固定顺序访问同批表避免死锁。',
        ],
        sql: `select w.requesting_engine_transaction_id as waiter,
       w.blocking_engine_transaction_id  as blocker,
       rt.trx_started                    as blocker_started,
       left(pt.info, 100)                as blocker_sql
from performance_schema.data_lock_waits w
join information_schema.innodb_trx rt on rt.trx_id = w.blocking_engine_transaction_id
left join information_schema.processlist pt on pt.id = rt.trx_mysql_thread_id;`,
      },
      {
        id: 'ops-slow-log',
        title: '慢查询 TOP（performance_schema）',
        level: '运维',
        takeaway: '按「总耗时」排序找最值得优化的 SQL，而不是只看单次最慢的。',
        points: [
          '`events_statements_summary_by_digest` 按 SQL 指纹聚合：相同结构不同参数会归为同一条。',
          '排序字段常看 `sum_timer_wait`（总耗时 = 影响面）与 `avg_timer_wait`（单次耗时）。',
          '先开 `performance_schema`；老版本或想用日志则在 my.cnf 开 `slow_query_log` + `long_query_time`，再用 `mysqldumpslow` / pt-query-digest 汇总。',
        ],
        sql: `select digest_text,
       count_star                                    as exec_count,
       round(sum_timer_wait / 1000000000, 2)         as total_ms,
       round(avg_timer_wait / 1000000000, 2)         as avg_ms,
       sum_rows_examined                             as rows_examined
from performance_schema.events_statements_summary_by_digest
order by sum_timer_wait desc
limit 15;`,
      },
    ],
  },
  {
    id: 'safety',
    name: '事务与安全',
    blurb: 'BEGIN / COMMIT / GRANT —— 别让一次手抖变成事故',
    samples: [
      {
        id: 'safe-tx',
        title: '事务包裹批量改动',
        level: '运维',
        takeaway: '多条相关改动要么全成、要么全撤。',
        points: [
          '`START TRANSACTION` / `BEGIN` 开启事务，`COMMIT` 提交，`ROLLBACK` 撤销。',
          '事务里改完先 `SELECT` 验证一下，确认再 `COMMIT`；发现问题立刻 `ROLLBACK`。',
          '事务要短：长事务会一直持有锁、撑大 undo，还可能拖垮复制延迟。',
          '`SAVEPOINT 名` / `ROLLBACK TO 名` 可以只回滚一部分。',
        ],
        sql: `start transaction;

update accounts set balance = balance - 100 where id = 1;
update accounts set balance = balance + 100 where id = 2;

-- 核对无误后提交；有问题就 rollback
select id, balance from accounts where id in (1, 2);

commit;`,
      },
      {
        id: 'safe-grant',
        title: '最小权限授权',
        level: '运维',
        takeaway: '给应用账号只开它需要的权限，别图省事 GRANT ALL。',
        points: [
          '`GRANT 权限 ON 库.表 TO \'用户\'@\'主机\'`：`\'主机\'` 限定来源，`%` 表示任意来源（尽量别用）。',
          '读多写少的应用账号：`SELECT, INSERT, UPDATE, DELETE` 就够，不要给 `DROP` / `ALTER`。',
          '只读账号只给 `SELECT` + `SHOW VIEW`。',
          '改完 `FLUSH PRIVILEGES` 生效（用 GRANT 语句本身已经刷新生效，手工改表才必须执行）。',
          '`REVOKE 权限 ON 库.表 FROM \'用户\'@\'主机\'` 收回权限；`SHOW GRANTS FOR \'用户\'@\'主机\'` 查看现有权限。',
        ],
        sql: `-- 只读账号
grant select, show view on app_db.* to 'readonly'@'10.0.0.%';

-- 应用账号：够用就好，不给 DDL
grant select, insert, update, delete on app_db.* to 'app'@'10.0.0.%';

-- 查看已授权限
show grants for 'app'@'10.0.0.%';`,
      },
    ],
  },
];

/** 全部示例展平（供「随机来一条」或全局搜索用） */
export const SQL_SAMPLES_FLAT: readonly SqlSample[] = SQL_SAMPLE_GROUPS.flatMap(
  (group) => group.samples,
);
