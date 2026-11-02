const fs = require("fs");

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

// Antivirus scanners and indexers on Windows can hold a file for a few milliseconds.
// Only filesystem calls are retried, never the code that produced the data.
function retryIO(action) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= 5 || !RETRYABLE.has(error.code)) {
        throw error;
      }

      Atomics.wait(sleeper, 0, 0, 5 * (attempt + 1));
    }
  }
}

// Writes next to the target and renames into place, so a crash leaves either the old or the new file.
// The previous file is copied to `<filename>.bak` first, unless `canBackup(filename)` says it is damaged.
function writeFileAtomic(filename, text, { canBackup = () => true } = {}) {
  const temp = `${filename}.${process.pid}.tmp`;

  try {
    const fd = fs.openSync(temp, "w", 0o600);

    try {
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (fs.existsSync(filename) && canBackup(filename)) {
      retryIO(() => fs.copyFileSync(filename, `${filename}.bak`));
    }

    retryIO(() => fs.renameSync(temp, filename));
  } finally {
    retryIO(() => fs.rmSync(temp, { force: true }));
  }
}

module.exports = {
  retryIO,
  writeFileAtomic
};
