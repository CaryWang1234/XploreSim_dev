// A failed worker must settle every caller and allow the next request to start a fresh worker.
// The factory keeps this usable in the browser and testable without starting a simulation.
export function createWorkerClient(createWorker) {
  let worker = null;
  let nextId = 0;
  const pending = new Map();

  function dispose(error = new Error('Worker stopped')) {
    const old = worker;
    worker = null;
    if (old) {
      old.onmessage = old.onerror = old.onmessageerror = null;
      old.terminate();
    }
    for (const entry of pending.values()) entry.reject(error);
    pending.clear();
  }

  function ensureWorker() {
    if (worker) return worker;
    const current = createWorker();
    worker = current;
    current.onmessage = ({ data }) => {
      if (worker !== current) return;
      const { id, type, payload, ...rest } = data || {};
      const entry = pending.get(id);
      if (!entry) return;
      if (type === 'progress') {
        try {
          entry.onProgress?.(payload);
        } catch (error) {
          pending.delete(id);
          entry.reject(error);
        }
        return;
      }
      pending.delete(id);
      if (type === 'error') entry.reject(new Error(String(payload)));
      else if (type === 'result') entry.resolve({ ...payload, ...rest });
      else entry.reject(new Error(`Unexpected worker response: ${type}`));
    };
    current.onerror = (event) => {
      if (worker === current) dispose(new Error(event.message || 'Worker failed to load or execute'));
    };
    current.onmessageerror = () => {
      if (worker === current) dispose(new Error('Could not decode the worker response'));
    };
    return current;
  }

  function ask(type, payload, onProgress) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      try {
        const current = ensureWorker();
        pending.set(id, { resolve, reject, onProgress });
        current.postMessage({ id, type, payload });
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  return { ask, dispose };
}
