// Runs one RAR extraction in its own process (child_process.fork), because the unrar WASM engine is
// synchronous: in the main process a multi-GB archive would freeze the window and stall every download.
// Messages out: { type: 'progress', value } | { type: 'done' } | { type: 'error', password, message }.
const { createExtractorFromFile } = require('node-unrar-js');

class PasswordError extends Error {}

async function run({ file, dest, password }) {
  const send = m => process.send?.(m);
  try {
    const extractor = await createExtractorFromFile({ filepath: file, targetPath: dest, password: password || undefined });
    const headers = [...extractor.getFileList().fileHeaders];
    const total = headers.reduce((a, h) => a + (h.unpSize || 0), 0) || 1;
    if (headers.some(h => h.flags.encrypted) && !password) throw new PasswordError('Password required');
    let done = 0;
    let last = 0;
    for (const f of extractor.extract().files) {
      done += f.fileHeader.unpSize || 0;
      if (Date.now() - last > 200) {
        last = Date.now();
        send({ type: 'progress', value: done / total });
      }
    }
    send({ type: 'done' });
  } catch (e) {
    if (e instanceof PasswordError) send({ type: 'error', password: true, message: e.message });
    else if (/password/i.test(e.reason || e.message || '')) send({ type: 'error', password: true, message: 'Wrong password' });
    else send({ type: 'error', password: false, message: e.reason ? `${e.reason}${e.file ? ': ' + e.file : ''}` : e.message });
  }
}

process.once('message', job => run(job).finally(() => process.disconnect?.()));
