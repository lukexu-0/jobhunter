import { describe, expect, test } from "bun:test";
import { GmailClient } from "../src/gmail/client.ts";

const ACCESS_TOKEN = "test-access-token";

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof Request) return new URL(input.url);
  return new URL(input.toString());
}

describe("GmailClient", () => {
  test("rejects received-within windows longer than one day", async () => {
    let requests = 0;
    const client = new GmailClient({
      accessToken: async () => ACCESS_TOKEN,
      fetch: async () => {
        requests += 1;
        return Response.json({ messages: [] });
      },
    });

    await expect(client.searchInbox({ received_within_minutes: 1_441 })).rejects.toThrow();
    expect(requests).toBe(0);
  });

  test("searches the inbox by words and returns only bounded summaries", async () => {
    const requests: Array<{ url: URL; authorization: string | null }> = [];
    const client = new GmailClient({
      accessToken: async () => ACCESS_TOKEN,
      fetch: async (input, init) => {
        const url = requestUrl(input);
        const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
        requests.push({ url, authorization: headers.get("authorization") });
        if (url.pathname.endsWith("/messages")) {
          return Response.json({ messages: [{ id: "message-1" }] });
        }
        if (url.pathname.endsWith("/messages/message-1")) {
          return Response.json({
            id: "message-1",
            internalDate: "1799999900000",
            snippet: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one thirty-two",
            payload: {
              headers: [
                { name: "From", value: "Recruiter <recruiter@example.com>" },
                { name: "Subject", value: "Application status" },
              ],
            },
          });
        }
        return new Response(null, { status: 404 });
      },
    });

    const result = await client.searchInbox({ word_query: "application status" });

    expect(requests[0]?.url.pathname).toBe("/gmail/v1/users/me/messages");
    expect(requests[0]?.url.searchParams.get("labelIds")).toBe("INBOX");
    expect(requests[0]?.url.searchParams.get("q")).toBe("application status");
    expect(requests[0]?.url.searchParams.get("maxResults")).toBe("100");
    expect(requests[1]?.url.searchParams.get("format")).toBe("metadata");
    expect(requests[1]?.url.searchParams.getAll("metadataHeaders")).toEqual(["Subject", "From"]);
    expect(requests.map(({ authorization }) => authorization)).toEqual([
      `Bearer ${ACCESS_TOKEN}`,
      `Bearer ${ACCESS_TOKEN}`,
    ]);
    expect(result).toEqual({
      emails: [{
        id: "message-1",
        subject: "Application status",
        sender: "Recruiter <recruiter@example.com>",
        preview: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty",
      }],
      truncated: false,
    });
  });
  test("applies an exact received-time window", async () => {
    const listRequests: URL[] = [];
    const dates: Record<string, string> = {
      old: "1799996399999",
      matching: "1799997000000",
      recent: "1799999400001",
    };
    const client = new GmailClient({
      accessToken: async () => ACCESS_TOKEN,
      now: () => 1_800_000_000_000,
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname.endsWith("/messages")) {
          listRequests.push(url);
          return Response.json({ messages: Object.keys(dates).map((id) => ({ id })) });
        }
        const id = url.pathname.split("/").at(-1) ?? "";
        return Response.json({
          id,
          internalDate: dates[id],
          snippet: id,
          payload: { headers: [] },
        });
      },
    });

    const result = await client.searchInbox({
      received_within_minutes: 60,
      received_outside_last_minutes: 10,
    });

    expect(listRequests[0]?.searchParams.get("q")).toBe("after:1799996399 before:1799999401");
    expect(result.emails.map(({ id }) => id)).toEqual(["matching"]);
  });
  test("caps serialized search results at fifty KiB without partial emails", async () => {
    let metadataRequests = 0;
    const ids = Array.from({ length: 100 }, (_, index) => `message-${index}`);
    const client = new GmailClient({
      accessToken: async () => ACCESS_TOKEN,
      fetch: async (input) => {
        const url = requestUrl(input);
        if (url.pathname.endsWith("/messages")) {
          return Response.json({ messages: ids.map((id) => ({ id })) });
        }
        metadataRequests += 1;
        const id = url.pathname.split("/").at(-1) ?? "";
        return Response.json({
          id,
          snippet: "preview",
          payload: { headers: [
            { name: "Subject", value: "S".repeat(1_000) },
            { name: "From", value: "F".repeat(1_000) },
          ] },
        });
      },
    });

    const result = await client.searchInbox({});

    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(50 * 1_024);
    expect(result.truncated).toBe(true);
    expect(result.emails.length).toBeGreaterThan(0);
    expect(metadataRequests).toBeLessThan(ids.length);
    expect(result.emails.every((email) => Object.keys(email).sort().join(",") === "id,preview,sender,subject"))
      .toBe(true);
  });
  test("reads the full parsed MIME payload by message ID", async () => {
    let request: URL | undefined;
    const fullMessage = {
      id: "message-1",
      threadId: "thread-1",
      labelIds: ["INBOX"],
      internalDate: "1799999900000",
      payload: {
        mimeType: "multipart/alternative",
        headers: [{ name: "Subject", value: "Interview" }],
        parts: [{
          partId: "0",
          mimeType: "text/plain",
          body: { size: 12, data: "SGVsbG8gd29ybGQ=" },
        }],
      },
      sizeEstimate: 512,
    };
    const client = new GmailClient({
      accessToken: async () => ACCESS_TOKEN,
      fetch: async (input) => {
        request = requestUrl(input);
        return Response.json(fullMessage);
      },
    });

    const result = await client.readEmail("message-1");

    expect(request?.pathname).toBe("/gmail/v1/users/me/messages/message-1");
    expect(request?.searchParams.get("format")).toBe("full");
    expect(result).toEqual(fullMessage);
  });
});
