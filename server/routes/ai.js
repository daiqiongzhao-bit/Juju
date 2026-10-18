/**
 * Modul: AI 路由（菜谱生成 + 提供方配置）
 * Zweck: 应用内的 AI 入口。设置走 /config（仅管理员），生成走 /recipes/generate
 *        （任何登录成员都可用：做饭的人不一定管服务器）。
 *
 * 错误策略（medien-metadata 同款）：所有失败收敛为 { ok:false, code, message }，
 * code 是稳定枚举值，前端按 code 取本地化文案；原始错误只进服务端日志。
 *
 * Abhängigkeiten: express, server/auth.js, services/ai-config.js, services/ai-recipe.js
 */

import express from 'express';

import { requireAdmin } from '../auth.js';
import { createLogger } from '../logger.js';
import * as aiConfig from '../services/ai-config.js';
import * as aiRecipe from '../services/ai-recipe.js';

const router = express.Router();
const log = createLogger('AI');

router.get('/config', requireAdmin, (_req, res) => {
  try {
    res.json({ data: aiConfig.getPublicConfig() });
  } catch (err) {
    log.error('GET /config failed:', err?.message || err);
    res.status(500).json({ error: 'The AI settings could not be read.', code: 500 });
  }
});

router.put('/config', requireAdmin, (req, res) => {
  try {
    const body = req.body ?? {};
    const result = aiConfig.saveConfig({
      provider: body.provider,
      baseUrl: body.baseUrl,
      apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
      clearKey: body.clearKey === true,
      model: body.model,
      enabled: body.enabled === true,
    }, req.authUserId || req.session?.userId || null);

    if (!result.ok) {
      const status = result.code === 'ENCRYPTION_UNAVAILABLE' ? 500 : 400;
      res.status(status).json({ error: result.error, code: status });
      return;
    }
    res.json({ data: result.data });
  } catch (err) {
    log.error('PUT /config failed:', err?.message || err);
    res.status(500).json({ error: 'The AI settings could not be saved.', code: 500 });
  }
});

router.post('/test', requireAdmin, async (_req, res) => {
  try {
    const result = await aiRecipe.testConnection();
    res.json({ data: result });
  } catch (err) {
    log.error('POST /test failed:', err?.message || err);
    res.json({ data: { ok: false, code: 'unexpected', message: 'The connection test failed.' } });
  }
});

router.post('/recipes/generate', async (req, res) => {
  try {
    const body = req.body ?? {};
    const result = await aiRecipe.generateRecipe({
      prompt: body.prompt,
      servings: body.servings,
    });
    // 生成失败是「常态」之一（没配 Key、模型抽风），因此仍然回 200 + ok:false，
    // 让前端能稳定地渲染友好提示，而不是走全局错误弹窗。
    res.json({ data: result });
  } catch (err) {
    log.error('POST /recipes/generate failed:', err?.message || err);
    res.json({ data: { ok: false, code: 'unexpected', message: 'The recipe could not be generated.' } });
  }
});

export default router;
