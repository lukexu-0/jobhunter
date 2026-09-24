import { expect, test } from "bun:test";

import { PipelineApplicationSubmissionGuard } from "../src/application/pipeline-submission-guard.ts";

const SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const TOKEN = "0123456789abcdef0123456789abcdef";

test("claims submission durably before the browser mutation", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const guard = new PipelineApplicationSubmissionGuard(
    SESSION_ID,
    "HTTP://LOCALHOST:3457/",
    TOKEN,
    async (input, init) => {
      requests.push({ url: String(input), init });
      return new Response(null, { status: 204 });
    },
  );

  await guard.claim();

  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(
    `http://localhost:3457/v1/internal/application-submissions/${SESSION_ID}/claim`,
  );
  expect(requests[0]?.init?.method).toBe("POST");
  expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
  expect(requests[0]?.init?.redirect).toBe("manual");
  expect(requests[0]?.init?.body).toBeUndefined();
});
