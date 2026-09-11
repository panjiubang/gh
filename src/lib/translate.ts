/**
 * 翻译中间件 — DeepL API Free
 *
 * 将外部 API 返回的英文动态内容翻译为中文。
 *
 * 设计要点：
 *   • 内存缓存 — 翻译结果按原文哈希缓存，避免重复请求。
 *   • 批量请求 — DeepL 单次最多 50 条文本，自动分批。
 *   • 降级     — 无 API Key 或请求失败时返回原文，不影响主流程。
 *   • 去重     — 同一批次内的重复文本只翻译一次。
 */

const DEEPL_ENDPOINT = 'https://api-free.deepl.com/v2/translate';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时：地名/事件名重复率高
const MAX_BATCH = 50; // DeepL 单次上限

interface CacheEntry {
  translated: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();

/** 获取 DeepL API Key（从环境变量） */
function getApiKey(): string | null {
  const key = process.env.DEEPL_API_KEY;
  if (!key || key === 'your_deepl_free_api_key') return null;
  return key;
}

/** 简单哈希（用于缓存键，避免过长的原文做 key） */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return `zh_${h >>> 0}`;
}

/**
 * 翻译单条文本。命中缓存时直接返回。
 * 无 API Key 时返回原文（降级模式）。
 */
export async function translateText(text: string): Promise<string> {
  if (!text || text.length < 2) return text;

  // 纯数字/符号/坐标不需要翻译
  if (/^[\d\s.,\-°/°'"()]+(km|m|kt|kn|kt|nSv\/h)?$/i.test(text)) return text;

  const key = hash(text);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.translated;

  // 去重并发请求
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = doTranslate(text, key);
  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

/**
 * 批量翻译。同批次内的重复文本只请求一次。
 * 返回的数组与输入一一对应。
 */
export async function translateBatch(texts: string[]): Promise<string[]> {
  if (texts.length === 0) return [];
  const apiKey = getApiKey();
  if (!apiKey) return texts; // 降级

  // 去重：收集 unique 文本
  const unique = [...new Set(texts.filter(t => t && t.length >= 2))];
  const translatedMap = new Map<string, string>();

  // 先从缓存取
  const toFetch: string[] = [];
  for (const t of unique) {
    const key = hash(t);
    const cached = cache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      translatedMap.set(t, cached.translated);
    } else {
      toFetch.push(t);
    }
  }

  // 分批调用 DeepL
  for (let i = 0; i < toFetch.length; i += MAX_BATCH) {
    const batch = toFetch.slice(i, i + MAX_BATCH);
    try {
      const results = await callDeepL(batch, apiKey);
      batch.forEach((orig, idx) => {
        const translated = results[idx] || orig;
        cache.set(hash(orig), { translated, expiresAt: Date.now() + CACHE_TTL_MS });
        translatedMap.set(orig, translated);
      });
    } catch (e) {
      console.warn(`[观寰] DeepL 批量翻译失败，降级返回原文:`, e instanceof Error ? e.message : e);
      // 降级：失败的部分返回原文
      batch.forEach(orig => translatedMap.set(orig, orig));
    }
  }

  // 按原始顺序返回
  return texts.map(t => {
    if (!t || t.length < 2) return t;
    return translatedMap.get(t) || t;
  });
}

/** 实际调用 DeepL API */
async function doTranslate(text: string, _key: string): Promise<string> {
  const apiKey = getApiKey();
  if (!apiKey) return text; // 降级

  try {
    const results = await callDeepL([text], apiKey);
    const translated = results[0] || text;
    cache.set(_key, { translated, expiresAt: Date.now() + CACHE_TTL_MS });
    return translated;
  } catch (e) {
    console.warn(`[观寰] DeepL 翻译失败，降级返回原文:`, e instanceof Error ? e.message : e);
    return text; // 降级
  }
}

/** DeepL API HTTP 调用 */
async function callDeepL(texts: string[], apiKey: string): Promise<string[]> {
  const params = new URLSearchParams();
  for (const t of texts) params.append('text', t);
  params.append('source_lang', 'EN');
  params.append('target_lang', 'ZH');

  const res = await fetch(DEEPL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });

  if (!res.ok) {
    throw new Error(`DeepL API ${res.status}: ${await res.text().catch(() => '')}`);
  }

  const data = await res.json() as { translations: { text: string }[] };
  return data.translations.map(t => t.text);
}

/**
 * 翻译对象的指定字段（就地修改）。
 * 用于 API 路由中对返回对象批量翻译。
 */
export async function translateFields<T extends Record<string, unknown>>(
  obj: T,
  fields: (keyof T)[],
): Promise<T> {
  const texts = fields.map(f => String(obj[f] ?? ''));
  const translated = await translateBatch(texts);
  fields.forEach((f, i) => {
    if (obj[f] != null) obj[f] = translated[i] as T[keyof T];
  });
  return obj;
}

/**
 * 翻译数组中每个对象的指定字段。
 */
export async function translateArrayFields<T>(
  arr: T[],
  fields: (keyof T)[],
): Promise<T[]> {
  if (arr.length === 0) return arr;
  // 收集所有需要翻译的文本
  const allTexts: string[] = [];
  for (const item of arr) {
    const obj = item as Record<string, unknown>;
    for (const f of fields) {
      allTexts.push(String(obj[f as string] ?? ''));
    }
  }
  const allTranslated = await translateBatch(allTexts);

  // 写回
  let idx = 0;
  for (const item of arr) {
    const obj = item as Record<string, unknown>;
    for (const f of fields) {
      const key = f as string;
      if (obj[key] != null) obj[key] = allTranslated[idx];
      idx++;
    }
  }
  return arr;
}

/** 清除翻译缓存（测试用） */
export function clearTranslateCache(): void {
  cache.clear();
  inflight.clear();
}
