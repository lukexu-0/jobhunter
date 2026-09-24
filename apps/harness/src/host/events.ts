export interface SessionEvent<TSession = unknown> {
  readonly id: number;
  readonly event: string;
  readonly session: TSession;
  readonly detail: Readonly<Record<string, unknown>>;
}

const EVENT_LIMIT = 256;

export class SessionEventStream<TSession> {
  readonly #snapshot: () => TSession;
  readonly #events: Array<SessionEvent<TSession>> = [];
  readonly #subscribers = new Set<ReadableStreamDefaultController<SessionEvent<TSession>>>();
  #nextEventId = 1;
  #closed = false;

  constructor(snapshot: () => TSession) {
    this.#snapshot = snapshot;
  }

  get retainedEvents(): readonly SessionEvent<TSession>[] {
    return this.#events;
  }

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  subscribe(lastEventId?: number | null): ReadableStream<SessionEvent<TSession>> {
    let controller: ReadableStreamDefaultController<SessionEvent<TSession>> | undefined;
    return new ReadableStream<SessionEvent<TSession>>({
      start: (opened) => {
        controller = opened;
        for (const event of this.replayAfter(lastEventId)) opened.enqueue(event);
        if (this.#closed) opened.close();
        else this.#subscribers.add(opened);
      },
      cancel: () => {
        if (controller !== undefined) this.#subscribers.delete(controller);
      },
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscriber of this.#subscribers) subscriber.close();
    this.#subscribers.clear();
  }

  publish(
    event: string,
    session: TSession,
    detail: Readonly<Record<string, unknown>> = {},
  ): SessionEvent<TSession> {
    const published = Object.freeze({
      id: this.#nextEventId,
      event,
      session,
      detail: Object.freeze({ ...detail }),
    });
    this.#nextEventId += 1;
    this.#events.push(published);
    if (this.#events.length > EVENT_LIMIT) this.#events.shift();
    for (const subscriber of this.#subscribers) subscriber.enqueue(published);
    return published;
  }

  replayAfter(lastEventId?: number | null): readonly SessionEvent<TSession>[] {
    if (lastEventId === undefined || lastEventId === null) return [...this.#events];
    const latestId = this.#events.at(-1)?.id ?? 0;
    const oldestId = this.#events[0]?.id ?? latestId;
    if (lastEventId > latestId || (this.#events.length > 0 && lastEventId < oldestId - 1)) {
      return [Object.freeze({
        id: latestId,
        event: "snapshot",
        session: this.#snapshot(),
        detail: Object.freeze({}),
      })];
    }
    return this.#events.filter((event) => event.id > lastEventId);
  }
}
