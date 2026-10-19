// Runs tasks with the same key one after another; different keys run in parallel.
function createKeyedQueue() {
  const queues = new Map();

  function enqueue(key, task) {
    const id = String(key);
    const previous = queues.get(id) || Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(task)
      .finally(() => {
        if (queues.get(id) === next) {
          queues.delete(id);
        }
      });

    queues.set(id, next);
    return next;
  }

  // Resolves when every task queued so far has finished (used to let replies go out before shutdown).
  enqueue.whenIdle = () => Promise.allSettled([...queues.values()]);

  return enqueue;
}

module.exports = {
  createKeyedQueue
};
