import { describe, expect, test } from "bun:test";
import {
  JobSourceError,
  fetchPinnedPublicHttp,
  loadJobSourceFromUrl,
  type JobSourceFetch,
  type ResolveHost,
  type RenderJobSourceHtml,
} from "../src/api/job-source";
import { RenderJobSourceError } from "../src/api/rendered-job-source";

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
  test("renders an empty public HTTPS 202 page before extracting its description", async () => {
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => new Response("", { status: 202, headers: { "content-type": "text/html" } }),
      renderHtml: async () => ({ html: `<html><body>${VALID_TEXT}</body></html>`, finalUrl: "https://jobs.example.test/role" }),
    })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
  });

  test("loads Phenom lead-page event details without rendering bootstrap code", async () => {
    const title = "Early Talent - 2027 - Technology - Software Engineer Internship";
    const description = "Please submit your information and a recruiter will be in touch with next steps!";
    const ddo = {
      crmEventRegisterForm: {
        eventDetails: {
          eLanguages: [{
            language: "en_US", title, default: true,
            description: `<p><span>${description}</span></p>`,
            teaser: `<p>${description}</p>`,
          }],
        },
      },
    };
    await expect(loadJobSourceFromUrl("https://careers.example.test/leadpage", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => htmlResponse(`<script>var phApp = phApp || {}; phApp.ddo = ${JSON.stringify(ddo)}; throw new Error("must not execute");</script>`),
      renderHtml: async () => { throw new Error("must not render"); },
    })).resolves.toEqual({ kind: "model-fallback", lines: [title, "", description] });
  });

  test("loads a selected Superhuman Ashby job instead of generic careers chrome", async () => {
    const jobId = "e6b917b1-325a-47d0-b267-b279b0efdad0";
    const title = "Software Engineering Intern - Summer 2027";
    const requested: string[] = [];
    const result = await loadJobSourceFromUrl(
      `https://superhuman.com/company/careers/jobs?ashby_jid=${jobId}`,
      undefined,
      {
        resolveHost: resolvePublic,
        fetchImpl: async (input, init) => {
          const url = new URL(input);
          const host = new Headers(init.headers).get("host");
          requested.push(`${host}${url.pathname}${url.search}`);
          if (host === "superhuman.com") {
            return htmlResponse('<nav>Open Roles at Superhuman</nav><div id="ashby_embed"></div>');
          }
          if (host === "jobs.ashbyhq.com") {
            return htmlResponse(`<script type="application/ld+json">${JSON.stringify({
              "@type": "JobPosting",
              title,
              hiringOrganization: { name: "Superhuman" },
              description: "<p>Build delightful products used by professionals every day.</p><p>Collaborate across engineering and product.</p>",
            })}</script>`);
          }
          throw new Error("Unexpected request");
        },
        renderHtml: async () => { throw new Error("must not render"); },
      },
    );
    expect(result).toEqual({
      kind: "model-fallback",
      lines: [
        title,
        "",
        "Superhuman",
        "",
        "Build delightful products used by professionals every day.",
        "Collaborate across engineering and product.",
      ],
    });
    expect(requested).toEqual([
      `superhuman.com/company/careers/jobs?ashby_jid=${jobId}`,
      `jobs.ashbyhq.com/Superhuman%20Platform%20Inc/${jobId}`,
    ]);
  });

  test("discovers page-declared Greenhouse template configuration without a browser", async () => {
    const requested: string[] = [];
    const result = await loadJobSourceFromUrl("https://www.zipline.com/open-roles/7984998003?gh_jid=7984998003", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        requested.push(url.pathname);
        if (url.pathname.startsWith("/open-roles/")) return htmlResponse(`<body>Skip to main content<script src="/first.js"></script><script src="/2-g-6bn79hx4u.js"></script><script src="/2-g-6bn79hx4u.js#duplicate"></script></body>`);
        if (url.pathname === "/first.js") return response('throw new Error("downloaded code must never execute"); import "/not-declared.js";');
        if (url.pathname === "/2-g-6bn79hx4u.js") {
          expect(url.hostname).toBe(PUBLIC_V4);
          expect(new Headers(init.headers).get("host")).toBe("www.zipline.com");
          expect(init.redirect).toBe("manual");
          return response('const embed = `https://boards.greenhouse.io/embed/job_app?for=flyzipline&token=${e}&b=${o}`;');
        }
        if (url.pathname === "/v1/boards/flyzipline/jobs/7984998003") return Response.json({ id: 7984998003, title: "Flight Engineer", content: VALID_TEXT });
        throw new Error("Unexpected request");
      },
      renderHtml: async () => { throw new Error("browser disabled"); },
    });
    expect(result).toEqual({ kind: "model-fallback", lines: ["Flight Engineer", "", VALID_TEXT] });
    expect(requested).toEqual(["/open-roles/7984998003", "/first.js", "/2-g-6bn79hx4u.js", "/v1/boards/flyzipline/jobs/7984998003"]);
  });

  test("loads a Greenhouse board-loader job before generic employer chrome", async () => {
    const requested: string[] = [];
    const result = await loadJobSourceFromUrl("https://www.prizepicks.com/position?gh_jid=7999266003", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input) => {
        const path = new URL(input).pathname;
        requested.push(path);
        if (path === "/position") {
          return htmlResponse(`<body><main>Discover PrizePicks, our products, our team, and open opportunities.</main>
            <script src="http://boards.greenhouse.io/embed/job_board/js?for=insecure"></script>
            <script src="https://user@boards.greenhouse.io/embed/job_board/js?for=credentialed"></script>
            <script src="https://boards.greenhouse.io:444/embed/job_board/js?for=custom-port"></script>
            <script src="https://boards.greenhouse.io.evil.example/embed/job_board/js?for=spoofed"></script>
            <script src="https://boards.greenhouse.io/embed/job_board/js/?for=wrong-path"></script>
            <script src="https://boards.greenhouse.io/embed/job_board/js?for=one&for=two"></script>
            <script src="https://boards.greenhouse.io/embed/job_board/js?for=prizepicks"></script></body>`);
        }
        if (path === "/v1/boards/prizepicks/jobs/7999266003") {
          return Response.json({ id: 7999266003, title: "Senior Software Engineer", content: VALID_TEXT });
        }
        throw new Error("Unexpected request");
      },
      renderHtml: async () => { throw new Error("must not render"); },
    });
    expect(result).toEqual({ kind: "model-fallback", lines: ["Senior Software Engineer", "", VALID_TEXT] });
    expect(requested).toEqual(["/position", "/v1/boards/prizepicks/jobs/7999266003"]);
  });

  test("reads inline literal Greenhouse configuration and ignores foreign script origins", async () => {
    const requested: string[] = [];
    await expect(loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input) => {
        const path = new URL(input).pathname;
        requested.push(path);
        if (path === "/job") return htmlResponse(`<script>const embed = "https://boards.greenhouse.io/embed/job_app?for=example&token=42";</script>
          <script src="https://foreign.example/config.js"></script><script src="https://employer.example:444/config.js"></script>
          <script src="http://employer.example/config.js"></script><script src="https://user@employer.example/config.js"></script>`);
        return Response.json({ id: 42, title: "Engineer", content: VALID_TEXT });
      },
      renderHtml: async () => { throw new Error("browser disabled"); },
    }, "job")).resolves.toEqual({ kind: "description", opportunityKind: "job", jobDescription: `Engineer\n\n${VALID_TEXT}` });
    expect(requested).toEqual(["/job", "/v1/boards/example/jobs/42"]);
  });

  test("keeps usable generic static descriptions ahead of script discovery", async () => {
    let fetches = 0;
    const result = await loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => { fetches += 1; return htmlResponse(`<body>${VALID_TEXT}<script src="/config.js"></script></body>`); },
      renderHtml: async () => { throw new Error("browser disabled"); },
    });
    expect(result).toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
    expect(fetches).toBe(1);
  });

  test("discovers a dynamic Greenhouse bundle instead of importing generic chrome", async () => {
    const result = await loadJobSourceFromUrl("https://employer.example/career?gh_jid=8204134", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input) => {
        const path = new URL(input).pathname;
        if (path === "/career") {
          return htmlResponse(`<body>
            <section>Learn about our company, locations, services, values, and open opportunities across our global offices.</section>
            <div job-region>Location</div><h1 job-title>Heading</h1><div job-content></div><div job-form></div>
            <script src="/site.js"></script>
            <script>tag.src = "https://tags.example/gtm.js?id=" + tagId;</script>
            <script>addScript("https://assets.example/career.js");</script>
          </body>`);
        }
        if (path === "/site.js") {
          return response("ignored", { "content-length": String(256 * 1024 + 1) });
        }
        if (path === "/gtm.js") return new Response(null, { status: 400 });
        if (path === "/career.js") {
          return response('const embed = `https://boards.greenhouse.io/embed/job_app?for=keystone&token=${jobId}`;');
        }
        if (path === "/v1/boards/keystone/jobs/8204134") {
          return Response.json({ id: 8204134, title: "Software Engineer", content: `&lt;p&gt;${VALID_TEXT}&lt;/p&gt;` });
        }
        throw new Error("Unexpected request");
      },
      renderHtml: async () => { throw new Error("browser disabled"); },
    });
    expect(result).toEqual({ kind: "model-fallback", lines: ["Software Engineer", "", VALID_TEXT] });
  });

  test("requires a single numeric job hint before downloading scripts", async () => {
    for (const query of ["", "?gh_jid=42&gh_jid=42", "?gh_jid=not-a-job"]) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl(`https://employer.example/job${query}`, undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => { fetches += 1; return htmlResponse('<script src="/config.js"></script>'); },
        renderHtml: async () => { throw new Error("browser disabled"); },
      })).rejects.toMatchObject({ code: "JOB_SOURCE_RENDER_UNAVAILABLE" });
      expect(fetches).toBe(1);
    }
  });

  test("rejects script redirects without requesting their destination or loading an earlier candidate", async () => {
    const requested: string[] = [];
    let cancelled = false;
    await expect(loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input) => {
        const path = new URL(input).pathname;
        requested.push(path);
        if (path === "/job") return htmlResponse('<script>const embed = "https://boards.greenhouse.io/embed/job_app?for=example&token=42";</script><script src="/config.js"></script>');
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
          status: 302, headers: { location: "https://employer.example/redirected.js" },
        });
      },
      renderHtml: async () => { throw new Error("browser disabled"); },
    })).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
    expect(requested).toEqual(["/job", "/config.js"]);
    expect(cancelled).toBe(true);
  });

  test("rejects conflicting boards across scripts and literal job IDs instead of using the first candidate", async () => {
    for (const conflict of ["for=other&token=42", "for=example&token=43"]) {
      const requested: string[] = [];
      await expect(loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async (input) => {
          const path = new URL(input).pathname;
          requested.push(path);
          if (path === "/job") return htmlResponse('<script>const embed = "https://boards.greenhouse.io/embed/job_app?for=example&token=42";</script><script src="/last.js"></script>');
          return response(`const other = "https://boards.greenhouse.io/embed/job_app?${conflict}";`);
        },
        renderHtml: async () => { throw new Error("browser disabled"); },
      })).rejects.toMatchObject({ code: "JOB_DESCRIPTION_UNAVAILABLE" });
      expect(requested).toEqual(["/job", "/last.js"]);
    }
  });

  test("does not infer a job token from executable template expressions", async () => {
    let fetches = 0;
    await expect(loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => {
        fetches += 1;
        return htmlResponse('<script>const embed = `https://boards.greenhouse.io/embed/job_app?for=example&token=${job.id}`;</script>');
      },
      renderHtml: async () => { throw new Error("browser disabled"); },
    })).rejects.toMatchObject({ code: "JOB_SOURCE_RENDER_UNAVAILABLE" });
    expect(fetches).toBe(1);
  });

  test("accepts all 24 bounded scripts but rejects a page exceeding that cap without sampling", async () => {
    for (const count of [24, 25]) {
      let fetchedScripts = 0;
      const loading = loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async (input) => {
          const path = new URL(input).pathname;
          if (path === "/job") return htmlResponse(Array.from({ length: count }, (_, i) => `<script src="/${i}.js"></script>`).join(""));
          if (path.startsWith("/v1/")) return Response.json({ id: 42, title: "Engineer", content: VALID_TEXT });
          fetchedScripts += 1;
          return response('const embed = `https://boards.greenhouse.io/embed/job_app?for=example&token=${jobId}`;'.padEnd(256 * 1024, " "));
        },
        renderHtml: async () => { throw new Error("browser disabled"); },
      });
      if (count === 24) {
        await expect(loading).resolves.toEqual({ kind: "model-fallback", lines: ["Engineer", "", VALID_TEXT] });
        expect(fetchedScripts).toBe(24);
      } else {
        await expect(loading).rejects.toMatchObject({ code: "JOB_SOURCE_TOO_LARGE" });
        expect(fetchedScripts).toBe(0);
      }
    }
  });

  test("enforces both declared and streamed script body limits and cancels rejected bodies", async () => {
    for (const declared of [true, false]) {
      let cancelled = false;
      let fetches = 0;
      await expect(loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => {
          if (++fetches === 1) return htmlResponse('<script src="/config.js"></script>');
          return new Response(new ReadableStream({
            pull(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); },
            cancel() { cancelled = true; },
          }), { headers: declared ? { "content-length": String(256 * 1024 + 1) } : {} });
        },
        renderHtml: async () => { throw new Error("browser disabled"); },
      })).rejects.toMatchObject({ code: "JOB_SOURCE_TOO_LARGE" });
      expect(cancelled).toBe(true);
      expect(fetches).toBe(2);
    }
  });

  test("revalidates same-origin script DNS before fetching against a private rebound", async () => {
    let resolutions = 0;
    let fetches = 0;
    await expect(loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
      resolveHost: async () => [{ address: ++resolutions === 1 ? PUBLIC_V4 : "127.0.0.1", family: 4 }],
      fetchImpl: async () => { fetches += 1; return htmlResponse('<script src="/config.js"></script>'); },
      renderHtml: async () => { throw new Error("browser disabled"); },
    })).rejects.toMatchObject({ code: "JOB_URL_BLOCKED" });
    expect(fetches).toBe(1);
  });

  test("preserves caller cancellation and the shared deadline during a stalled script body", async () => {
    for (const callerAbort of [true, false]) {
      const controller = new AbortController();
      const reason = new Error("cancelled by caller");
      let cancelled = false;
      let fetches = 0;
      const loading = loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", controller.signal, {
        deadlineMs: callerAbort ? 1000 : 20,
        resolveHost: resolvePublic,
        fetchImpl: async () => {
          if (++fetches === 1) return htmlResponse('<script src="/config.js"></script>');
          if (callerAbort) queueMicrotask(() => controller.abort(reason));
          return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
        },
        renderHtml: async () => { throw new Error("browser disabled"); },
      });
      if (callerAbort) await expect(loading).rejects.toBe(reason);
      else await expect(loading).rejects.toMatchObject({ code: "JOB_SOURCE_UNAVAILABLE" });
      expect(cancelled).toBe(true);
      expect(fetches).toBe(2);
    }
  });

  test("rejects duplicate embed identity parameters even beside an otherwise valid candidate", async () => {
    let fetches = 0;
    await expect(loadJobSourceFromUrl("https://employer.example/job?gh_jid=42", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => {
        fetches += 1;
        return htmlResponse('<script>const one = "https://boards.greenhouse.io/embed/job_app?for=example&token=42"; const two = "https://boards.greenhouse.io/embed/job_app?for=example&for=other&token=42";</script>');
      },
      renderHtml: async () => { throw new Error("browser disabled"); },
    })).rejects.toMatchObject({ code: "JOB_DESCRIPTION_UNAVAILABLE" });
    expect(fetches).toBe(1);
  });
  test("loads a specific Greenhouse iframe before employer page chrome in Auto-detect", async () => {
    const attempts: Array<{ url: URL; init: BunFetchRequestInit }> = [];
    const result = await loadJobSourceFromUrl("https://employer.example/jobs/42?gh_jid=42", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        attempts.push({ url, init });
        if (attempts.length === 1) return htmlResponse(`<body><p>Discover our company and learn about our products, services, and exciting opportunities.</p><iframe src="https://boards.greenhouse.io/embed/job_app?for=exampleboard&amp;token=42"></iframe></body>`);
        return Response.json({ id: 42, title: "Systems Engineer", content: `<p>${VALID_TEXT}</p><script>privateScript()</script>` });
      },
      renderHtml: async () => { throw new Error("must not render"); },
    });
    expect(result).toEqual({ kind: "model-fallback", lines: ["Systems Engineer", "", VALID_TEXT] });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.url.hostname).toBe(PUBLIC_V4);
    expect(attempts[1]!.url.pathname).toBe("/v1/boards/exampleboard/jobs/42");
    expect(new Headers(attempts[1]!.init.headers).get("host")).toBe("boards-api.greenhouse.io");
    expect(attempts[1]!.init.redirect).toBe("manual");
  });
  test("loads a rendered Greenhouse iframe before rendered navigation text and preserves an explicit kind", async () => {
    const url = "https://www.zipline.com/open-roles/7984998003?gh_jid=7984998003";
    let renders = 0;
    await expect(loadJobSourceFromUrl(url, undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input) => new URL(input).pathname.startsWith("/v1/boards/")
        ? Response.json({ id: 7984998003, title: "Flight Engineer", content: VALID_TEXT })
        : htmlResponse("<body><div id=greenhouse></div></body>"),
      renderHtml: async (renderUrl) => {
        expect(renderUrl).toBe(url);
        renders += 1;
        return { html: `<body><nav>Learn about our mission, our products, our team and our locations around the world.</nav><iframe src="https://job-boards.greenhouse.io/embed/job_app?for=flyzipline&amp;token=7984998003&amp;b=tracking"></iframe></body>`, finalUrl: null };
      },
    }, "job")).resolves.toEqual({ kind: "description", opportunityKind: "job", jobDescription: `Flight Engineer\n\n${VALID_TEXT}` });
    expect(renders).toBe(1);
  });

  test("loads ICIMS iframe content before generic careers shell text", async () => {
    const jobUrl = "https://careers-example.icims.com/jobs/12345/software-engineer-intern/job?iis=Website";
    const requests: string[] = [];
    const result = await loadJobSourceFromUrl(jobUrl, undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async (input, init) => {
        const url = new URL(input);
        requests.push(`${url.pathname}${url.search}`);
        expect(new Headers(init.headers).get("host")).toBe("careers-example.icims.com");
        if (url.searchParams.get("in_iframe") !== "1") {
          return htmlResponse(`<body><main>Explore our teams, values, locations, and career opportunities around the world.</main>
            <script>var icimsFrame = document.createElement("iframe"); icimsFrame.src = "https:\\/\\/careers-example.icims.com\\/jobs\\/12345\\/software-engineer-intern\\/job?iis=Website&in_iframe=1";</script></body>`);
        }
        return htmlResponse(`<body><h1>Software Engineer Intern</h1><h2>Responsibilities</h2><p>${VALID_TEXT}</p>
          <h2>Qualifications</h2><p>Enrolled in a computer science degree program.</p></body>`);
      },
      renderHtml: async () => { throw new Error("must not render"); },
    });
    expect(result).toEqual({ kind: "model-fallback", lines: [
      "Software Engineer Intern",
      "Responsibilities",
      VALID_TEXT,
      "",
      "Qualifications",
      "Enrolled in a computer science degree program.",
    ] });
    expect(requests).toEqual([
      "/jobs/12345/software-engineer-intern/job?iis=Website",
      "/jobs/12345/software-engineer-intern/job?iis=Website&in_iframe=1",
    ]);
  });

  test("preserves an explicit kind for direct ICIMS iframe content", async () => {
    let fetches = 0;
    const jobDescription = `Community Engineering Meetup\n${VALID_TEXT}`;
    await expect(loadJobSourceFromUrl(
      "https://careers-example.icims.com/jobs/12345/community-engineering-meetup/job?in_iframe=1",
      undefined,
      {
        resolveHost: resolvePublic,
        fetchImpl: async () => {
          fetches += 1;
          return htmlResponse(`<body><h1>Community Engineering Meetup</h1><p>${VALID_TEXT}</p></body>`);
        },
        renderHtml: async () => { throw new Error("must not render"); },
      },
      "event",
    )).resolves.toEqual({ kind: "description", opportunityKind: "event", jobDescription });
    expect(fetches).toBe(1);
  });

  test("surfaces human verification from ICIMS iframe content", async () => {
    let fetches = 0;
    await expect(loadJobSourceFromUrl(
      "https://careers-example.icims.com/jobs/12345/software-engineer/job",
      undefined,
      {
        resolveHost: resolvePublic,
        fetchImpl: async () => {
          fetches += 1;
          if (fetches === 1) return htmlResponse("<body>" + VALID_TEXT + "</body>");
          return htmlResponse("<body><h1>Quick Check Needed</h1><p>We just need to confirm you're a real person. Please check the box below.</p></body>");
        },
        renderHtml: async () => { throw new Error("must not render"); },
      },
    )).rejects.toMatchObject({ code: "JOB_HUMAN_VERIFICATION_REQUIRED", status: 409 });
    expect(fetches).toBe(2);
  });

  test("surfaces human verification from an outer ICIMS page", async () => {
    let fetches = 0;
    await expect(loadJobSourceFromUrl(
      "https://careers-example.icims.com/jobs/12345/software-engineer/job",
      undefined,
      {
        resolveHost: resolvePublic,
        fetchImpl: async () => {
          fetches += 1;
          if (fetches === 1) {
            return htmlResponse("<body><h1>Quick Check Needed</h1><p>We just need to confirm you're a real person. Please check the box below.</p></body>");
          }
          return htmlResponse("<body>" + VALID_TEXT + "</body>");
        },
        renderHtml: async () => { throw new Error("must not render"); },
      },
    )).rejects.toMatchObject({ code: "JOB_HUMAN_VERIFICATION_REQUIRED", status: 409 });
    expect(fetches).toBe(1);
  });

  test("loads Workable structured title, description, requirements and benefits without a browser", async () => {
    const fetchImpl: JobSourceFetch = async (input, init) => {
      const url = new URL(input);
      if (!url.pathname.startsWith("/api/")) return htmlResponse("<html><body></body></html>");
      expect(url.pathname).toBe("/api/v2/accounts/twgai/jobs/772CD136FF");
      expect(url.hostname).toBe(PUBLIC_V4);
      expect(new Headers(init.headers).get("host")).toBe("apply.workable.com");
      expect(init.redirect).toBe("manual");
      return Response.json({ shortcode: "772CD136FF", state: "published", title: "AI Engineer",
        description: `<p>${VALID_TEXT}</p>`, requirements: "<p>Experience delivering reliable machine learning systems.</p>",
        benefits: "<p>Flexible working hours and health insurance.</p><script>privateScript()</script>" });
    };
    const options = { fetchImpl, resolveHost: resolvePublic, renderHtml: async () => { throw new Error("must not render"); } };
    const jobDescription = `AI Engineer\n\n${VALID_TEXT}\n\nExperience delivering reliable machine learning systems.\n\nFlexible working hours and health insurance.`;
    await expect(loadJobSourceFromUrl("https://apply.workable.com/twgai/j/772CD136FF/", undefined, options))
      .resolves.toEqual({ kind: "model-fallback", lines: jobDescription.split("\n") });
    await expect(loadJobSourceFromUrl("https://apply.workable.com/twgai/j/772CD136FF/", undefined, options, "job"))
      .resolves.toEqual({ kind: "description", opportunityKind: "job", jobDescription });
  });

  test("rejects provider titles without usable description content", async () => {
    for (const [url, record] of [
      ["https://boards.greenhouse.io/example/jobs/42", { id: 42, title: VALID_TEXT, content: "<script>private()</script>" }],
      ["https://apply.workable.com/example/j/CODE", { shortcode: "CODE", state: "published", title: VALID_TEXT, description: "<script>private()</script>" }],
    ] as const) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl(url, undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => ++fetches === 1 ? htmlResponse("<body></body>") : Response.json(record),
        renderHtml: async () => undefined,
      })).rejects.toMatchObject({ code: "JOB_DESCRIPTION_UNAVAILABLE" });
    }
  });

  test("does not follow unrelated or spoofed Greenhouse iframes", async () => {
    for (const iframe of [
      "https://thirdparty.example/jobs/42",
      "https://boards.greenhouse.io.evil.example/embed/job_app?for=example&token=42",
      "https://boards.greenhouse.io:444/embed/job_app?for=example&token=42",
      "https://boards.greenhouse.io/embed/job_app?for=example&token=42&token=43",
      "https://boards.greenhouse.io/embed/job_app?for=example&token=42&gh_jid=43",
      "https://boards.greenhouse.io/embed/job_app?for=../../private&token=42",
    ]) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl("https://employer.example/jobs/42", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => { fetches += 1; return htmlResponse(`<main>${VALID_TEXT}</main><iframe src="${iframe}"></iframe>`); },
      })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
      expect(fetches).toBe(1);
    }
  });

  test("rejects ambiguous Greenhouse embeds and conflicts with the requested job", async () => {
    for (const [url, html] of [
      ["https://employer.example/jobs", `<iframe src="https://boards.greenhouse.io/embed/job_app?for=one&token=42"></iframe><iframe src="https://boards.greenhouse.io/embed/job_app?for=two&token=42"></iframe>`],
      ["https://employer.example/jobs?gh_jid=43", `<iframe src="https://boards.greenhouse.io/embed/job_app?for=one&token=42"></iframe>`],
      ["https://employer.example/jobs?gh_jid=42", `<script src="https://boards.greenhouse.io/embed/job_board/js?for=one"></script><script src="https://boards.greenhouse.io/embed/job_board/js?for=two"></script>`],
    ]) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl(url!, undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => { fetches += 1; return htmlResponse(html!); },
      })).rejects.toMatchObject({ code: "JOB_DESCRIPTION_UNAVAILABLE" });
      expect(fetches).toBe(1);
    }
  });

  test("rejects provider identity mismatches and unpublished Workable records", async () => {
    for (const [url, record] of [
      ["https://boards.greenhouse.io/example/jobs/42", { id: 43, content: VALID_TEXT }],
      ["https://apply.workable.com/example/j/CODE", { shortcode: "OTHER", state: "published", title: "Engineer", description: VALID_TEXT }],
      ["https://apply.workable.com/example/j/CODE", { shortcode: "CODE", state: "draft", title: "Engineer", description: VALID_TEXT }],
    ] as const) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl(url, undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => ++fetches === 1 ? htmlResponse("<body></body>") : Response.json(record),
      })).rejects.toMatchObject({ code: "JOB_DESCRIPTION_UNAVAILABLE" });
    }
  });

  test("uses the Workable adapter only for its exact HTTPS account job route", async () => {
    for (const url of [
      "https://apply.workable.com.evil.example/example/j/CODE",
      "http://apply.workable.com/example/j/CODE",
      "https://apply.workable.com:444/example/j/CODE",
      "https://apply.workable.com/example/j/CODE/other",
    ]) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl(url, undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => { fetches += 1; return htmlResponse(`<main>${VALID_TEXT}</main>`); },
      })).resolves.toEqual({ kind: "model-fallback", lines: [VALID_TEXT] });
      expect(fetches).toBe(1);
    }
  });

  test("keeps rendered Greenhouse API failures visible and never follows API redirects", async () => {
    for (const [apiResponse, code] of [
      [() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }), "JOB_SOURCE_UNAVAILABLE"],
      [() => Response.json({}, { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }), "JOB_SOURCE_TOO_LARGE"],
      [() => { throw new Error("private network detail"); }, "JOB_SOURCE_UNAVAILABLE"],
    ] as const) {
      let fetches = 0;
      await expect(loadJobSourceFromUrl("https://employer.example/jobs/42", undefined, {
        resolveHost: resolvePublic,
        fetchImpl: async () => ++fetches === 1 ? htmlResponse("<body></body>") : apiResponse(),
        renderHtml: async () => ({ html: `<iframe src="https://boards.greenhouse.io/embed/job_app?for=example&token=42"></iframe>`, finalUrl: null }),
      })).rejects.toMatchObject({ code });
      expect(fetches).toBe(2);
    }
  });

  test("blocks private Greenhouse API DNS after rendering before fetching it", async () => {
    let fetches = 0;
    await expect(loadJobSourceFromUrl("https://employer.example/jobs/42", undefined, {
      resolveHost: async (host) => [{ address: host === "boards-api.greenhouse.io" ? "127.0.0.1" : PUBLIC_V4, family: 4 }],
      fetchImpl: async () => { fetches += 1; return htmlResponse("<body></body>"); },
      renderHtml: async () => ({ html: `<iframe src="https://boards.greenhouse.io/embed/job_app?for=example&token=42"></iframe>`, finalUrl: null }),
    })).rejects.toMatchObject({ code: "JOB_URL_BLOCKED" });
    expect(fetches).toBe(1);
  });

  test("does not mask oversized rendered content as a missing description", async () => {
    await expect(loadJobSourceFromUrl("https://employer.example/jobs/42", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => htmlResponse("<body></body>"),
      renderHtml: async () => ({ html: `<main>${"x".repeat(512 * 1024 + 1)}</main>`, finalUrl: null }),
    })).rejects.toMatchObject({ code: "JOB_SOURCE_TOO_LARGE" });
  });

  test("retains visible opportunity context inside rendered lead forms", async () => {
    const leadText = "Please submit your information and a recruiter will be in touch with next steps!";
    await expect(loadJobSourceFromUrl("https://careers.example.test/leadpage", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => htmlResponse("<body></body>"),
      renderHtml: async () => ({
        html: `<body><form><h1>Software Engineer Internship</h1><p>${leadText}</p>
          <input name="email"><button type="submit">Submit private application</button></form></body>`,
        finalUrl: null,
      }),
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: ["Software Engineer Internship", leadText],
    });
  });

  test("returns normalized plain text as model lines when opportunity kind is omitted", async () => {
    let renders = 0;
    const fetchImpl: JobSourceFetch = async () => response(
      "  Senior   Engineer\r\n\r\n Build\tsecure systems and collaborate across the whole team.  ",
    );

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl,
      resolveHost: resolvePublic,
      renderHtml: async () => {
        renders += 1;
        return undefined;
      },
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: ["Senior Engineer", "", "Build secure systems and collaborate across the whole team."],
    });
    expect(renders).toBe(0);
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
      renderHtml: async () => undefined,
    })).rejects.toMatchObject({ code: "JOB_SOURCE_RENDER_UNAVAILABLE" });
  });

  test("rejects a TAL human-verification page instead of returning model fallback", async () => {
    const body = `<!doctype html>
      <html lang="en">
        <head><title>Quick Check Needed</title></head>
        <body>
          <main>
            <h1>Quick Check Needed</h1>
            <p>We just need to confirm you're a real person. Please check the box below and then click Continue.</p>
            <p>This quick check helps keep this service secure and ensures visitors can continue to the requested page.</p>
            <label><input type="checkbox" name="human-verification"> I'm a real person</label>
            <button type="button">Continue</button>
          </main>
        </body>
      </html>`;

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
    })).rejects.toMatchObject({
      code: "JOB_HUMAN_VERIFICATION_REQUIRED",
      status: 409,
    });
  });
  test("offers human verification for a rendered challenge", async () => {
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse("<html><body></body></html>"),
      resolveHost: resolvePublic,
      renderHtml: async () => ({
        html: "<html><body><h1>Quick Check Needed</h1><p>We just need to confirm you're a real person. Please check the box below.</p></body></html>",
        finalUrl: "https://jobs.example.test/verification",
      }),
    })).rejects.toMatchObject({ code: "JOB_HUMAN_VERIFICATION_REQUIRED", status: 409 });
  });

  test.each([null, "https://other.example.test/verification"])("offers rendered verification without original-origin provenance for browser URL %s", async (finalUrl) => {
    const shell = "<!doctype html><html><body><div id=\"root\"></div></body></html>";
    const challenge = `<!doctype html><html><body><main>
      <h1>Quick Check Needed</h1>
      <p>We just need to confirm you're a real person. Please check the box below.</p>
    </main></body></html>`;

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(shell),
      resolveHost: resolvePublic,
      renderHtml: async () => ({ html: challenge, finalUrl }),
    })).rejects.toMatchObject({ code: "JOB_HUMAN_VERIFICATION_REQUIRED", status: 409 });
  });

  test("does not advertise handoff for HTTP or trailing-dot submissions", async () => {
    const challenge = `<!doctype html><html><body><main>
      <h1>Quick Check Needed</h1>
      <p>We just need to confirm you're a real person. Please check the box below and continue to the requested opportunity page.</p>
    </main></body></html>`;

    await expect(loadJobSourceFromUrl("http://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(challenge),
      resolveHost: resolvePublic,
    })).resolves.toMatchObject({ kind: "model-fallback" });
    await expect(loadJobSourceFromUrl("https://jobs.example.test./role", undefined, {
      fetchImpl: async () => htmlResponse(challenge),
      resolveHost: resolvePublic,
    })).resolves.toMatchObject({ kind: "model-fallback" });
  });

  test("offers human verification after a public cross-origin redirect", async () => {
    const challenge = `<!doctype html><html><body><main>
      <h1>Quick Check Needed</h1>
      <p>We just need to confirm you're a real person. Please check the box below and continue to the requested opportunity page.</p>
    </main></body></html>`;
    let requestCount = 0;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response(null, {
              status: 302,
              headers: { location: "https://careers.example.test/role" },
            })
          : htmlResponse(challenge);
      },
      resolveHost: resolvePublic,
    })).rejects.toMatchObject({ code: "JOB_HUMAN_VERIFICATION_REQUIRED", status: 409 });
    expect(requestCount).toBe(2);
  });

  test("requires both TAL markers before changing ordinary fallback classification", async () => {
    for (const body of [
      "<main><h1>Quick Check Needed</h1><p>Build reliable systems with a collaborative engineering team.</p></main>",
      "<main><p>We just need to confirm you're a real person.</p><p>Build reliable systems with a collaborative engineering team.</p></main>",
    ]) {
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        fetchImpl: async () => htmlResponse(body),
        resolveHost: resolvePublic,
      })).resolves.toMatchObject({ kind: "model-fallback" });
    }
  });

  test("renders an unusable IBM careers shell before returning sanitized fallback lines", async () => {
    const terminalUrl = "https://careers.ibm.com/job/software-developer-intern/12345";
    const shell = `<!doctype html>
      <html lang="en">
        <head>
          <title>IBM Careers</title>
          <script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>
        </head>
        <body>
          <noscript>Enable JavaScript to continue.</noscript>
          <div id="root"></div>
          <script src="/assets/careers.js"></script>
        </body>
      </html>`;
    const renderedHtml = `<!doctype html>
      <html lang="en">
        <head><title>Software Developer Intern | IBM Careers</title></head>
        <body>
          <main>
            <h1>Software Developer Intern</h1>
            <section>
              <h2>Your role and responsibilities</h2>
              <p>Join IBM to build secure cloud software that helps clients solve complex business problems.</p>
              <p>Collaborate with engineers, designers, and product leaders throughout the development lifecycle.</p>
            </section>
          </main>
        </body>
      </html>`;
    const renders: Array<{ url: string; signal: AbortSignal }> = [];

    const result = await loadJobSourceFromUrl(terminalUrl, undefined, {
      fetchImpl: async () => htmlResponse(shell),
      resolveHost: resolvePublic,
      renderHtml: async (url: string, signal: AbortSignal) => {
        renders.push({ url, signal });
        expect(signal.aborted).toBe(false);
        return { html: renderedHtml, finalUrl: null };
      },
    });

    expect(renders).toHaveLength(1);
    expect(renders[0]!.url).toBe(terminalUrl);
    expect(renders[0]!.signal.aborted).toBe(false);
    expect(result).toEqual({
      kind: "model-fallback",
      lines: [
        "Software Developer Intern",
        "",
        "Your role and responsibilities",
        "",
        "Join IBM to build secure cloud software that helps clients solve complex business problems.",
        "",
        "Collaborate with engineers, designers, and product leaders throughout the development lifecycle.",
      ],
    });
  });

  test("reports unavailable rendering without exposing renderer failures", async () => {
    const shell = "<html><body><div id=\"root\"></div><script src=\"/job.js\"></script></body></html>";
    const renderers: RenderJobSourceHtml[] = [
      async () => undefined,
      async () => {
        throw new Error("private renderer failure");
      },
      async () => { throw new RenderJobSourceError(); },
    ];

    for (const renderHtml of renderers) {
      await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
        fetchImpl: async () => htmlResponse(shell),
        resolveHost: resolvePublic,
        renderHtml,
      })).rejects.toMatchObject({
        code: "JOB_SOURCE_RENDER_UNAVAILABLE",
        status: 422,
      });
    }
  });

  test("propagates the caller's exact abort reason while rendering", async () => {
    const controller = new AbortController();
    const renderStarted = deferred<void>();
    const promise = loadJobSourceFromUrl("https://jobs.example.test/role", controller.signal, {
      fetchImpl: async () => htmlResponse("<html><body><div id=\"root\"></div></body></html>"),
      resolveHost: resolvePublic,
      renderHtml: async (_url, renderSignal) => {
        renderStarted.resolve();
        await new Promise<void>((resolve) => {
          renderSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        renderSignal.throwIfAborted();
        return undefined;
      },
    });

    await renderStarted.promise;
    const reason = new Error("stop rendered source loading");
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);
  });

  test("reports rendering failure when the shared deadline expires while rendering", async () => {
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      deadlineMs: 5,
      fetchImpl: async () => htmlResponse("<html><body><div id=\"root\"></div></body></html>"),
      resolveHost: resolvePublic,
      renderHtml: async (_url, renderSignal) => {
        await new Promise<void>((resolve) => {
          renderSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        renderSignal.throwIfAborted();
        return undefined;
      },
    })).rejects.toMatchObject({
      code: "JOB_SOURCE_RENDER_UNAVAILABLE",
      status: 422,
    });
  });

  test("loads a JPMC Oracle Candidate Experience shell through its same-origin public requisition API", async () => {
    let renders = 0;
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
      {
        fetchImpl,
        resolveHost: resolvePublic,
        renderHtml: async () => {
          renders += 1;
          return undefined;
        },
      },
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
    expect(renders).toBe(0);
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
      let renders = 0;
      await expect(loadJobSourceFromUrl(sourceUrl, undefined, {
        resolveHost: resolvePublic,
        renderHtml: async () => {
          renders += 1;
          return undefined;
        },
        fetchImpl: async () => {
          fetches += 1;
          return htmlResponse("<html><body><div id=\"app\"></div></body></html>");
        },
      })).rejects.toMatchObject({ code: sourceUrl.startsWith("https:") ? "JOB_SOURCE_RENDER_UNAVAILABLE" : "JOB_DESCRIPTION_UNAVAILABLE" });
      expect(fetches).toBe(1);
      expect(renders).toBe(sourceUrl.startsWith("https:") ? 1 : 0);
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
    let renders = 0;
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
      renderHtml: async () => {
        renders += 1;
        return undefined;
      },
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
    expect(renders).toBe(0);
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

  test("returns the complete sanitized body when an early main contains only a valid title", async () => {
    let renders = 0;
    const body = [
      "<body><header>L'Oréal careers navigation</header>",
      "<main><h1>Senior Manager, Data Engineering and Analytics</h1></main>",
      "<script type=\"application/ld+json\">{\"@type\":\"JobPosting\",\"title\":\"Senior Manager, Data Engineering and Analytics\"}</script>",
      "<section><h2>About the role</h2>",
      "<p>L'Oréal is seeking a leader to build trusted data products for teams across the business.</p>",
      "<h2>Responsibilities</h2>",
      "<p>Lead engineers, shape the platform roadmap, and partner with product and analytics leaders.</p>",
      "<h2>Qualifications</h2>",
      "<ul><li>Experience delivering reliable cloud data platforms.</li>",
      "<li>Strong communication and people leadership skills.</li></ul></section>",
      "<nav>Discard related job links</nav>",
      "<form>Discard job alerts<input value=\"email\"></form>",
      "<script>discard()</script><div hidden>Discard hidden content</div>",
      "<footer>Discard legal links</footer></body>",
    ].join("");

    await expect(loadJobSourceFromUrl("https://careers.loreal.example/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
      renderHtml: async () => {
        renders += 1;
        return undefined;
      },
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: [
        "Senior Manager, Data Engineering and Analytics",
        "",
        "About the role",
        "L'Oréal is seeking a leader to build trusted data products for teams across the business.",
        "Responsibilities",
        "Lead engineers, shape the platform roadmap, and partner with product and analytics leaders.",
        "Qualifications",
        "Experience delivering reliable cloud data platforms.",
        "Strong communication and people leadership skills.",
      ],
    });
    expect(renders).toBe(0);
  });

  test("recovers the longest bounded static candidate when the complete body exceeds Luna's byte limit", async () => {
    let renders = 0;
    const body = [
      "<body>",
      `<section>${"Unrelated company culture details. ".repeat(17_000)}</section>`,
      "<main>Platform engineer builds reliable internal services and supports delivery teams.</main>",
      "<article>Principal platform engineer leads secure infrastructure design, mentors engineers, and partners with product teams to deliver reliable customer systems.</article>",
      "</body>",
    ].join("");

    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
      renderHtml: async () => {
        renders += 1;
        return undefined;
      },
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: [
        "Principal platform engineer leads secure infrastructure design, mentors engineers, and partners with product teams to deliver reliable customer systems.",
      ],
    });
    expect(renders).toBe(0);
  });

  test("returns the complete sanitized body to Luna instead of prioritizing nested elements", async () => {
    let renders = 0;
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
      renderHtml: async () => {
        renders += 1;
        return undefined;
      },
    })).resolves.toEqual({
      kind: "model-fallback",
      lines: [
        "Article role",
        VALID_TEXT,
        "",
        "Main role",
        "Build dependable & secure systems.",
        "Qualifications",
        "Collaborate across teams.",
      ],
    });
    expect(renders).toBe(0);
  });

  test("keeps short nested elements in the complete sanitized body sent to Luna", async () => {
    const article = "Article candidate contains enough exact source characters for fallback selection.";
    const body = `<body><main>tiny</main><article>${article}</article><p>${VALID_TEXT}</p></body>`;
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      fetchImpl: async () => htmlResponse(body),
      resolveHost: resolvePublic,
    })).resolves.toEqual({ kind: "model-fallback", lines: ["tiny", article, VALID_TEXT] });
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
      "lowser/0.1",
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
      headers: { "User-Agent": "jobhunt-source-test/1.0" },
      resolveHost: resolvePublic,
      fetchImpl: async (_input, init) => {
        observedHeaders = new Headers(init.headers);
        return response(VALID_TEXT);
      },
    });

    expect(await fetched.text()).toBe(VALID_TEXT);
    expect(observedHeaders?.get("user-agent")).toBe("jobhunt-source-test/1.0");
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

  test("enforces declared and streamed four-MiB body limits before decoding", async () => {
    let pulled = false;
    let cancelled = false;
    const declared = new ReadableStream<Uint8Array>({
      pull() { pulled = true; },
      cancel() { cancelled = true; },
    });
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => new Response(declared, {
        headers: { "content-type": "text/plain", "content-length": String(4 * 1024 * 1024 + 1) },
      }),
    })).rejects.toMatchObject({ code: "JOB_SOURCE_TOO_LARGE" });
    expect(pulled).toBe(true);
    expect(cancelled).toBe(true);

    let streamCancelled = false;
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
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
    const exactBody = `${postingJson}<script>${"x".repeat(4 * 1024 * 1024 - postingJson.length - 17)}</script>`;
    expect(new TextEncoder().encode(exactBody).byteLength).toBe(4 * 1024 * 1024);
    await expect(loadJobSourceFromUrl("https://jobs.example.test/role", undefined, {
      resolveHost: resolvePublic,
      fetchImpl: async () => htmlResponse(exactBody, { "content-length": String(4 * 1024 * 1024) }),
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

  test("blocks multicast, site-local, and unallocated ranges while allowing allocated public addresses", async () => {
    for (const cidr of ["224.0.0.0/4", "ff00::/8", "fec0::/10", "4000::/3", "fe00::/9"]) {
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
