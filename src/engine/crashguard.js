// Network library errors that surface outside any request. Without a handler Electron shows a dialog that stops the main
// process until it's closed, which freezes every download and leaves a new window empty. These only affect one
// connection, and the stall watchdog in http.js restarts it, so they're logged instead.
const fs = require('fs');

const MAX_LOG = 1024 * 1024;

function isNetworkError(e) {
  const stack = String(e?.stack || '');
  const code = String(e?.code || '');
  return /undici/i.test(stack) || /^UND_ERR_/.test(code) || /^(ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)$/.test(code);
}

function logError(file, kind, e) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_LOG) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, `${new Date().toISOString()} ${kind}: ${e?.stack || e}\n`);
  } catch {}
}

// showFatal(error): for anything that isn't a network error, as Electron would without this handler.
function install({ log, showFatal, target = process }) {
  target.on('uncaughtException', e => {
    logError(log, 'uncaughtException', e);
    if (!isNetworkError(e)) showFatal(e);
  });
  target.on('unhandledRejection', e => logError(log, 'unhandledRejection', e));
}

module.exports = { install, isNetworkError, logError };
