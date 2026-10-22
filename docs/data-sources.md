# 星罗（OSIRIS）数据来源说明

> 本文档梳理系统中每个菜单功能的数据接口、返回条数、缓存策略及数据量波动原因。

---

## 一、航空追踪

### 1. 商用航班 / 私人飞机 / 公务机 / 军用航空

- **接口**：`GET /api/flights`
- **数据来源**：
  - 主源：`adsb.fi`（免费 ADS-B 社区聚合）
  - 副源：OpenSky Network（需账号凭证，有 cooldown 限流）
  - 军用专用：`adsb.fi/mil`（军用航空 feed）
- **返回条数**：动态，通常 **500–5,000 架**（取决于全球实时在空中的飞机数量，夜间少、白天多）
- **缓存**：内存缓存 **90 秒**
- **降级策略**：OpenSky 被 cooldown → 改用 adsb.fi 按区域逐个请求；全部失败 → 返回旧缓存（标记 `+stale`）
- **数量波动原因**：ADS-B 接收站覆盖范围、时区（夜间航班少）、天气（极端天气导致停飞）

### 2. HYD飞机（黄岩岛）

- **接口**：`GET /api/hyd-aircraft`
- **数据来源**：本地 MySQL `demo.aircraft_track_latest` 表
- **返回条数**：固定 **75 架**（数据库当前唯一记录数，每架飞机只保留最新一条）
- **缓存**：无（`force-dynamic`，每次请求实时查询）
- **降级策略**：数据库连接失败 → 返回空数组 + `DATABASE_ERROR` 标记

---

## 二、卫星监控

### 3. 全部卫星 / 星链·通信 / 军用·侦察 / GPS·导航 / 对地观测 / 空间站·望远镜

- **接口**：`GET /api/satellites`
- **数据来源**：
  - 主源：CelesTrak TLE API（30+ 个分组 URL，如 `active`、`starlink`、`starlink supplemental`、`navigation`、`noaa` 等）
  - 副源：SatNOGS API（CelesTrak 全部被限流时降级）
  - 最终兜底：ISS 单颗 TLE（所有源都失败时）
- **返回条数**：**大幅波动，1 颗到 19,000+ 颗**
- **缓存**：磁盘缓存 24 小时（`.next/cache/satellites-tle-cache.json`）
- **降级策略**：CelesTrak 403 → 过期磁盘缓存 → SatNOGS → ISS emergency fallback

#### ⚠️ 卫星数量波动大的核心原因

| 原因 | 说明 |
|---|---|
| **CelesTrak 限流 (403)** | 免费用户有请求频率限制，30+ 个分组 URL 并发请求会触发 403 Forbidden，部分分组返回空 |
| **分组可达性** | `active` 分组（最大，~10,000+颗）最容易被限流；`starlink supplemental` 有独立限流桶，通常能拿到 4,000+ 颗 |
| **分批串行策略** | 当前每批 3 个分组、间隔 500ms，减少 403 但仍可能有分组被拒 |
| **缓存过期重建** | `.next` 目录被清理后磁盘缓存丢失，需要重新从 CelesTrak 拉取，此时如果被限流就只剩少量卫星 |
| **降级链路差异** | CelesTrak 全失败 → 过期缓存（19,000颗但数据旧）→ SatNOGS（1,300颗但名称匹配率低）→ ISS（1颗） |
| **轨道分类逻辑** | 前端按轨道高度和关键词分类，CelesTrak 分组缺失时大量卫星落入 `other`，导致分类计数差异大 |

**典型场景**：

| 场景 | 返回数量 |
|---|---|
| 理想情况（全部分组成功） | 18,000–19,000 颗 |
| CelesTrak 部分限流 | 5,000–8,000 颗 |
| CelesTrak 全部 403 + 过期磁盘缓存 | 19,000 颗（数据旧但数量不降） |
| CelesTrak 全部 403 + `.next` 被清理 | 1,300 颗（SatNOGS 降级） |
| 所有源全失败 | 1 颗（ISS 兜底） |

---

## 三、海事监控

### 4. 海事 / 海军 / 卫星船舶

- **接口**：`GET /api/maritime`
- **数据来源**：
  - 实时源：`aisstream.io` WebSocket（需 API Key，订阅 `wss://stream.aisstream.io/v0/stream`）
  - 静态数据：58 个全球港口 + 10 个咽喉水道（硬编码）
- **返回条数**：动态，**0–20,000 艘船舶**（取决于 WebSocket 连接状态和 bbox 过滤范围）
- **缓存**：快照缓存 **5 秒**（避免每次请求重新计算 58 个港口距离）
- **降级策略**：WebSocket 断开 → 返回最近快照（船舶数据过期但仍显示）；静态港口/咽喉数据始终可用
- **数量波动原因**：AIS 接收站覆盖范围、WebSocket 连接稳定性、bbox 区域大小

---

## 四、自然灾害

### 5. 地震活动

- **接口**：`GET /api/earthquakes`
- **数据来源**：USGS 实时地震 feed（`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson`）
- **返回条数**：动态，通常 **100–300 条**（过去 24 小时 M2.5+ 地震）
- **缓存**：`s-maxage=60, stale-while-revalidate=120`（1 分钟）
- **降级策略**：USGS 不可用 → 返回空数组 + 错误信息
- **数量波动原因**：地震是自然现象，活跃期（如环太平洋地震带活动加强）数量会明显增加

### 6. 火灾 / 火山

- **接口**：`GET /api/fires`
- **数据来源**：
  - 主源：NASA FIRMS（Suomi VIIRS + MODIS 24h CSV）
  - 副源：NASA EONET（活跃火山，`limit=50`）
- **返回条数**：动态，**几百到几千条**（24h 全球活跃火灾点）
- **缓存**：`s-maxage=600, stale-while-revalidate=1200`（10 分钟）
- **降级策略**：FIRMS 失败 → EONET 火山数据仍可用；全部失败 → 空数组
- **数量波动原因**：季节性（夏季野火高发）、地区（澳洲/加州火灾季）、卫星过境时间

### 7. 极端天气

- **接口**：`GET /api/weather`
- **数据来源**：OpenWeatherMap / 国家气象局 API（具体取决于配置）
- **返回条数**：动态（当前活跃的极端天气事件数）
- **缓存**：`s-maxage=300`（5 分钟）

---

## 五、网络安全

### 8. Cloudflare 雷达

- **接口**：`GET /api/cloudflare-radar`
- **数据来源**：Cloudflare Radar API（`https://api.cloudflare.com/client/v4/radar`），需 `CLOUDFLARE_API_TOKEN`
- **返回条数**：`total_outages`（全球网络中断）+ `total_attack_origins`（DDoS 攻击源）
- **缓存**：`s-maxage=300, stale-while-revalidate=600`（5 分钟）
- **降级策略**：`Promise.allSettled` 并行请求，部分失败标记 `partial: true`；未配置 token → 返回未配置状态
- **数量波动原因**：大型网络中断事件、DDoS 攻击活动周期

---

## 六、全球事件

### 9. GDELT 全球事件

- **接口**：`GET /api/gdelt`
- **数据来源**：GDELT Project / GDACS RSS（`https://www.gdacs.org/xml/rss.xml`）
- **返回条数**：动态，通常 **几十条**（当前活跃的全球灾害事件）
- **缓存**：`s-maxage=300, stale-while-revalidate=600`（5 分钟）
- **降级策略**：GDACS 不可用 → 空数组 + `GDACS unavailable`
- **数量波动原因**：全球灾害事件发生率（台风季、洪水季数量增多）

### 10. 新闻直播流

- **接口**：`GET /api/live-news`
- **数据来源**：硬编码的 YouTube / Rumble 直播流（覆盖北美、欧洲、中东、亚太、国家媒体）
- **返回条数**：**固定**（约 20–30 个 feed，取决于哪些频道正在直播）
- **缓存**：`s-maxage=86400`（24 小时，因为直播流列表变化不频繁）
- **降级策略**：无（硬编码列表，不会失败）

---

## 七、专项业务

### 11. 静默专项分析

- **接口**：`POST /api/zssf/run`
- **数据来源**：本地 MySQL `demo.ais_origin_record` 表（AIS 原始记录）
- **返回条数**：动态（算法检测到的静默事件数，取决于数据和算法参数）
- **缓存**：无（手动触发，每次执行重新扫描）
- **扫描范围**：全量 AIS 数据，`LIMIT 100000` 条
- **降级策略**：数据库连接失败 → 返回错误信息

---

## 八、数据量波动总结

| 数据类型 | 典型范围 | 波动主因 |
|---|---|---|
| 卫星 | 1 – 19,000+ | CelesTrak 限流(403)、缓存命中/失效、降级链路 |
| 航班 | 500 – 5,000 | 时区（白天/夜间）、ADS-B 接收站覆盖 |
| 海事船舶 | 0 – 20,000 | WebSocket 连接稳定性、bbox 区域 |
| 地震 | 100 – 300 | 地震活动周期 |
| 火灾 | 几百 – 几千 | 季节、卫星过境时间 |
| Cloudflare | 几十 – 几百 | 网络中断事件、攻击活动 |
| GDELT | 几十 | 全球灾害发生率 |
| HYD飞机 | 75（固定） | 数据库记录数 |
| 新闻直播 | 20–30（固定） | 正在直播的频道数 |
