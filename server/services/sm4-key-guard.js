/**
 * Modul: SM4 Key Startup Guard
 * Zweck: 拒启保护——JUJU_SM4_KEY 缺失或非法时进程以非零码退出（用户决策③）。
 *
 * 导入顺序至关重要：本模块必须排在 `./db.js` 之前被导入。db.js 在模块
 * 求值时会自动执行 init() → migrate()，其中加密存量数据的迁移需要 SM4
 * 密钥；守卫若晚于 db.js 运行，缺密钥时先崩在迁移里而不是给出明确的
 * FATAL 提示。ESM 按 import 语句的源码顺序求值，故 index.js 将本模块
 * 放在导入列表首位。
 */

const SM4_KEY_PATTERN = /^[0-9a-fA-F]{32}$/;

/**
 * Prüft JUJU_SM4_KEY und beendet den Prozess bei Verletzung.
 * Side-Effect-Modul: der Check läuft bereits beim Import.
 */
function assertSm4Key() {
  const key = process.env.JUJU_SM4_KEY;
  if (key && SM4_KEY_PATTERN.test(key)) return;

  console.error('[FATAL] JUJU_SM4_KEY is missing or invalid.');
  console.error('[FATAL] It must be 32 hex chars (16 bytes). Generate: openssl rand -hex 16');
  console.error('[FATAL] Configure via systemd Environment / .env / start.sh, then restart.');
  process.exit(1);
}

assertSm4Key();

export { assertSm4Key, SM4_KEY_PATTERN };
