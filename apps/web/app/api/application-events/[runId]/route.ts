const PIPELINE_ORIGIN = process.env.JOBHUNTER_PIPELINE_ORIGIN ?? "http://127.0.0.1:3457";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  readonly params: Promise<{ readonly runId: string }>;
}

function unavailableResponse(): Response {
  return Response.json(
    {
      error: {
        code: "PIPELINE_UNAVAILABLE",
        message: "The pipeline request failed.",
      },
    },
    {
      status: 502,
      headers: { "cache-control": "no-store" },
    },
  );
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { runId } = await context.params;
  const headers = new Headers({ accept: "text/event-stream" });
  const lastEventId = request.headers.get("last-event-id");
  if (lastEventId !== null) headers.set("last-event-id", lastEventId);

  let upstream: Response;
  try {
    upstream = await fetch(
      new URL(
        `/v1/runs/${encodeURIComponent(runId)}/application/events`,
        PIPELINE_ORIGIN,
      ),
      {
        headers,
        cache: "no-store",
        redirect: "manual",
        signal: request.signal,
      },
    );
  } catch {
    return unavailableResponse();
  }

  const responseHeaders = new Headers({
    "cache-control": "no-store, no-transform",
  });
  for (const name of ["content-type", "x-accel-buffering"] as const) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
