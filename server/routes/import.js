/**
 * Modul: 通用数据导入（CSV / JSON / vCard）
 * Zweck: 让用户在迁移进来时不必重新手敲 —— 上传文件 → 预览 → 列映射 → 导入。
 *
 * 权限：全部 requireAdmin（照搬 server/routes/backup.js）。导入会向全家人可见的
 *       模块里写数据，属于管理员级操作。
 *
 * 失败策略（与 services/media-metadata.js 一脉相承）：一切异常收敛成结构化
 * 错误体，**绝不把堆栈抛给前端**；单行级错误放进 report.failures 明细。
 *
 * Abhängigkeiten: express, server/auth.js, services/import-*.js
 */

import express from 'express';

import { requireAdmin } from '../auth.js';
import { createLogger } from '../logger.js';
import { getImportModule, listImportModules, autoMapHeaders, buildRecords, buildTemplateCsv } from '../services/import-mapping.js';
import { parseCsvDetailed, parseJsonRecords, rowsToRecords } from '../services/import-csv.js';
import { vcardToContactTable } from '../services/vcard-import.js';
import { runImport, recentBatches, MAX_ROWS } from '../services/import-runner.js';

const router = express.Router();
const log = createLogger('Import');

/** 正文大小上限：8 MB。够几万行 CSV，又不至于让一次请求拖垮容器。 */
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

/** 预览返回的行数（需求：前 20 行）。 */
const PREVIEW_ROWS = 20;

// 既可以 JSON 传 {content}，也可以直接 POST 原始文本（curl / 脚本场景）。
// app 级 express.json 已处理前者，这里只为 text/* 补一条土路，不加任何依赖。
const rawText = express.text({
  type: ['text/*', 'application/csv', 'application/vnd.ms-excel'],
  limit: `${Math.ceil(MAX_CONTENT_BYTES / (1024 * 1024))}mb`,
});

/**
 * 统一取出请求参数：JSON 对象、原始字符串都支持。
 * @param {import('express').Request} req
 * @returns {Record<string, unknown>}
 */
function readBody(req) {
  const body = req.body;
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string') return { content: body };
  return {};
}

/**
 * 取出并按上限校验文件内容。超限返回 null（由调用方转成 413）。
 * @param {Record<string, unknown>} body
 * @returns {{content: string, tooLarge?: boolean}}
 */
function readContent(body) {
  const content = typeof body.content === 'string' ? body.content : '';
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return { content: '', tooLarge: true };
  }
  return { content };
}

/**
 * 统一格式解析：'csv' | 'json' | 'vcard'（其他一律回落 csv，与历史行为一致）。
 * @param {unknown} value
 * @returns {'csv'|'json'|'vcard'}
 */
function readFormat(value) {
  const format = String(value ?? 'csv').trim().toLowerCase();
  if (format === 'json') return 'json';
  if (format === 'vcard') return 'vcard';
  return 'csv';
}

/**
 * 根据格式把内容解析成「表头 + 数据行（二维）」。
 * @param {string} format 'csv' | 'json' | 'vcard'
 * @param {string} content
 * @param {Record<string, unknown>} options
 * @returns {{headers: string[], rows: string[][], delimiter?: string, parseError?: string}}
 */
function extractTable(format, content, options = {}) {
  if (format === 'json') {
    const objects = parseJsonRecords(content);
    if (objects === null) {
      return { headers: [], rows: [], parseError: 'import.errorInvalidJson' };
    }
    const headerSet = [];
    for (const entry of objects) {
      for (const key of Object.keys(entry)) {
        if (!headerSet.includes(key)) headerSet.push(key);
      }
    }
    const rows = objects.map((entry) => headerSet.map((key) => {
      const value = entry[key];
      if (value === null || value === undefined) return '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    }));
    return { headers: headerSet, rows, delimiter: undefined };
  }

  // vCard（.vcf/.vcard）：走 vcardToContactTable，输出 CONTACT_FIELDS 同名表头，
  // autoMapHeaders 对每个表头 1:1 命中——联系人导入无需手动重排列。
  if (format === 'vcard') {
    const table = vcardToContactTable(content, { fallbackCategory: 'misc' });
    return { headers: table.headers, rows: table.rows, delimiter: undefined };
  }

  const hasHeader = options.hasHeader !== false;
  const { rows: rawRows, delimiter } = parseCsvDetailed(content, { delimiter: options.delimiter });
  if (rawRows.length === 0) return { headers: [], rows: [], delimiter, parseError: 'import.errorEmptyFile' };

  const { headers, records } = rowsToRecords(rawRows, { hasHeader });
  const rows = records.map((record) => headers.map((key) => record[key] ?? ''));
  return { headers, rows, delimiter };
}

router.get('/modules', requireAdmin, (_req, res) => {
  res.json({ data: listImportModules() });
});

router.get('/history', requireAdmin, (req, res) => {
  try {
    const limit = Number.parseInt(String(req.query.limit ?? '20'), 10) || 20;
    res.json({ data: recentBatches(limit) });
  } catch (err) {
    log.error('GET /history failed:', err?.message || err);
    res.status(500).json({ error: 'Could not read import history.', code: 500 });
  }
});

/**
 * GET /api/v1/import/template?module=contacts
 * 导入模板下载：表头 = 模块目标字段 key（autoMapHeaders 1:1 命中），后带 1 行示例。
 * 未知 module → 400。响应为附件下载（text/csv; charset=utf-8）。
 */
router.get('/template', requireAdmin, (req, res) => {
  try {
    const moduleKey = String(req.query.module ?? '').trim();
    const template = buildTemplateCsv(moduleKey);
    if (!template) return res.status(400).json({ error: 'Unknown import module.', code: 400 });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="juju-import-${moduleKey}-template.csv"`);
    res.send(template.csv);
  } catch (err) {
    log.error('GET /template failed:', err?.message || err);
    res.status(500).json({ error: 'Could not generate the template.', code: 500 });
  }
});

router.post('/preview', requireAdmin, rawText, (req, res) => {
  try {
    const body = readBody(req);
    const moduleKey = String(body.module ?? '').trim();
    const module = getImportModule(moduleKey);
    if (!module) return res.status(400).json({ error: 'Unknown import module.', code: 400 });

    const format = readFormat(body.format);
    const { content, tooLarge } = readContent(body);
    if (tooLarge) return res.status(413).json({ error: 'File is too large (max 8 MB).', code: 413 });

    const table = extractTable(format, content, {
      hasHeader: body.hasHeader !== false,
      delimiter: typeof body.delimiter === 'string' && body.delimiter.length === 1 ? body.delimiter : undefined,
    });
    if (table.parseError) {
      return res.status(400).json({ error: table.parseError, code: 400 });
    }
    if (table.headers.length === 0 && table.rows.length === 0) {
      return res.status(400).json({ error: 'Nothing to import - the file is empty.', code: 400 });
    }

    const { mapping } = autoMapHeaders(module.key, table.headers);
    const sample = table.rows.slice(0, PREVIEW_ROWS);

    res.json({
      data: {
        module: module.key,
        format,
        delimiter: table.delimiter ?? null,
        hasHeader: body.hasHeader !== false,
        headers: table.headers,
        rows: sample,
        sampleCount: sample.length,
        totalRows: table.rows.length,
        truncated: table.rows.length > PREVIEW_ROWS,
        maxRows: MAX_ROWS,
        mapping,
      },
    });
  } catch (err) {
    log.error('POST /preview failed:', err?.message || err);
    res.status(500).json({ error: 'The file could not be read.', code: 500 });
  }
});

router.post('/run', requireAdmin, rawText, (req, res) => {
  try {
    const body = readBody(req);
    const moduleKey = String(body.module ?? '').trim();
    const module = getImportModule(moduleKey);
    if (!module) return res.status(400).json({ error: 'Unknown import module.', code: 400 });

    const format = readFormat(body.format);
    const mapping = (body.mapping && typeof body.mapping === 'object') ? body.mapping : {};
    if (Object.keys(mapping).length === 0) {
      return res.status(400).json({ error: 'No column mapping was provided.', code: 400 });
    }

    const { content, tooLarge } = readContent(body);
    if (tooLarge) return res.status(413).json({ error: 'File is too large (max 8 MB).', code: 413 });

    const hasHeader = body.hasHeader !== false;
    const table = extractTable(format, content, {
      hasHeader,
      delimiter: typeof body.delimiter === 'string' && body.delimiter.length === 1 ? body.delimiter : undefined,
    });
    if (table.parseError) return res.status(400).json({ error: table.parseError, code: 400 });

    const rows = table.rows.map((cells, index) => ({ cells, rowNumber: index + 2 })); // +2: 表头占第 1 行
    const records = buildRecords(module.key, rows, mapping);

    const report = runImport({
      moduleKey: module.key,
      records,
      dryRun: body.dry_run === true,
      skipDuplicates: body.skip_duplicates !== false,
      fileName: typeof body.filename === 'string' ? body.filename.slice(0, 200) : null,
      userId: req.authUserId || req.session?.userId || null,
    });

    res.json({ data: report });
  } catch (err) {
    log.error('POST /run failed:', err?.message || err);
    res.status(500).json({ error: 'The import could not be completed.', code: 500 });
  }
});

export default router;
