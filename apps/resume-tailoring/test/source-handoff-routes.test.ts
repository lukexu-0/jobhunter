import { describe, expect, test } from "bun:test";
import { createApiHandler } from "../src/api/handler";
import {
  createSourceHandoffRoutes,
  type SourceHandoffRouteService,
} from "../src/api/source-handoff-routes";
import { SourceHandoffError } from "../src/api/source-handoff-service";
import {
  CreateSourceHandoffRequestSchema,
  SourceHandoffDtoSchema,
  type CreateSourceHandoffRequest,
  type RunDto,
  type SourceHandoffDto,
} from "../src/contracts";

const JOB_URL = "https://jobs.example.test/role";
const ORIGIN = "http://127.0.0.1:3456";
const HANDOFF_ID = "123e4567-e89b-42d3-a456-426614174000";
const HANDOFF: SourceHandoffDto = {
  id: HANDOFF_ID,
  state: "awaiting_human_verification",
  jobUrl: JOB_URL,
  expiresAt: 1_800_000,
};

function runDto(): RunDto {
  return {
    id: "run-1",
    jobUrl: JOB_URL,
    opportunityKind: "job",
    status: "queued",
    applicationStatus: "pending",
    isApplying: false,
    generateKeywordMap: true,
    skipReview: false,
    autoSubmit: false,
    queueSequence: 1,
    revision: 1,
    origin: "initial",
    createdAt: 1_000_000,
    updatedAt: 1_000_000,
    visualAcknowledgementRequired: false,
    attempts: [],
    artifacts: [],
    timeline: [],
  };
}

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function routeFixture(overrides: {
  createError?: unknown;
  getError?: unknown;
  completeError?: unknown;
  deleteError?: unknown;
  onCreate?: () => void;
} = {}) {
  const calls = {
    creates: [] as CreateSourceHandoffRequest[],
    gets: [] as string[],
    completes: [] as string[],
    deletes: [] as string[],
  };
  const service: SourceHandoffRouteService = {
    create: async (request) => {
      overrides.onCreate?.();
      calls.creates.push(request);
      if (overrides.createError !== undefined) throw overrides.createError;
      return HANDOFF;
    },
    get: async (id) => {
      calls.gets.push(id);
      if (overrides.getError !== undefined) throw overrides.getError;
      return HANDOFF;
    },
    complete: async (id) => {
      calls.completes.push(id);
      if (overrides.completeError !== undefined) throw overrides.completeError;
      return runDto();
    },
    delete: async (id) => {
      calls.deletes.push(id);
      if (overrides.deleteError !== undefined) throw overrides.deleteError;
    },
  };
  return {
    calls,
    route: createApiHandler({
      webOrigin: ORIGIN,
      route: createSourceHandoffRoutes(service),
    }),
  };
}

describe("source handoff contracts", () => {
  test("accepts only canonical URL-mode creation and never permits source in the public DTO", () => {
    expect(CreateSourceHandoffRequestSchema.parse({ jobUrl: `${JOB_URL}#apply` })).toEqual({
      jobUrl: JOB_URL,
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
    });
    expect(CreateSourceHandoffRequestSchema.safeParse({
      jobTitle: "Engineer",
      jobDescription: "A pasted description that is deliberately long enough for ordinary run creation.",
    }).success).toBe(false);

    const publicDto: SourceHandoffDto = {
      id: "123e4567-e89b-42d3-a456-426614174000",
      state: "awaiting_human_verification",
      jobUrl: JOB_URL,
      expiresAt: 1_800_000,
    };
    expect(SourceHandoffDtoSchema.parse(publicDto)).toEqual(publicDto);
    expect(SourceHandoffDtoSchema.safeParse({ ...publicDto, source: "private browser source" }).success)
      .toBe(false);
  });
});

describe("source handoff routes", () => {
  test("validates the strict HTTPS creation body before requesting an idle-timeout exemption", async () => {
    let validated = 0;
    const target = routeFixture({
      onCreate: () => {
        expect(validated).toBe(1);
      },
    });
    const context = {
      onSourceHandoffCreationValidated: () => {
        validated += 1;
      },
    };

    const malformed = await target.route(new Request(
      "http://127.0.0.1:3457/v1/source-handoffs",
      {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: "{",
      },
    ), context);
    expect(malformed.status).toBe(400);
    expect(validated).toBe(0);

    const pasted = await target.route(new Request(
      "http://127.0.0.1:3457/v1/source-handoffs",
      post({
        jobTitle: "Engineer",
        jobDescription: "A pasted description that remains valid only for ordinary run creation.",
      }),
    ), context);
    expect(pasted.status).toBe(400);
    expect(validated).toBe(0);

    for (const jobUrl of [
      "http://jobs.example.test/role",
      "https://jobs.example.test./role",
    ]) {
      const ineligible = await target.route(new Request(
        "http://127.0.0.1:3457/v1/source-handoffs",
        post({ jobUrl }),
      ), context);
      expect(ineligible.status).toBe(400);
      expect(await ineligible.json()).toEqual({
        error: {
          code: "SOURCE_HANDOFF_INVALID_URL",
          message: "Source handoff URL must use HTTPS with a canonical host",
        },
      });
      expect(validated).toBe(0);
    }
    expect(target.calls.creates).toEqual([]);

    const created = await target.route(new Request(
      "http://127.0.0.1:3457/v1/source-handoffs",
      post({ jobUrl: JOB_URL }),
    ), context);
    expect(created.status).toBe(201);
    expect(validated).toBe(1);
    expect(target.calls.creates).toHaveLength(1);
  });

  test("creates and gets only the strict public handoff DTO", async () => {
    const target = routeFixture();
    const created = await target.route(new Request(
      "http://127.0.0.1:3457/v1/source-handoffs",
      post({ jobUrl: `${JOB_URL}#apply` }),
    ));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual(HANDOFF);
    expect(target.calls.creates).toEqual([{
      jobUrl: JOB_URL,
      generateKeywordMap: true,
      skipReview: false,
      autoSubmit: false,
    }]);

    const fetched = await target.route(new Request(
      `http://127.0.0.1:3457/v1/source-handoffs/${HANDOFF_ID}`,
    ));
    expect(fetched.status).toBe(200);
    const body = await fetched.json();
    expect(body).toEqual(HANDOFF);
    expect(JSON.stringify(body)).not.toContain("source");
  });
  test("rejects non-canonical slash variants before timeout validation or service I/O", async () => {
    const target = routeFixture();
    let validated = 0;
    const context = {
      onSourceHandoffCreationValidated: () => { validated += 1; },
      onSourceHandoffCompletionValidated: () => { validated += 1; },
    };

    const create = await target.route(
      new Request("http://127.0.0.1:3457/v1/source-handoffs/", post({ jobUrl: JOB_URL })),
      context,
    );
    const complete = await target.route(
      new Request(
        `http://127.0.0.1:3457/v1/source-handoffs/${HANDOFF_ID}/complete/`,
        { method: "POST", headers: { origin: ORIGIN } },
      ),
      context,
    );

    expect(create.status).toBe(404);
    expect(complete.status).toBe(404);
    expect(validated).toBe(0);
    expect(target.calls.creates).toEqual([]);
    expect(target.calls.completes).toEqual([]);
  });


  test("completes only an exact bodyless mutation after validation and returns only RunDto", async () => {
    const target = routeFixture();
    let validated = 0;
    const invalid = await target.route(
      new Request(
        `http://127.0.0.1:3457/v1/source-handoffs/${HANDOFF_ID}/complete`,
        post({}),
      ),
      { onSourceHandoffCompletionValidated: () => { validated += 1; } },
    );
    expect(invalid.status).toBe(400);
    expect(validated).toBe(0);
    expect(target.calls.completes).toEqual([]);

    const malformedId = await target.route(
      new Request(
        "http://127.0.0.1:3457/v1/source-handoffs/not-a-uuid/complete",
        { method: "POST", headers: { origin: ORIGIN } },
      ),
      { onSourceHandoffCompletionValidated: () => { validated += 1; } },
    );
    expect(malformedId.status).toBe(404);
    expect(validated).toBe(0);
    expect(target.calls.completes).toEqual([]);

    const completed = await target.route(
      new Request(
        `http://127.0.0.1:3457/v1/source-handoffs/${HANDOFF_ID}/complete`,
        { method: "POST", headers: { origin: ORIGIN } },
      ),
      { onSourceHandoffCompletionValidated: () => { validated += 1; } },
    );
    expect(completed.status).toBe(201);
    const body = await completed.json();
    expect(body).toEqual(runDto());
    expect(JSON.stringify(body)).not.toContain("source");
    expect(validated).toBe(1);
    expect(target.calls.completes).toEqual([HANDOFF_ID]);

    const cancelled = await target.route(new Request(
      `http://127.0.0.1:3457/v1/source-handoffs/${HANDOFF_ID}`,
      { method: "DELETE", headers: { origin: ORIGIN } },
    ));
    expect(cancelled.status).toBe(204);
    expect(target.calls.deletes).toEqual([HANDOFF_ID]);
  });

  test("rejects pasted mode and returns only fixed coordinator failures", async () => {
    const strict = routeFixture();
    const pasted = await strict.route(new Request(
      "http://127.0.0.1:3457/v1/source-handoffs",
      post({
        jobTitle: "Engineer",
        jobDescription: "A pasted description that remains valid only for ordinary run creation.",
      }),
    ));
    expect(pasted.status).toBe(400);
    expect(strict.calls.creates).toEqual([]);

    for (const [error, status, code, message] of [
      [
        new SourceHandoffError("SOURCE_HANDOFF_NOT_FOUND"),
        404,
        "SOURCE_HANDOFF_NOT_FOUND",
        "Source handoff not found",
      ],
      [
        new SourceHandoffError("SOURCE_HANDOFF_CONFLICT"),
        409,
        "SOURCE_HANDOFF_CONFLICT",
        "A source handoff is already active",
      ],
      [
        new SourceHandoffError("SOURCE_HANDOFF_UNAVAILABLE"),
        503,
        "SOURCE_HANDOFF_UNAVAILABLE",
        "Source handoff is unavailable",
      ],
    ] as const) {
      const target = routeFixture({ getError: error });
      const response = await target.route(new Request(
        `http://127.0.0.1:3457/v1/source-handoffs/${HANDOFF_ID}`,
      ));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { code, message } });
    }

    const privateFailure = routeFixture({
      completeError: new Error("private captured source and browser detail"),
    });
    const response = await privateFailure.route(new Request(
      `http://127.0.0.1:3457/v1/source-handoffs/${HANDOFF_ID}/complete`,
      { method: "POST", headers: { origin: ORIGIN } },
    ));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Request failed" },
    });
  });
});
