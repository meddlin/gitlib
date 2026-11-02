/** Interactive chat is served ahead of background work; see `ModelLane`. */
export type LaneKind = "chat" | "batch";

export interface LaneTicket {
  readonly kind: LaneKind;
  /** Aborts when a chat takes the lane from a batch task. A chat's own ticket never aborts. */
  readonly signal: AbortSignal;
  /** Gives the lane back. Safe to call more than once. */
  release(): void;
}

/** How long a batch task has to let go after a chat asked for the lane, before the lane moves on without it. */
export const PREEMPT_GRACE_MS = 10_000;

interface Waiter {
  kind: LaneKind;
  grant(): void;
}

/**
 * One model request at a time. Ollama serves a loaded model's requests one by one and has no priority, and the GPU
 * is shared by the chat panel and background jobs, so the app does the ordering (docs/ollama-integration.md, "Work
 * queue"): a chat goes ahead of any waiting batch task and tells a running one to stop, and the batch task, being
 * idempotent, picks its item up again later. Only this process's callers are seen; a second process is not.
 */
export class ModelLane {
  private current: { controller: AbortController; kind: LaneKind } | null = null;
  private readonly waiting: Waiter[] = [];

  get busy(): boolean {
    return this.current !== null;
  }

  /** Waits for the lane. Resolves null instead if `signal` aborts first (the caller gave up while queued). */
  acquire(kind: LaneKind, signal?: AbortSignal): Promise<LaneTicket | null> {
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(null);
      };
      const waiter: Waiter = {
        kind,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          const controller = new AbortController();
          this.current = { controller, kind };
          resolve(this.ticket(kind, controller));
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      if (kind === "chat" && this.current?.kind === "batch") this.preempt(this.current.controller);
      this.dispatch();
    });
  }

  private preempt(controller: AbortController): void {
    controller.abort();
    // A batch task that never lets go must not keep a person's chat waiting.
    const timer = setTimeout(() => {
      if (this.current?.controller === controller) {
        this.current = null;
        this.dispatch();
      }
    }, PREEMPT_GRACE_MS);
    timer.unref();
  }

  private dispatch(): void {
    if (this.current) return;
    const next = this.waiting.find((waiter) => waiter.kind === "chat") ?? this.waiting[0];
    if (!next) return;
    this.waiting.splice(this.waiting.indexOf(next), 1);
    next.grant();
  }

  private ticket(kind: LaneKind, controller: AbortController): LaneTicket {
    let released = false;
    return {
      kind,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        if (this.current?.controller === controller) this.current = null;
        this.dispatch();
      },
    };
  }
}
