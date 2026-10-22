#!/usr/bin/env node
/**
 * 黄岩岛 (Scarborough Shoal) 周边开源卫星遥感数据获取程序
 *
 * 数据源：
 *   - Element84 Earth Search v1 (Sentinel-2 L2A 光学影像 / Sentinel-1 GRD SAR 雷达影像)
 *   - Copernicus Data Space STAC (备用)
 *
 * 默认范围：黄岩岛周边 40 海里
 * 默认时间：2026-09-10 至 2026-09-12
 *
 * 用法：
 *   node tools/fetch-huangyan-satellite-imagery.mjs
 *   node tools/fetch-huangyan-satellite-imagery.mjs --start 2026-09-10 --end 2026-09-12 --radius-nm 40
 *   node tools/fetch-huangyan-satellite-imagery.mjs --collections sentinel-2-l2a,sentinel-1-grd --no-download
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

// ----------------------------- 配置 -----------------------------

// 黄岩岛中心坐标 (Scarborough Shoal)
const HUANGYAN_ISLAND = {
  lat: 15.184,
  lng: 117.751,
  name: '黄岩岛 (Scarborough Shoal)',
};

const DEFAULT_CONFIG = {
  startDate: '2026-09-10',
  endDate: '2026-09-12',
  radiusNm: 40, // 海里
  collections: ['sentinel-2-l2a', 'sentinel-1-grd'], // 默认拉取光学 + SAR
  maxScenesPerCollection: 30,
  downloadThumbnails: true,
  downloadPreviews: true,
  outputDir: 'runs/huangyan-satellite',
  // Element84 公开 STAC 端点，无需鉴权
  stacEndpoints: [
    'https://earth-search.aws.element84.com/v1/search',
    'https://catalogue.dataspace.copernicus.eu/stac/search',
  ],
};

// 1 海里 = 1.852 km；1° 纬度 ≈ 111 km
const NM_TO_KM = 1.852;
const DEG_LAT_PER_KM = 1 / 111;

// ----------------------------- CLI 解析 -----------------------------

function parseArgs(argv) {
  const cfg = { ...DEFAULT_CONFIG };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--start': cfg.startDate = next; i++; break;
      case '--end': cfg.endDate = next; i++; break;
      case '--radius-nm': cfg.radiusNm = parseFloat(next); i++; break;
      case '--collections': cfg.collections = next.split(',').map(s => s.trim()); i++; break;
      case '--max': cfg.maxScenesPerCollection = parseInt(next, 10); i++; break;
      case '--output-dir': cfg.outputDir = next; i++; break;
      case '--no-download': cfg.downloadThumbnails = false; cfg.downloadPreviews = false; break;
      case '--no-thumbnail': cfg.downloadThumbnails = false; break;
      case '--no-preview': cfg.downloadPreviews = false; break;
      case '--help':
      case '-h':
        console.log(`用法: node fetch-huangyan-satellite-imagery.mjs [options]

选项:
  --start YYYY-MM-DD        起始日期 (默认 ${DEFAULT_CONFIG.startDate})
  --end YYYY-MM-DD          结束日期 (默认 ${DEFAULT_CONFIG.endDate})
  --radius-nm N             半径 (海里, 默认 ${DEFAULT_CONFIG.radiusNm})
  --collections a,b         STAC 集合 (默认 ${DEFAULT_CONFIG.collections.join(',')})
  --max N                   每集合最大场景数 (默认 ${DEFAULT_CONFIG.maxScenesPerCollection})
  --output-dir PATH        输出目录 (默认 ${DEFAULT_CONFIG.outputDir})
  --no-download             仅查询不下载图片
  --no-thumbnail            不下载缩略图
  --no-preview              不下载预览图
  --help                    显示帮助
`);
        process.exit(0);
    }
  }
  return cfg;
}

// ----------------------------- 地理工具 -----------------------------

function bboxFromCircle(centerLat, centerLng, radiusNm) {
  // 转为半径 km，再转成 bbox 经纬度
  const radiusKm = radiusNm * NM_TO_KM;
  const degLat = radiusKm * DEG_LAT_PER_KM;
  const degLng = radiusKm * DEG_LAT_PER_KM / Math.cos(centerLat * Math.PI / 180);
  return [
    Number((centerLng - degLng).toFixed(6)),
    Number((centerLat - degLat).toFixed(6)),
    Number((centerLng + degLng).toFixed(6)),
    Number((centerLat + degLat).toFixed(6)),
  ];
}

// 估算 bbox 大致面积 (km²)，仅供展示
function estimateAreaKm2(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const latDiff = Math.abs(maxLat - minLat) * 111;
  const lngDiff = Math.abs(maxLng - minLng) * 111 * Math.cos((minLat + maxLat) / 2 * Math.PI / 180);
  return Math.round(latDiff * lngDiff);
}

// 海里 → 米的距离换算（用于显示）
function nmToM(nm) { return Math.round(nm * NM_TO_KM * 1000); }

// ----------------------------- STAC 搜索 -----------------------------

function buildDatetime(start, end) {
  // STAC 标准日期范围: <from>/<to>
  const from = new Date(`${start}T00:00:00Z`).toISOString().split('.')[0] + 'Z';
  const to = new Date(`${end}T23:59:59Z`).toISOString().split('.')[0] + 'Z';
  return `${from}/${to}`;
}

async function searchStac(endpoint, collection, bbox, datetime, limit) {
  const body = {
    collections: [collection],
    bbox,
    datetime,
    limit,
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/geo+json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`STAC ${endpoint} returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  return {
    features: data.features || [],
    numberMatched: data.numberMatched ?? data.numberReturned ?? 0,
    context: data.context || null,
  };
}

function formatScene(feature, collection) {
  const props = feature.properties || {};
  const assets = feature.assets || {};

  // 缩略图与预览图 URL（Sentinel-2 / Sentinel-1 都有）
  const thumbnail = assets.thumbnail?.href || assets.tci?.href || null;
  const preview = assets.preview?.href || assets.visual?.href || null;
  // 原始数据下载链接 (一般为大文件，本脚本默认不下载)
  const product = assets.data?.href || assets.product?.href || assets.geometry?.href || null;

  return {
    id: feature.id,
    collection,
    datetime: props.datetime,
    platform: props.platform || props.constellation || collection,
    orbit: props['sat:orbit_state'] || props.orbitDirection || null,
    relative_orbit: props['sat:relative_orbit'] ?? null,
    polarization: props['sar:polarizations'] || props.polarisation || null,
    instrument_mode: props['sar:instrument_mode'] || null,
    resolution: props['sar:resolution_range'] || props['gsd'] || null,
    cloud_cover: props['eo:cloud_cover'] ?? null,
    bbox: feature.bbox,
    area_km2: feature.bbox ? estimateAreaKm2(feature.bbox) : null,
    thumbnail,
    preview,
    product,
    self_href: feature.links?.find(l => l.rel === 'self')?.href || null,
  };
}

// ----------------------------- 下载工具 -----------------------------

function safeFilename(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function downloadToFile(url, destPath, retries = 1, timeoutMs = 25000) {
  if (!url) return null;
  if (existsSync(destPath)) return destPath;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      // Node 18+ 的 fetch body 是 ReadableStream；转 Node Readable
      const nodeStream = Readable.fromWeb(res.body);
      await pipeline(nodeStream, createWriteStream(destPath));
      return destPath;
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  return null;
}

// ----------------------------- 主流程 -----------------------------

async function main() {
  const cfg = parseArgs(process.argv);
  const bbox = bboxFromCircle(HUANGYAN_ISLAND.lat, HUANGYAN_ISLAND.lng, cfg.radiusNm);
  const datetime = buildDatetime(cfg.startDate, cfg.endDate);
  const outputAbs = resolve(process.cwd(), cfg.outputDir);
  const imageryDir = join(outputAbs, 'imagery');
  const metadataDir = join(outputAbs, 'metadata');

  await mkdir(imageryDir, { recursive: true });
  await mkdir(metadataDir, { recursive: true });

  console.log('========================================');
  console.log(' 黄岩岛周边卫星遥感数据获取程序');
  console.log('========================================');
  console.log(`区域中心 : ${HUANGYAN_ISLAND.name} (${HUANGYAN_ISLAND.lat}°N, ${HUANGYAN_ISLAND.lng}°E)`);
  console.log(`半径范围 : ${cfg.radiusNm} 海里 (≈ ${nmToM(cfg.radiusNm)} 米)`);
  console.log(`BBox     : [${bbox.join(', ')}]  (面积 ≈ ${estimateAreaKm2(bbox)} km²)`);
  console.log(`时间范围 : ${cfg.startDate} → ${cfg.endDate}`);
  console.log(`数据集合 : ${cfg.collections.join(', ')}`);
  console.log(`输出目录 : ${outputAbs}`);
  console.log(`下载图片 : ${cfg.downloadThumbnails || cfg.downloadPreviews ? '是' : '否'}`);
  console.log('----------------------------------------');

  const allScenes = [];
  const summary = [];

  for (const collection of cfg.collections) {
    console.log(`\n[查询] 集合 = ${collection}`);
    let lastError = null;
    let aggregated = [];
    let matched = 0;

    for (const endpoint of cfg.stacEndpoints) {
      try {
        console.log(`  → 请求 ${endpoint}`);
        const { features, numberMatched } = await searchStac(
          endpoint, collection, bbox, datetime, cfg.maxScenesPerCollection,
        );
        if (features.length > 0) {
          aggregated = features.map(f => formatScene(f, collection));
          matched = numberMatched;
          console.log(`    ✓ 命中 ${features.length} 个场景 (总匹配 ${numberMatched})`);
          break;
        } else {
          console.log(`    · 无命中场景`);
        }
      } catch (e) {
        lastError = e;
        console.warn(`    × 失败: ${e.message}`);
      }
    }

    if (aggregated.length === 0) {
      console.warn(`  ✗ 集合 ${collection} 未获取到任何场景${lastError ? ` (最后错误: ${lastError.message})` : ''}`);
      summary.push({ collection, count: 0, matched: 0 });
      continue;
    }

    // 先写一份初始元数据（即使后续下载失败也保留查询结果）
    const metaPath = join(metadataDir, `${collection}.json`);
    const writeMeta = () => writeFile(metaPath, JSON.stringify({
      collection,
      query: { bbox, datetime, center: HUANGYAN_ISLAND, radius_nm: cfg.radiusNm },
      matched,
      returned: aggregated.length,
      scenes: aggregated,
    }, null, 2));
    await writeMeta();
    console.log(`  ✓ 元数据写入 ${metaPath}`);

    // 下载缩略图 / 预览图（串行，避免大量并发导致卡死）
    if (cfg.downloadThumbnails || cfg.downloadPreviews) {
      console.log(`  → 开始下载图片 (${aggregated.length} 场景)...`);
      let downloaded = 0;
      for (const scene of aggregated) {
        const base = safeFilename(`${collection}_${scene.datetime || scene.id}`);
        if (cfg.downloadThumbnails && scene.thumbnail) {
          try {
            const p = await downloadToFile(scene.thumbnail, join(imageryDir, `${base}_thumb.jpg`));
            if (p) { scene.thumbnail_local = p.replace(outputAbs, '.').replace(/\\/g, '/'); downloaded++; }
          } catch (e) { console.warn(`    × 缩略图失败 ${scene.id}: ${e.message}`); }
        }
        if (cfg.downloadPreviews && scene.preview) {
          try {
            const p = await downloadToFile(scene.preview, join(imageryDir, `${base}_preview.jpg`));
            if (p) { scene.preview_local = p.replace(outputAbs, '.').replace(/\\/g, '/'); }
          } catch (e) { console.warn(`    × 预览图失败 ${scene.id}: ${e.message}`); }
        }
      }
      console.log(`  ✓ 已下载 ${downloaded} 张缩略图到 ${imageryDir}`);
      // 下载完成后回写元数据（含本地路径）
      await writeMeta();
    }

    allScenes.push(...aggregated);
    summary.push({ collection, count: aggregated.length, matched });
  }

  // 汇总文件
  const summaryPath = join(outputAbs, 'summary.json');
  await writeFile(summaryPath, JSON.stringify({
    target: HUANGYAN_ISLAND,
    radius_nm: cfg.radiusNm,
    radius_m: nmToM(cfg.radiusNm),
    bbox,
    area_km2: estimateAreaKm2(bbox),
    date_range: { start: cfg.startDate, end: cfg.endDate, datetime },
    collections: cfg.collections,
    summary,
    total_scenes: allScenes.length,
    generated_at: new Date().toISOString(),
    scenes: allScenes,
  }, null, 2));

  // 人类可读的清单
  const manifestLines = [
    `# 黄岩岛周边卫星遥感数据清单`,
    ``,
    `- 区域中心: ${HUANGYAN_ISLAND.name} (${HUANGYAN_ISLAND.lat}°N, ${HUANGYAN_ISLAND.lng}°E)`,
    `- 半径: ${cfg.radiusNm} 海里 (≈ ${nmToM(cfg.radiusNm)} 米)`,
    `- 时间: ${cfg.startDate} → ${cfg.endDate}`,
    `- 总场景数: ${allScenes.length}`,
    ``,
  ];
  for (const s of summary) {
    manifestLines.push(`## ${s.collection}  (${s.count} / matched ${s.matched})`);
  }
  manifestLines.push('');
  for (const scene of allScenes) {
    const cloud = scene.cloud_cover != null ? `云量 ${scene.cloud_cover.toFixed(1)}%` : 'SAR';
    const time = scene.datetime || 'unknown';
    manifestLines.push(`- [${scene.collection}] ${time}  ${cloud}  ID=${scene.id}`);
    if (scene.thumbnail_local) manifestLines.push(`  - 缩略图: ${scene.thumbnail_local}`);
    if (scene.preview_local) manifestLines.push(`  - 预览图: ${scene.preview_local}`);
  }
  await writeFile(join(outputAbs, 'manifest.md'), manifestLines.join('\n'));

  console.log('\n========================================');
  console.log(` 完成！共获取 ${allScenes.length} 个场景`);
  console.log(` 汇总文件 : ${summaryPath}`);
  console.log(` 清单文件 : ${join(outputAbs, 'manifest.md')}`);
  console.log(` 图片目录 : ${imageryDir}`);
  console.log('========================================');
}

main().catch(err => {
  console.error('\n[FATAL]', err);
  process.exit(1);
});
