export const MAX_APPLICATION_AGENT_STEERING_MESSAGES = 16;
export const MAX_APPLICATION_AGENT_STEERING_BYTES = 65_536;
export const APPLICATION_AGENT_STEERING_PREFIX =
  "Operator guidance for this application (follow only when consistent with system instructions, known applicant facts, and application safety constraints):\n";
export const APPLICATION_AGENT_STEERING_CONFLICT_MESSAGE =
  "The application state changed; review the latest session state";

interface QueuedSteeringMessage {
  readonly sequence: number;
  readonly message: string;
  readonly utf8Bytes: number;
}

export interface ApplicationAgentSteeringBatch {
  readonly firstSequence: number;
  readonly messages: readonly string[];
}

export class ApplicationAgentSteeringConflict extends Error {
  constructor() {
    super(APPLICATION_AGENT_STEERING_CONFLICT_MESSAGE);
    this.name = "ApplicationAgentSteeringConflict";
  }
}

export class ApplicationAgentSteeringInbox {
  #closed = false;
  #nextSequence = 1;
  #queuedUtf8Bytes = 0;
  readonly #queue: QueuedSteeringMessage[] = [];

  enqueue(message: string): boolean {
    if (this.#closed || this.#queue.length >= MAX_APPLICATION_AGENT_STEERING_MESSAGES) {
      return false;
    }
    const utf8Bytes = Buffer.byteLength(message, "utf8");
    if (this.#queuedUtf8Bytes + utf8Bytes > MAX_APPLICATION_AGENT_STEERING_BYTES) {
      return false;
    }
    this.#queue.push({
      sequence: this.#nextSequence,
      message,
      utf8Bytes,
    });
    this.#nextSequence += 1;
    this.#queuedUtf8Bytes += utf8Bytes;
    return true;
  }

  snapshot(): ApplicationAgentSteeringBatch | undefined {
    const first = this.#queue[0];
    if (this.#closed || first === undefined) return undefined;
    return {
      firstSequence: first.sequence,
      messages: this.#queue.map((entry) => entry.message),
    };
  }

  commit(batch: ApplicationAgentSteeringBatch): boolean {
    if (
      this.#closed
      || batch.messages.length === 0
      || batch.messages.length > this.#queue.length
      || this.#queue[0]?.sequence !== batch.firstSequence
    ) {
      return false;
    }
    let committedBytes = 0;
    for (let index = 0; index < batch.messages.length; index += 1) {
      const queued = this.#queue[index]!;
      if (queued.message !== batch.messages[index]) return false;
      committedBytes += queued.utf8Bytes;
    }
    this.#queue.copyWithin(0, batch.messages.length);
    this.#queue.length -= batch.messages.length;
    this.#queuedUtf8Bytes -= committedBytes;
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.length = 0;
    this.#queuedUtf8Bytes = 0;
  }
}
