export interface JobQueue { enqueue<T>(task: () => Promise<T>): Promise<T>; readonly pending: number; readonly active: number; }

export class InProcessJobQueue implements JobQueue {
  readonly #concurrency: number;
  readonly #waiting: Array<() => void> = [];
  #active = 0;
  constructor(concurrency = 1) { if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Queue concurrency must be positive"); this.#concurrency = concurrency; }
  get pending() { return this.#waiting.length; }
  get active() { return this.#active; }
  async enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#concurrency) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try { return await task(); }
    finally { this.#active--; this.#waiting.shift()?.(); }
  }
}

export interface ObjectStore { put(key: string, bytes: Uint8Array): Promise<void>; get(key: string): Promise<Uint8Array | undefined>; }
