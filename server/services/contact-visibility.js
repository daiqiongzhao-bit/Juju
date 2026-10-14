/**
 * Modul: Kontakt-Sichtbarkeit (Contact Visibility, R4 - rnw 补差)
 * Zweck: 统一的「对协作者隐藏」过滤——把 server/routes/relationships.js 里既有的
 *        `hidden = 0` 模式泛化到逐节点 ACL 表 `contact_node_acl`（Migration 150）。
 *
 * 语义（admin 不过滤；取不到身份时 fail-closed 全过滤）：
 *   - admin（req.authRole || req.user?.role || req.session?.role === 'admin'）：可见全部；
 *   - 非 admin：仅可见 `hidden = 0` 且未被 contact_node_acl 显式屏蔽的联系人；
 *   - 未登录/匿名（取不到 user_id）：`AND 1=0`——绝不因会话缺失而泄露数据。
 *
 * 三种用法：
 *   - visibilityFilter(req, alias)：SQL 片段，列表/单条读路径拼接（性能友好）；
 *   - isVisible(req, contactId)：JS 侧单点判定（insights/共同好友等 SQL 后过滤场景）；
 *   - visibleIdSet(req)：批量场景的可见 ID 集合（null = admin 无限制）。
 *
 * Abhängigkeiten: server/db.js（仅 isVisible/visibleIdSet 需要查询）
 */

import * as db from '../db.js';
import { createLogger } from '../logger.js';

const log = createLogger('ContactVisibility');

/**
 * 解析审视者角色。优先级与 auth 中间件（server/auth.js）写入 req 的顺序一致：
 * authRole（session/api-token 双通道）→ req.user.role → req.session.role。
 * @param {object} req Express-Request
 * @returns {string|null}
 */
function resolveRole(req) {
  return req?.authRole || req?.user?.role || req?.session?.role || null;
}

/**
 * 解析审视者 user_id。接受 number 或数字字符串；缺失/非正整数返回 null
 * （调用方按 fail-closed 处理）。
 * @param {object} req Express-Request
 * @returns {number|null}
 */
function resolveUserId(req) {
  const raw = req?.authUserId ?? req?.session?.userId ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  const uid = Number(raw);
  return Number.isInteger(uid) && uid > 0 ? uid : null;
}

/**
 * SQL 可见性过滤器——列表与单条读路径通用。
 *
 * @param {object} req   Express-Request（auth 中间件已填充 authUserId/authRole）
 * @param {string} alias contacts 表在 SQL 中的别名（如 'contacts' 或 'c'）
 * @returns {{sql: string, params: Array<number>}}
 *   admin → `{ sql: '', params: [] }`（不过滤）；
 *   非 admin → `{ sql: ' AND <alias>.hidden = 0 AND <alias>.id NOT IN (…)', params: [uid] }`；
 *   无 uid  → `{ sql: ' AND 1=0', params: [] }`（fail-closed）。
 */
export function visibilityFilter(req, alias) {
  if (resolveRole(req) === 'admin') return { sql: '', params: [] };

  const uid = resolveUserId(req);
  if (uid === null) {
    log.warn('visibilityFilter: request without user id — denying all rows (fail-closed).');
    return { sql: ' AND 1=0', params: [] };
  }

  return {
    sql: ` AND ${alias}.hidden = 0 AND ${alias}.id NOT IN (SELECT contact_id FROM contact_node_acl WHERE user_id = ?)`,
    params: [uid],
  };
}

/**
 * JS 侧单点可见性判定——供 insights/共同好友等在 SQL 结果出来后过滤的场景。
 * 联系人不存在时返回 false（与 404 语义一致，不泄露存在性）。
 *
 * @param {object} req        Express-Request
 * @param {number} contactId  联系人 ID
 * @returns {boolean} true = 对当前审视者可见
 */
export function isVisible(req, contactId) {
  if (resolveRole(req) === 'admin') return true;

  const uid = resolveUserId(req);
  if (uid === null) return false;

  const row = db.get().prepare('SELECT hidden FROM contacts WHERE id = ?').get(contactId);
  if (!row) return false;
  if (row.hidden === 1) return false;

  const blocked = db.get().prepare(
    'SELECT 1 FROM contact_node_acl WHERE contact_id = ? AND user_id = ?'
  ).get(contactId, uid);
  return !blocked;
}

/**
 * 批量场景的可见 ID 集合（可选助手）。
 *
 * @param {object} req Express-Request
 * @returns {Set<number>|null} null = admin（无限制，调用方跳过过滤）；
 *   否则可见联系人 ID 的集合（无 uid 时为空集合）。
 */
export function visibleIdSet(req) {
  if (resolveRole(req) === 'admin') return null;

  const uid = resolveUserId(req);
  if (uid === null) return new Set();

  const rows = db.get().prepare(
    `SELECT id FROM contacts
     WHERE hidden = 0
       AND id NOT IN (SELECT contact_id FROM contact_node_acl WHERE user_id = ?)`
  ).all(uid);
  return new Set(rows.map((r) => r.id));
}
