import type { ApplicationSubmissionGuard } from "./agent-runtime/contracts/application.ts";

export type SubmissionControlFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class PipelineSubmissionControlError extends Error {
  constructor(options?: ErrorOptions) {
    super("The application submission state could not be updated", options);
    this.name = "PipelineSubmissionControlError";
  }
}

function loopbackOrigin(value: string): string {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(hostname) ||
    parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
  ) {
    throw new TypeError("pipeline_url must be a loopback HTTP origin");
  }
  return parsed.origin;
}

export class PipelineApplicationSubmissionGuard implements ApplicationSubmissionGuard {
  readonly #sessionId: string;
  readonly #origin: string;
  readonly #authorization: string;
  readonly #fetch: SubmissionControlFetch;

  constructor(
    sessionId: string,
    pipelineUrl: string,
    bearerToken: string,
    fetcher: SubmissionControlFetch = fetch,
  ) {
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(sessionId)) {
      throw new TypeError("session_id must be a UUID");
    }
    if ([...bearerToken].length < 32 || bearerToken.includes("\0")) {
      throw new TypeError("bearer_token must contain at least 32 characters");
    }
    this.#sessionId = sessionId;
    this.#origin = loopbackOrigin(pipelineUrl);
    this.#authorization = `Bearer ${bearerToken}`;
    this.#fetch = fetcher;
  }

  async markReviewReady(): Promise<void> {
    await this.#post("review-ready");
  }

  async claim(): Promise<void> {
    await this.#post("claim");
  }

  async finalize(outcome: "submitted" | "uncertain"): Promise<void> {
    await this.#post("finalize", outcome);
  }

  async #post(operation: "review-ready" | "claim" | "finalize", outcome?: "submitted" | "uncertain"): Promise<void> {
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#origin}/v1/internal/application-submissions/${this.#sessionId}/${operation}`,
        {
          method: "POST",
          headers: {
            authorization: this.#authorization,
            ...(outcome === undefined ? {} : { "content-type": "application/json" }),
          },
          redirect: "manual",
          ...(outcome === undefined ? {} : { body: JSON.stringify({ outcome }) }),
        },
      );
    } catch (error) {
      throw new PipelineSubmissionControlError({ cause: error });
    }
    if (response.status !== 204 || (await response.arrayBuffer()).byteLength !== 0) {
      throw new PipelineSubmissionControlError();
    }
  }
}
