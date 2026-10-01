export function createSerialTaskRunner() {
  let tail = Promise.resolve();
  return function runSerialTask(task) {
    const current = tail.then(() => task());
    tail = current.then(() => undefined, () => undefined);
    return current;
  };
}
