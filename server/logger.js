/**
 * Modul: Logger
 * Zweck: Levelbasiertes strukturiertes Logging ohne externe Dependencies.
 *        Ausgabe als JSON in Production, lesbar in Development.
 * Steuerung: LOG_LEVEL env var (debug, info, warn, error). Default: info.
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
const isProduction = process.env.NODE_ENV === 'production';

function emit(level, mod, msg, extra) {
  if (LEVELS[level] < currentLevel) return;

  const normalizedExtra = extra instanceof Error
    ? {
        name: extra.name,
        message: extra.message,
        stack: extra.stack,
      }
    : extra;

  if (isProduction) {
    const entry = { ts: new Date().toISOString(), level, mod, msg };
    if (normalizedExtra !== undefined) entry.extra = normalizedExtra;
    process.stdout.write(JSON.stringify(entry) + '\n');
  } else {
    const prefix = `[${mod}]`;
    if (normalizedExtra !== undefined) {
      console[level === 'debug' ? 'log' : level](prefix, msg, normalizedExtra);
    } else {
      console[level === 'debug' ? 'log' : level](prefix, msg);
    }
  }
}

function createLogger(mod) {
  return {
    debug: (msg, extra) => emit('debug', mod, msg, extra),
    info:  (msg, extra) => emit('info',  mod, msg, extra),
    warn:  (msg, extra) => emit('warn',  mod, msg, extra),
    error: (msg, extra) => emit('error', mod, msg, extra),
  };
}

export { createLogger };
