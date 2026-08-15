import { describe, expect, test } from "bun:test";
import {
  JobSourceError,
  fetchPinnedPublicHttp,
  loadJobSourceFromUrl,
  type JobSourceFetch,
  type ResolveHost,
} from "../src/api/job-source";

const PUBLIC_V4 = "93.184.216.34";
const resolvePublic: ResolveHost = async () => [{ address: PUBLIC_V4, family: 4 }];

function response(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/plain", ...headers } });
}

function htmlResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });
}

const VALID_TEXT = "Senior engineer builds secure systems and collaborates across the whole product team.";

function ipv4Number(address: string): bigint {
  return address.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Number(address: string): bigint {
  const [leftSource, rightSource = ""] = address.split("::");
  const left = leftSource ? leftSource.split(":") : [];
  const right = rightSource ? rightSource.split(":") : [];
  const groups = [
    ...left,
    ...Array(8 - left.length - right.length).fill("0"),
    ...right,
  ];
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || "0"}`), 0n);
}

function addressEndpoints(cidr: string): readonly [string, string] {
  const [address, prefixSource] = cidr.split("/");
  const prefix = Number(prefixSource);
  if (address!.includes(":")) {
    const first = ipv6Number(address!) & (((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix));
    const last = first | ((1n << BigInt(128 - prefix)) - 1n);
    const format = (value: bigint) => Array.from(
      { length: 8 },
      (_unused, index) => ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
    ).join(":");
    return [format(first), format(last)];
  }
  const first = ipv4Number(address!) & (((1n << BigInt(prefix)) - 1n) << BigInt(32 - prefix));
  const last = first | ((1n << BigInt(32 - prefix)) - 1n);
  const format = (value: bigint) => [24n, 16n, 8n, 0n]
    .map((shift) => Number((value >> shift) & 0xffn))
    .join(".");
  return [format(first), format(last)];
}

function deferred<T>() {
  return Promise.withResolvers<T>();
}

describe("job source loading", () => {
  test("returns normalized plain text as model lines when opportunity kind is omitted", async () => {
    const fetchImpl: JobSourceFetch = async () => response(
      "  Senior   Engineer\r\n\r\n Build\tsecure systems and collaborate across the whole team.  ",
    );

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl,
      resolveHost: resolvePublic,
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: ["Senior Engineer", "", "Build secure systems and collaborate across the whole team."],
    });
  });
  test("uses an explicit networking event kind for a deterministic event page", async () => {
    const eventDescription =
      "Platform engineering networking evening\n\nMeet infrastructure engineers and discuss reliable systems in structured small-group sessions.";

    await expect(loadJobSourceFromUrl(
      "https://events.example.test/networking/platform-engineers",
      undefined,
      {
        fetchImpl: async () => response(eventDescription),
        resolveHost: resolvePublic,
      },
      "networking_event",
    )).resolves.toEqual({
      kind: "description",
      opportunityKind: "networking_event",
      jobDescription: eventDescription,
    });
  });


  test("keeps deterministic description bounds authoritative for an explicit plain-text kind", async () => {
    for (const [body, code] of [
      ["界".repeat(20), "JOB_DESCRIPTION_UNAVAILABLE"],
      ["x".repeat(50_001), "JOB_SOURCE_TOO_LARGE"],
    ] as const) {
      const promise = loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        fetchImpl: async () => response(body),
        resolveHost: resolvePublic,
      }, "job");
      await expect(promise).rejects.toMatchObject({ code });
    }

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => response("界".repeat(40)),
      resolveHost: resolvePublic,
    }, "job")).resolves.toEqual({ kind: "description", opportunityKind: "job", jobDescription: "界".repeat(40) });
  });

  test("rejects a twenty-character CJK HTML page before exposing fallback lines", async () => {
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(`<main>${"界".repeat(20)}</main>`),
      resolveHost: resolvePublic,
    })).rejects.toMatchObject({ code: "JOB_DESCRIPTION_UNAVAILABLE" });
  });

  test("loads a JPMC Oracle Candidate Experience shell through its same-origin public requisition API", async () => {
    const attempts: Array<{ url: URL; init: BunFetchRequestInit }> = [];
    const shell = `<!doctype html>
      <html lang="en">
        <head>
          <meta property="og:title" content="2026 Software Engineer Program">
          <meta property="og:description" content="Build your career at JPMorganChase.">
        </head>
        <body><div id="app"></div><script src="/hcmUI/CandidateExperience/cx.js"></script></body>
      </html>`;
    const fetchImpl: JobSourceFetch = async (input, init) => {
      const attempt = { url: new URL(input), init };
      attempts.push(attempt);
      if (attempts.length === 1) return htmlResponse(shell);
      return new Response(JSON.stringify({
        items: [{
          Id: 210775223,
          Title: "2026 Software Engineer Program – Summer Internship",
          ExternalDescriptionStr: [
            "<p>Design, develop, and deliver technology products that improve experiences for our clients and colleagues.</p>",
            "<p>Work with engineers and business partners to build secure, scalable solutions across the full software development lifecycle.</p>",
          ].join(""),
        }],
        count: 1,
        hasMore: false,
        limit: 25,
        offset: 0,
      }), { headers: { "content-type": "application/vnd.oracle.adf.resourcecollection+json; charset=utf-8" } });
    };

    const result = await loadJobSourceFromUrl(
      "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210775223",
      undefined,
      { fetchImpl, resolveHost: resolvePublic },
    );

    expect(result).toEqual({
      kind: "model-fallback",
      lines: [
        "2026 Software Engineer Program – Summer Internship",
        "Design, develop, and deliver technology products that improve experiences for our clients and colleagues.",
        "Work with engineers and business partners to build secure, scalable solutions across the full software development lifecycle.",
      ],
    });
    expect(result).not.toEqual({
      kind: "model-fallback",
      lines: ["Build your career at JPMorganChase."],
    });
    expect(attempts).toHaveLength(2);
    const apiAttempt = attempts[1]!;
    expect(apiAttempt.url.hostname).toBe(PUBLIC_V4);
    expect(apiAttempt.url.pathname).toBe("/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails");
    expect(apiAttempt.url.search).toBe("?expand=all&onlyData=true&finder=ById;Id=%22210775223%22,siteNumber=CX_1001");
    const apiHeaders = new Headers(apiAttempt.init.headers);
    expect(apiHeaders.get("host")).toBe("jpmc.fa.oraclecloud.com");
    expect(apiHeaders.get("accept")).toBe("application/json");
    expect(apiHeaders.get("accept-encoding")).toBe("identity");
    expect(apiAttempt.init.redirect).toBe("manual");
    expect(apiAttempt.init.decompress).toBe(false);
    expect(apiAttempt.init.tls).toEqual({ rejectUnauthorized: true, serverName: "jpmc.fa.oraclecloud.com" });
  });

  test("uses the Oracle adapter only for its exact HTTPS host and Candidate Experience path", async () => {
    for (const sourceUrl of [
      "https://jobs.example.test/hcmUI/CandidateExperience/en/sites/CX_1001/job/210775223",
      "https://fa.oraclecloud.com.evil.test/hcmUI/CandidateExperience/en/sites/CX_1001/job/210775223",
      "http://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210775223",
      "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210775223/details",
    ]) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl(sourceUrl, undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => {
          fetches += 1;
          return htmlResponse("<html><body><div id=\"app\"></div></body></html>");
        },
      })).rejects.toMatchObject({ code: "JOB_DESCRIPTION_UNAVAILABLE" });
      expect(fetches).toBe(1);
    }
  });

  test("keeps JSON-LD model input ahead of the Oracle adapter in Auto-detect", async () => {
    let fetches = 0;
    await expect(loadJobSourceFromUrl(
      "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210775223",
      undefined,
      {
        resolveHost: resolvePublic,
        fetchImpl: async () => {
          fetches += 1;
          return htmlResponse(`<script type="application/ld+json">${JSON.stringify({
            "@type": "Hackathon",
            name: "Data for Good Hackathon",
            organizer: { name: "JPMorganChase" },
            description: "Build data and AI solutions for nonprofit organizations with an engineering team.",
          })}</script>`);
        },
      },
    )).resolves.toEqual({
      kind: "model-fallback",
      lines: [
        "Data for Good Hackathon",
        "",
        "JPMorganChase",
        "",
        "Build data and AI solutions for nonprofit organizations with an engineering team.",
      ],
    });
    expect(fetches).toBe(1);
  });

  test("rejects unusable Oracle requisition API responses", async () => {
    const validItem = {
      Id: "210775223",
      Title: "Software Engineer Internship",
      ExternalDescriptionStr: "<p>Build secure systems and collaborate across the full product lifecycle.</p>",
    };
    const cases = [
      {
        response: new Response("{", { headers: { "content-type": "application/json" } }),
        code: "JOB_SOURCE_UNAVAILABLE",
      },
      {
        response: new Response(JSON.stringify({ items: [{ ...validItem, Id: "999" }] }), {
          headers: { "content-type": "application/json" },
        }),
        code: "JOB_DESCRIPTION_UNAVAILABLE",
      },
      {
        response: new Response(JSON.stringify({ items: [{ ...validItem, Id: ["210775223"] }] }), {
          headers: { "content-type": "application/json" },
        }),
        code: "JOB_DESCRIPTION_UNAVAILABLE",
      },
      {
        response: new Response(JSON.stringify({ items: [validItem] }), {
          headers: { "content-type": "text/html" },
        }),
        code: "JOB_SOURCE_UNSUPPORTED",
      },
      {
        response: new Response(JSON.stringify({ items: [validItem] }), {
          headers: { "content-type": "constructor" },
        }),
        code: "JOB_SOURCE_UNSUPPORTED",
      },
      {
        response: new Response("unavailable", {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
        code: "JOB_SOURCE_UNAVAILABLE",
      },
    ] as const;

    for (const item of cases) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl(
        "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210775223",
        undefined,
        {
          resolveHost: resolvePublic,
          fetchImpl: async () => {
            fetches += 1;
            return fetches === 1
              ? htmlResponse("<html><body><div id=\"app\"></div></body></html>")
              : item.response;
          },
        },
      )).rejects.toMatchObject({ code: item.code });
      expect(fetches).toBe(2);
    }
  });

  test("returns one exact valid JSON-LD JobPosting candidate as model lines", async () => {
    const body = `
      <html><body>
        <script type=" Application/LD+JSON ; charset=utf-8 ">
          {"@type":"JobPosting","title":"Senior &amp; Staff Engineer &mdash; &#x754C;",
           "hiringOrganization":{"name":"Example <strong>Labs</strong>"},
           "description":"<p>Build secure systems.</p><p>Collaborate across the product team.</p>"}
        </script>
      </body></html>`;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: [
        "Senior & Staff Engineer — 界",
        "",
        "Example Labs",
        "",
        "Build secure systems.",
        "Collaborate across the product team.",
      ],
    });
  });

  test("extracts supported non-job JSON-LD opportunities as deterministic model lines", async () => {
    for (const [schemaType, organizationField] of [
      ["Hackathon", "organizer"],
      ["Competition", "sponsor"],
      ["Event", "organizer"],
    ] as const) {
      const body = `<script type="application/ld+json">${JSON.stringify({
        "@type": `https://schema.org/${schemaType}`,
        name: `${schemaType} title`,
        [organizationField]: { name: "Example Labs" },
        description: VALID_TEXT,
      })}</script>`;
      await expect(loadJobSourceFromUrl("https://events.example.test/apply", undefined, {
        fetchImpl: async () => htmlResponse(body),
        resolveHost: resolvePublic,
      })).resolves.toEqual({
        kind: "model-fallback",
        lines: [`${schemaType} title`, "", "Example Labs", "", VALID_TEXT],
      });
    }
  });

  test("decodes HTML fragment entities exactly once", async () => {
    const body = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Senior &amp;lt;Staff&amp;gt; Engineer",
      description: VALID_TEXT,
    })}</script>`;

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: ["Senior &lt;Staff&gt; Engineer", "", VALID_TEXT],
    });
  });

  test("recognizes exact JSON-LD types recursively and rejects near-matches and non-string fields", async () => {
    const acceptedTypes = [
      "JobPosting",
      "http://schema.org/JobPosting",
      "https://schema.org/JobPosting",
    ];
    for (const acceptedType of acceptedTypes) {
      const body = `<script type="application/ld+json">${JSON.stringify({
        "@graph": [{ nested: [{ "@type": ["Other", acceptedType], title: 1, hiringOrganization: { name: false }, description: VALID_TEXT }] }],
      })}</script>`;
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        fetchImpl: async () => htmlResponse(body),
        resolveHost: resolvePublic,
      })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    }

    for (const rejectedType of ["jobposting", "JobPosting ", "schema:JobPosting", "https://schema.org/JobPosting/"]) {
      const body = `<main>${VALID_TEXT}</main><script type="application/ld+json">${JSON.stringify({
        "@type": rejectedType,
        description: "A different deterministic candidate that must not be accepted.",
      })}</script>`;
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        fetchImpl: async () => htmlResponse(body),
        resolveHost: resolvePublic,
      })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    }
  });

  test("sends conflicting JSON-LD opportunity kinds to model fallback", async () => {
    const body = `<main>${VALID_TEXT}</main><script type="application/ld+json">${JSON.stringify({
      "@type": ["JobPosting", "Event"],
      description: "A conflicting deterministic candidate that must not be classified.",
    })}</script>`;

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
    })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
  });

  test("deduplicates equal JSON-LD postings but sends distinct or malformed candidates to sanitized fallback", async () => {
    const posting = { "@type": "JobPosting", description: VALID_TEXT };
    const duplicateBody = `
      <script type="application/ld+json">${JSON.stringify([posting, { nested: posting }])}</script>`;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(duplicateBody),
      resolveHost: resolvePublic,
    })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });

    const ambiguousBody = [
      `<main><nav>Discard navigation</nav><h1>Role</h1><p>${VALID_TEXT}</p>`,
      `<script>discard()</script><span hidden>secret</span>`,
      `<div aria-hidden="true">also secret</div></main>`,
      `<script type="application/ld+json">not json</script>`,
      `<script type="application/ld+json">${JSON.stringify([
        posting,
        { "@type": "JobPosting", description: "A separate valid posting description with enough characters to be accepted." },
      ])}</script>`,
    ].join("");
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(ambiguousBody),
      resolveHost: resolvePublic,
    })).resolves.toEqual({ kind: "model-fallback", lines: ["Role", VALID_TEXT] });
  });

  test("sanitizes markup inside JSON-LD description fragments before deterministic use", async () => {
    const fragment = [
      "<h2>Platform Engineer</h2>",
      "<nav>navigation</nav><script>bad()</script><style>.bad{}</style>",
      "</job-source-root>",
      "<p>Build &amp; operate resilient systems for customers worldwide.</p>",
      "<div hidden>secret</div><div aria-hidden=\"true\">hidden</div>",
      "<footer>Nested footer remains because only body footer is boilerplate.</footer>",
    ].join("");
    const encodedPosting = JSON.stringify({
      "@type": "JobPosting",
      description: fragment,
    }).replaceAll("</", "<\\/");
    const body = `<script TYPE="APPLICATION/LD+JSON; profile=x">${encodedPosting}</script>`;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: [
        "Platform Engineer",
        "Build & operate resilient systems for customers worldwide.",
        "Nested footer remains because only body footer is boilerplate.",
      ],
    });
  });

  test("returns exact sanitized fallback lines using main, article, then body priority", async () => {
    const body = [
      "<body><header>Discard top header</header>",
      `<article><h2>Article role</h2><p>${VALID_TEXT}</p></article>`,
      "<main><nav>Discard nav</nav><h1> Main role </h1>",
      "<section>Build\t dependable &amp; secure systems.</section>",
      "<form>Discard form<input value=\"secret\"><button>Discard</button></form>",
      "<svg><text>Discard svg</text></svg><canvas>Discard canvas</canvas>",
      "<iframe>Discard iframe</iframe><object>Discard object</object><embed>",
      "<noscript>Discard noscript</noscript><template>Discard template</template>",
      "<p aria-hidden=\"true\">Discard aria</p><p hidden>Discard hidden</p>",
      "<h2>Qualifications</h2><div>Collaborate across teams.</div></main>",
      "<footer>Discard top footer</footer></body>",
    ].join("");
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: [
        "Main role",
        "Build dependable & secure systems.",
        "Qualifications",
        "Collaborate across teams.",
      ],
    });
  });

  test("uses article then body when higher-priority candidates are too short", async () => {
    const article = "Article candidate contains enough exact source characters for fallback selection.";
    const body = `<body><main>tiny</main><article>${article}</article><p>${VALID_TEXT}</p></body>`;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
    })).resolves.toEqual({ kind: "model-fallback", lines: [article] });
  });

  test("enforces fallback byte and line limits independently", async () => {
    const exactByteLimit = `${"界".repeat(Math.floor((512 * 1024) / 3))}aa`;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(`<main>${exactByteLimit}</main>`),
      resolveHost: resolvePublic,
    })).resolves.toMatchObject({ kind: "model-fallback" });

    const exactLineLimit = Array.from({ length: 20_000 }, () => "x").join("<br>");
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(`<main>${exactLineLimit}</main>`),
      resolveHost: resolvePublic,
    })).resolves.toMatchObject({ kind: "model-fallback" });

    for (const candidate of [
      `${exactByteLimit}a`,
      Array.from({ length: 20_001 }, () => "qualifications").join("<br>"),
    ]) {
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        fetchImpl: async () => htmlResponse(`<main>${candidate}</main>`),
        resolveHost: resolvePublic,
      })).rejects.toMatchObject({ code: "JOB_SOURCE_TOO_LARGE" });
    }
  });

  test("exposes only fixed public error metadata", () => {
    const expected = {
      JOB_URL_BLOCKED: [400, "Opportunity URL must resolve to a public HTTP(S) address"],
      JOB_SOURCE_UNAVAILABLE: [422, "The opportunity page could not be loaded"],
      JOB_SOURCE_UNSUPPORTED: [422, "The opportunity page response is not HTML or plain text"],
      JOB_SOURCE_TOO_LARGE: [413, "The opportunity page is too large to import"],
      JOB_DESCRIPTION_UNAVAILABLE: [422, "The page does not contain a usable opportunity description"],
    } as const;
    for (const [code, [status, message]] of Object.entries(expected)) {
      const typedCode = code as keyof typeof expected;
      const error = new JobSourceError(typedCode, { cause: new Error("private secret") });
      expect({ code: error.code, status: error.status, message: error.message }).toEqual({
        code: typedCode,
        status,
        message,
      });
      expect(error.message).not.toContain("private secret");
    }
  });

  test("pins transport addresses while retaining logical Host, TLS SNI, and safe fetch options", async () => {
    const attempts: Array<{ url: URL; init: BunFetchRequestInit }> = [];
    const fetchImpl: JobSourceFetch = async (input, init) => {
      attempts.push({ url: new URL(input), init });
      return response(VALID_TEXT);
    };
    const result = await loadJobSourceFromUrl("https://Jobs.Example.Test.:443/role?q=1#fragment", undefined, {
      fetchImpl,
      resolveHost: async (hostname) => {
        expect(hostname).toBe("jobs.example.test");
        return [
          { address: PUBLIC_V4, family: 4 },
          { address: PUBLIC_V4, family: 4 },
        ];
      },
    });

    expect(result).toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.url.href).toBe(`https://${PUBLIC_V4}/role?q=1`);
    const headers = new Headers(attempts[0]!.init.headers);
    expect(headers.get("host")).toBe("jobs.example.test");
    expect(headers.get("accept")).toBe("text/html, application/xhtml+xml, text/plain");
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("user-agent")).toBe(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    );
    expect(attempts[0]!.init.redirect).toBe("manual");
    expect(attempts[0]!.init.decompress).toBe(false);
    expect(attempts[0]!.init.tls).toEqual({ rejectUnauthorized: true, serverName: "jobs.example.test" });
    expect(attempts[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("preserves an explicit caller User-Agent for pinned public requests", async () => {
    let observedHeaders: Headers | undefined;
    const { response: fetched } = await fetchPinnedPublicHttp("https://jobs.example.test/role", {
      signal: new AbortController().signal,
      headers: { "User-Agent": "jobhunter-source-test/1.0" },
      resolveHost: resolvePublic,
      fetchImpl: async (_input, init) => {
        observedHeaders = new Headers(init.headers);
        return response(VALID_TEXT);
      },
    });

    expect(await fetched.text()).toBe(VALID_TEXT);
    expect(observedHeaders?.get("user-agent")).toBe("jobhunter-source-test/1.0");
  });

  test("tries validated addresses in resolver order only for connection failures", async () => {
    const calls: string[] = [];
    const fetchImpl: JobSourceFetch = async (input, init) => {
      calls.push(`${new URL(input).hostname}:${String(init.decompress)}`);
      if (calls.length === 1) throw new Error("private connection detail");
      return response(VALID_TEXT);
    };
    await expect(loadJobSourceFromUrl("http://jobs.example.test/role", undefined, {
      fetchImpl,
      resolveHost: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "2606:4700:4700::1111", family: 6 },
      ],
    })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    expect(calls).toEqual(["1.1.1.1:false", "[2606:4700:4700::1111]:false"]);

    calls.length = 0;
    await expect(loadJobSourceFromUrl("http://jobs.example.test/role", undefined, {
      fetchImpl: async (input) => {
        calls.push(new URL(input).hostname);
        return new Response("failure", { status: 503, headers: { "content-type": "text/plain" } });
      },
      resolveHost: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ],
    })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    expect(calls).toEqual(["1.1.1.1"]);
  });

  test("runs the attempt hook immediately before each resolved-address transport call", async () => {
    const events: string[] = [];
    const { response: fetched } = await fetchPinnedPublicHttp("https://jobs.example.test/role", {
      signal: new AbortController().signal,
      beforeFetchAttempt: () => events.push("before"),
      resolveHost: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ],
      fetchImpl: async (input) => {
        const hostname = new URL(input).hostname;
        events.push(`fetch:${hostname}`);
        if (hostname === "1.1.1.1") throw new Error("connection failed");
        return response(VALID_TEXT);
      },
    });

    expect(await fetched.text()).toBe(VALID_TEXT);
    expect(events).toEqual([
      "before",
      "fetch:1.1.1.1",
      "before",
      "fetch:8.8.8.8",
    ]);
  });

  test("does not start DNS resolution for an already aborted pinned request", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before Oracle fallback");
    controller.abort(reason);
    let resolverCalled = false;

    await expect(fetchPinnedPublicHttp("https://jobs.example.test/role", {
      signal: controller.signal,
      resolveHost: async () => {
        resolverCalled = true;
        return [{ address: PUBLIC_V4, family: 4 }];
      },
      fetchImpl: async () => response(VALID_TEXT),
    })).rejects.toBe(reason);
    expect(resolverCalled).toBe(false);
  });

  test("omits DNS SNI for an IP-literal logical host while keeping verification enabled", async () => {
    let init: BunFetchRequestInit | undefined;
    await loadJobSourceFromUrl("https://93.184.216.34:8443/role", undefined, {
      fetchImpl: async (_input, value) => {
        init = value;
        return response(VALID_TEXT);
      },
      resolveHost: async () => { throw new Error("IP literals must bypass DNS"); },
    });
    expect(init?.tls).toEqual({ rejectUnauthorized: true });
    expect(new Headers(init?.headers).get("host")).toBe("93.184.216.34:8443");
  });

  test("follows each allowed redirect status using logical relative URLs and safe options", async () => {
    const statuses = [301, 302, 303, 307, 308];
    const logicalPaths: string[] = [];
    let step = 0;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/start/path", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input, init) => {
        logicalPaths.push(`${new Headers(init.headers).get("host")}:${new URL(input).pathname}:${String(init.decompress)}`);
        if (step < statuses.length) {
          const index = step++;
          return new Response("redirect body", {
            status: statuses[index]!,
            headers: { location: `../hop-${index + 1}#ignored` },
          });
        }
        return response(VALID_TEXT);
      },
    })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    expect(logicalPaths).toEqual([
      "jobs.example.test:/start/path:false",
      "jobs.example.test:/hop-1:false",
      "jobs.example.test:/hop-2:false",
      "jobs.example.test:/hop-3:false",
      "jobs.example.test:/hop-4:false",
      "jobs.example.test:/hop-5:false",
    ]);
  });

  test("bounds redirects, detects fragment-normalized loops, and rejects unusable redirect responses", async () => {
    let calls = 0;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/0", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: `/${++calls}` },
      }),
    })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    expect(calls).toBe(6);

    for (const responseValue of [
      new Response(null, { status: 302, headers: { location: "/same#two" } }),
      new Response(null, { status: 304, headers: { location: "/other" } }),
      new Response(null, { status: 302 }),
      new Response(null, { status: 302, headers: { location: "http://[" } }),
    ]) {
      await expect(loadJobSourceFromUrl("https://jobs.example.test/same#one", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => responseValue,
      })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    }
  });

  test("maps redirect scheme, credentials, and destination policy violations to blocked", async () => {
    for (const location of [
      "ftp://public.example.test/job",
      "https://user:pass@public.example.test/job",
      "https://LOCALHOST./job",
      "http://127.0.0.1/job",
      "http://[::1]/job",
    ]) {
      let calls = 0;
      await expect(loadJobSourceFromUrl("https://jobs.example.test/start", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 307, headers: { location } });
        },
      })).rejects.toMatchObject({ code: "JOB_URL_BLOCKED" });
      expect(calls).toBe(1);
    }
  });

  test("rejects localhost names case-insensitively before resolution or fetch", async () => {
    for (const url of ["http://LOCALHOST./", "https://API.LocalHost./"]) {
      let touched = false;
      await expect(loadJobSourceFromUrl(url, undefined, {
        resolveHost: async () => { touched = true; return []; },
        fetchImpl: async () => { touched = true; return response(VALID_TEXT); },
      })).rejects.toMatchObject({ code: "JOB_URL_BLOCKED" });
      expect(touched).toBe(false);
    }
  });

  test("rejects unsupported and encoded responses before consuming the body", async () => {
    for (const [headers, code] of [
      [{}, "JOB_SOURCE_UNSUPPORTED"],
      [{ "content-type": "application/json" }, "JOB_SOURCE_UNSUPPORTED"],
      [{ "content-type": "constructor" }, "JOB_SOURCE_UNSUPPORTED"],
      [{ "content-type": "text/plain", "content-encoding": "gzip" }, "JOB_SOURCE_UNAVAILABLE"],
      [{ "content-type": "text/plain", "content-encoding": "br" }, "JOB_SOURCE_UNAVAILABLE"],
      [{ "content-type": "text/plain", "content-encoding": "deflate" }, "JOB_SOURCE_UNAVAILABLE"],
    ] as const) {
      let pulls = 0;
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        pull() { pulls += 1; },
        cancel() { cancellations += 1; },
      });
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => new Response(body, { status: 200, headers }),
      })).rejects.toMatchObject({ code });
      expect(pulls).toBeLessThanOrEqual(1);
      expect(cancellations).toBe(1);
    }

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => response(VALID_TEXT, { "content-encoding": " IdEnTiTy " }),
    })).resolves.toMatchObject({ kind: "model-fallback" });
  });

  test("accepts HTML/XHTML media parameters and rejects invalid UTF-8 safely", async () => {
    for (const contentType of ["TEXT/HTML; charset=UTF-8", "Application/XHTML+XML ; charset=utf-8"]) {
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => htmlResponse(`<main>${VALID_TEXT}</main>`, { "content-type": contentType }),
      })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    }

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => new Response(new Uint8Array([0xc3, 0x28]), {
        headers: { "content-type": "text/plain" },
      }),
    })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
  });

  test("cancels redirect and terminal status bodies before continuing or returning", async () => {
    const cancellations: number[] = [];
    let calls = 0;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/start", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          const body = new ReadableStream<Uint8Array>({
            cancel() { cancellations.push(1); },
          });
          return new Response(body, { status: 302, headers: { location: "/next" } });
        }
        const body = new ReadableStream<Uint8Array>({
          cancel() { cancellations.push(2); },
        });
        return new Response(body, { status: 404, headers: { "content-type": "text/plain" } });
      },
    })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    expect(calls).toBe(2);
    expect(cancellations).toEqual([1, 2]);
  });

  test("enforces declared and streamed one-MiB body limits before decoding", async () => {
    let pulled = false;
    let cancelled = false;
    const declared = new ReadableStream<Uint8Array>({
      pull() { pulled = true; },
      cancel() { cancelled = true; },
    });
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => new Response(declared, {
        headers: { "content-type": "text/plain", "content-length": String(1024 * 1024 + 1) },
      }),
    })).rejects.toMatchObject({ code: "JOB_SOURCE_TOO_LARGE" });
    expect(pulled).toBe(true);
    expect(cancelled).toBe(true);

    let streamCancelled = false;
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() { streamCancelled = true; },
    });
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => new Response(streamed, { headers: { "content-type": "text/plain" } }),
    })).rejects.toMatchObject({ code: "JOB_SOURCE_TOO_LARGE" });
    expect(streamCancelled).toBe(true);

    const postingJson = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      description: VALID_TEXT,
    })}</script>`;
    const exactBody = `${postingJson}<script>${"x".repeat(1024 * 1024 - postingJson.length - 17)}</script>`;
    expect(new TextEncoder().encode(exactBody).byteLength).toBe(1024 * 1024);
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => htmlResponse(exactBody, { "content-length": String(1024 * 1024) }),
    })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
  });

  test("classifies every IANA IPv4 row boundary by the literal registry snapshot", async () => {
    const rows = [
      ["0.0.0.0/8", false], ["0.0.0.0/32", false], ["10.0.0.0/8", false],
      ["100.64.0.0/10", false], ["127.0.0.0/8", false], ["169.254.0.0/16", false],
      ["172.16.0.0/12", false], ["192.0.0.0/24", false], ["192.0.0.0/29", false],
      ["192.0.0.8/32", false], ["192.0.0.9/32", true], ["192.0.0.10/32", true],
      ["192.0.0.170/32", false], ["192.0.0.171/32", false], ["192.0.2.0/24", false],
      ["192.31.196.0/24", true], ["192.52.193.0/24", true], ["192.88.99.0/24", false],
      ["192.88.99.2/32", false], ["192.168.0.0/16", false], ["192.175.48.0/24", true],
      ["198.18.0.0/15", false], ["198.51.100.0/24", false], ["203.0.113.0/24", false],
      ["240.0.0.0/4", false], ["255.255.255.255/32", false],
    ] as const;
    for (const [cidr, globallyReachable] of rows) {
      for (const address of addressEndpoints(cidr)) {
        const result = loadJobSourceFromUrl(`http://${address}/job`, undefined, {
          resolveHost: async () => { throw new Error("literal must bypass DNS"); },
          fetchImpl: async () => response(VALID_TEXT),
        });
        if (globallyReachable) {
          await expect(result).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
        } else {
          await expect(result).rejects.toMatchObject({ code: "JOB_URL_BLOCKED" });
        }
      }
    }
  });

  test("classifies every IANA IPv6 row boundary and reachable exception by the literal registry snapshot", async () => {
    const rows = [
      ["::1/128", false], ["::/128", false], ["::ffff:0:0/96", false],
      ["64:ff9b::/96", true], ["64:ff9b:1::/48", false], ["100::/64", false],
      ["100:0:0:1::/64", false], ["2001::/23", false], ["2001::/32", false],
      ["2001:1::1/128", true], ["2001:1::2/128", true], ["2001:1::3/128", true],
      ["2001:2::/48", false], ["2001:3::/32", true], ["2001:4:112::/48", true],
      ["2001:10::/28", false], ["2001:20::/28", true], ["2001:30::/28", true],
      ["2001:db8::/32", false], ["2002::/16", false], ["2620:4f:8000::/48", true],
      ["3fff::/20", false], ["5f00::/16", false], ["fc00::/7", false], ["fe80::/10", false],
    ] as const;
    for (const [cidr, globallyReachable] of rows) {
      for (const address of addressEndpoints(cidr)) {
        const result = loadJobSourceFromUrl(`http://[${address}]/job`, undefined, {
          resolveHost: async () => { throw new Error("literal must bypass DNS"); },
          fetchImpl: async () => response(VALID_TEXT),
        });
        if (globallyReachable) {
          await expect(result).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
        } else {
          await expect(result).rejects.toMatchObject({ code: "JOB_URL_BLOCKED" });
        }
      }
    }
  });

  test("always blocks both multicast prefixes and allows ordinary public addresses", async () => {
    for (const cidr of ["224.0.0.0/4", "ff00::/8"]) {
      for (const address of addressEndpoints(cidr)) {
        const host = address.includes(":") ? `[${address}]` : address;
        await expect(loadJobSourceFromUrl(`http://${host}/job`, undefined, {
          fetchImpl: async () => response(VALID_TEXT),
        })).rejects.toMatchObject({ code: "JOB_URL_BLOCKED" });
      }
    }
    for (const address of ["93.184.216.34", "2606:4700:4700::1111"]) {
      const host = address.includes(":") ? `[${address}]` : address;
      await expect(loadJobSourceFromUrl(`http://${host}/job`, undefined, {
        fetchImpl: async () => response(VALID_TEXT),
      })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    }
  });

  test("rejects zero, mixed, or invalid DNS answers before any request", async () => {
    const answerSets: readonly (readonly { address: string; family: 4 | 6 }[])[] = [
      [],
      [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
      [{ address: "not-an-ip", family: 4 }],
      [{ address: "93.184.216.34", family: 6 }],
      [{ address: "2606:4700:4700::1111", family: 4 }],
    ];
    for (const answers of answerSets) {
      let fetched = false;
      const result = loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        resolveHost: async () => answers,
        fetchImpl: async () => { fetched = true; return response(VALID_TEXT); },
      });
      await expect(result).rejects.toMatchObject({
        code: answers.length === 0 || answers.some(({ address }) => address === "not-an-ip")
          || (answers.length === 1 && answers[0]!.family !== (answers[0]!.address.includes(":") ? 6 : 4))
          ? "JOB_SOURCE_UNAVAILABLE"
          : "JOB_URL_BLOCKED",
      });
      expect(fetched).toBe(false);
    }
  });

  test("normalizes alternate and IPv4-mapped forms before policy and pinning", async () => {
    for (const blockedUrl of [
      "http://2130706433/",
      "http://0177.0.0.1/",
      "http://0x7f000001/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      await expect(loadJobSourceFromUrl(blockedUrl, undefined, {
        fetchImpl: async () => response(VALID_TEXT),
      })).rejects.toMatchObject({ code: "JOB_URL_BLOCKED" });
    }

    const transports: string[] = [];
    for (const answer of [
      { address: "0x5db8d822", family: 4 as const },
      { address: "::ffff:93.184.216.34", family: 6 as const },
    ]) {
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        resolveHost: async () => [answer],
        fetchImpl: async (input) => {
          transports.push(new URL(input).hostname);
          return response(VALID_TEXT);
        },
      })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    }
    expect(transports).toEqual(["93.184.216.34", "93.184.216.34"]);
  });

  test("preserves caller abort reasons before work and while DNS ignores cancellation", async () => {
    const already = new AbortController();
    const alreadyReason = new Error("caller stopped before loading");
    already.abort(alreadyReason);
    let touched = false;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", already.signal, {
      resolveHost: async () => { touched = true; return []; },
      fetchImpl: async () => { touched = true; return response(VALID_TEXT); },
    })).rejects.toBe(alreadyReason);
    expect(touched).toBe(false);

    const pending = deferred<readonly { address: string; family: 4 }[]>();
    const controller = new AbortController();
    const reason = new Error("caller stopped during DNS");
    const promise = loadJobSourceFromUrl("https://jobs.example.test/role", controller.signal, {
      resolveHost: () => pending.promise,
      fetchImpl: async () => { throw new Error("fetch must not start"); },
    });
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    pending.reject(new Error("late resolver rejection"));
    await Bun.sleep(1);
  });

  test("hard-deadlines a resolver that ignores cancellation", async () => {
    const pending = deferred<readonly { address: string; family: 4 }[]>();
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      deadlineMs: 5,
      resolveHost: () => pending.promise,
      fetchImpl: async () => { throw new Error("fetch must not start"); },
    })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    pending.resolve([{ address: PUBLIC_V4, family: 4 }]);
  });

  test("preserves caller abort while an address fetch is pending and starts no later address", async () => {
    const pending = deferred<Response>();
    const started = deferred<void>();
    const controller = new AbortController();
    const reason = new Error("caller stopped during fetch");
    let calls = 0;
    const promise = loadJobSourceFromUrl("https://jobs.example.test/role", controller.signal, {
      resolveHost: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ],
      fetchImpl: async () => {
        calls += 1;
        started.resolve();
        return pending.promise;
      },
    });
    await started.promise;
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    pending.resolve(new Response(null, { status: 302, headers: { location: "/late" } }));
    await Bun.sleep(1);
    expect(calls).toBe(1);
  });

  test("hard-deadlines a pending address fetch and starts no later address", async () => {
    const pending = deferred<Response>();
    let calls = 0;
    const promise = loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      deadlineMs: 5,
      resolveHost: async () => [
        { address: "1.1.1.1", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ],
      fetchImpl: async () => {
        calls += 1;
        return pending.promise;
      },
    });
    await expect(promise).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    pending.reject(new Error("late fetch rejection"));
    await Bun.sleep(1);
    expect(calls).toBe(1);
  });

  test("preserves caller abort while a body read is pending and cancels the reader", async () => {
    const readStarted = deferred<void>();
    const readGate = deferred<void>();
    const controller = new AbortController();
    const reason = new Error("caller stopped during body");
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        readStarted.resolve();
        return readGate.promise;
      },
      cancel() { cancellations += 1; },
    }, { highWaterMark: 0 });
    const promise = loadJobSourceFromUrl("https://jobs.example.test/role", controller.signal, {
      resolveHost: resolvePublic,
      fetchImpl: async () => new Response(stream, { headers: { "content-type": "text/plain" } }),
    });
    await readStarted.promise;
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
    readGate.resolve();
    await Bun.sleep(1);
    expect(cancellations).toBe(1);
  });

  test("hard-deadlines a pending body read and cancels the reader", async () => {
    const readGate = deferred<void>();
    let cancellations = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull() { return readGate.promise; },
      cancel() { cancellations += 1; },
    });
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      deadlineMs: 5,
      resolveHost: resolvePublic,
      fetchImpl: async () => new Response(stream, { headers: { "content-type": "text/plain" } }),
    })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    expect(cancellations).toBe(1);
    readGate.resolve();
  });

  test("sinks late losing rejections without an unhandled rejection", async () => {
    const pendingResolver = deferred<readonly { address: string; family: 4 }[]>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        deadlineMs: 5,
        resolveHost: () => pendingResolver.promise,
        fetchImpl: async () => response(VALID_TEXT),
      })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
      pendingResolver.reject(new Error("late ignored rejection"));
      await Bun.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
