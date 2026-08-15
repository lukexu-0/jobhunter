import { expect, test } from "bun:test";
import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { startPublicConnectProxy } from "../src/api/public-connect-proxy.ts";

const MAX_RESPONSE_BYTES = 1_024;
const EXCHANGE_DEADLINE_MS = 1_000;
const REJECTION_RESPONSE =
  "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
const CONNECTED_RESPONSE = "HTTP/1.1 200 Connection Established\r\n\r\n";
const SAFETY_DEADLINE_MS = 2_000;
const PUBLIC_ADDRESS = { address: "93.184.216.34", family: 4 } as const;
const CONNECT_REQUEST =
  "CONNECT jobs.example.com:443 HTTP/1.1\r\nHost: jobs.example.com:443\r\n\r\n";

// Real loopback socket I/O cannot be bounded by fake timers.
async function withDeadline<T>(
  operation: Promise<T>,
  description: string,
  timeoutMs = SAFETY_DEADLINE_MS,
): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    deadline.reject(new Error(`${description} exceeded the test deadline`));
  }, timeoutMs);
  try {
    return await Promise.race([operation, deadline.promise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function exchange(
  host: string,
  port: number,
  request: string,
): Promise<{ readonly client: Socket; readonly response: string }> {
  const client = createConnection({ host, port });
  const connected = Promise.withResolvers<void>();
  client.once("connect", () => connected.resolve());
  client.once("error", connected.reject);

  const operation = async (): Promise<{
    readonly client: Socket;
    readonly response: string;
  }> => {
    await connected.promise;
    client.write(request);

    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of client) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        throw new Error("proxy response exceeded the test byte limit");
      }
      chunks.push(buffer);
    }

    return { client, response: Buffer.concat(chunks, bytes).toString("utf8") };
  };

  // This covers real socket I/O, so fake timers cannot bound a stalled exchange.
  const deadline = Promise.withResolvers<never>();
  const timeout = setTimeout(() => {
    deadline.reject(new Error("proxy exchange exceeded the test deadline"));
  }, EXCHANGE_DEADLINE_MS);

  try {
    return await Promise.race([operation(), deadline.promise]);
  } finally {
    clearTimeout(timeout);
    if (!client.destroyed) client.destroy();
  }
}

async function readExact(client: Socket, expectedBytes: number): Promise<Buffer> {
  const operation = async (): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes < expectedBytes) {
      const chunk = client.read(
        Math.min(expectedBytes - bytes, 64 * 1024),
      ) as Buffer | null;
      if (chunk === null) {
        if (client.destroyed || client.readableEnded) {
          throw new Error("socket closed before its expected frame was complete");
        }
        await once(client, "readable");
        continue;
      }
      bytes += chunk.byteLength;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  };

  return withDeadline(operation(), `reading ${expectedBytes} socket bytes`);
}

async function connectLoopback(host: string, port: number): Promise<void> {
  const client = createConnection({ host, port });
  const connected = Promise.withResolvers<void>();
  client.once("connect", () => connected.resolve());
  client.once("error", connected.reject);
  try {
    await connected.promise;
  } finally {
    client.destroy();
  }
}

async function connectClient(host: string, port: number): Promise<Socket> {
  const client = createConnection({ host, port });
  client.on("error", () => {});
  try {
    await withDeadline(
      once(client, "connect").then(() => undefined),
      "connecting a proxy client",
    );
    return client;
  } catch (error) {
    client.destroy();
    throw error;
  }
}

async function dialLoopback(port: number, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  const socket = createConnection({ host: "127.0.0.1", port });
  try {
    await withDeadline(
      once(socket, "connect").then(() => undefined),
      "connecting an injected upstream socket",
    );
    signal.throwIfAborted();
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

async function openTunnel(
  host: string,
  port: number,
  request = CONNECT_REQUEST,
): Promise<Socket> {
  const client = await connectClient(host, port);
  client.write(request);
  const response = await readExact(client, Buffer.byteLength(CONNECTED_RESPONSE));
  expect(response.toString("ascii")).toBe(CONNECTED_RESPONSE);
  return client;
}

async function waitForSocketClose(socket: Socket): Promise<void> {
  if (socket.closed) return;
  await withDeadline(
    new Promise<void>((resolve) => socket.once("close", () => resolve())),
    "waiting for a socket to close",
  );
}

async function listenLoopback(server: Server): Promise<number> {
  server.listen({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP address");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await withDeadline(
    new Promise<void>((resolve) => server.close(() => resolve())),
    "closing a test server",
  );
}

test("resolves a public DNS CONNECT target, pins the dial, and tunnels bytes", async () => {
  const controller = new AbortController();
  const upstream = createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listenLoopback(upstream);
  const resolvedAddress = { address: "93.184.216.34", family: 4 } as const;
  const resolvedHostnames: string[] = [];
  const dialedAddresses: Array<{ readonly address: string; readonly family: 4 | 6 }> = [];
  const proxy = await startPublicConnectProxy({
    signal: controller.signal,
    resolveAddresses: async (hostname, signal) => {
      expect(signal.aborted).toBeFalse();
      resolvedHostnames.push(hostname);
      return [resolvedAddress];
    },
    dial: async (address, signal) => {
      expect(signal.aborted).toBeFalse();
      dialedAddresses.push(address);
      const socket = createConnection({ host: "127.0.0.1", port: upstreamPort });
      await once(socket, "connect");
      return socket;
    },
  });
  const client = createConnection({ host: proxy.host, port: proxy.port });

  try {
    await once(client, "connect");
    client.write(
      "CONNECT jobs.example.com:443 HTTP/1.1\r\nHost: jobs.example.com:443\r\n\r\n",
    );
    const response = await readExact(client, Buffer.byteLength(CONNECTED_RESPONSE));
    expect(response.toString("ascii")).toBe(CONNECTED_RESPONSE);

    const payload = Buffer.from([0x00, 0x41, 0xff, 0x42]);
    client.write(payload);
    const echo = await readExact(client, payload.byteLength);
    expect(echo).toEqual(payload);
    expect(resolvedHostnames).toEqual(["jobs.example.com"]);
    expect(dialedAddresses).toEqual([resolvedAddress]);
  } finally {
    client.destroy();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("rejects a private CONNECT target without resolving or dialing it", async () => {
  const controller = new AbortController();
  let resolverCalls = 0;
  let dialCalls = 0;
  const proxy = await startPublicConnectProxy({
    signal: controller.signal,
    resolveAddresses: async () => {
      resolverCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }] as const;
    },
    dial: async () => {
      dialCalls += 1;
      throw new Error("the proxy must not dial a rejected target");
    },
  });
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= proxy.close();

  try {
    expect(proxy.host).toBe("127.0.0.1");
    const { client, response } = await exchange(
      proxy.host,
      proxy.port,
      "CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n",
    );

    expect(response).toBe(REJECTION_RESPONSE);
    expect(client.destroyed).toBeTrue();
    expect(resolverCalls).toBe(0);
    expect(dialCalls).toBe(0);

    await close();
    await expect(connectLoopback(proxy.host, proxy.port)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  } finally {
    await close();
  }
});

test("rejects ordinary requests and CONNECT targets on ports other than 443", async () => {
  const controller = new AbortController();
  let resolverCalls = 0;
  let dialCalls = 0;
  const proxy = await startPublicConnectProxy({
    signal: controller.signal,
    resolveAddresses: async () => {
      resolverCalls += 1;
      return [{ address: "93.184.216.34", family: 4 }] as const;
    },
    dial: async () => {
      dialCalls += 1;
      throw new Error("the proxy must not dial a rejected request");
    },
  });

  try {
    const ordinary = await exchange(
      proxy.host,
      proxy.port,
      "GET https://jobs.example.com/ HTTP/1.1\r\nHost: jobs.example.com\r\n\r\n",
    );
    const otherPort = await exchange(
      proxy.host,
      proxy.port,
      "CONNECT jobs.example.com:80 HTTP/1.1\r\nHost: jobs.example.com:80\r\n\r\n",
    );

    expect(ordinary.response).toBe(REJECTION_RESPONSE);
    expect(otherPort.response).toBe(REJECTION_RESPONSE);
    expect(resolverCalls).toBe(0);
    expect(dialCalls).toBe(0);
  } finally {
    await proxy.close();
  }
});

test("does not dial when public-address validation rejects the DNS result", async () => {
  const controller = new AbortController();
  const validationError = new Error("DNS result contained a private address");
  let dialCalls = 0;
  const proxy = await startPublicConnectProxy({
    signal: controller.signal,
    resolveAddresses: async () => {
      throw validationError;
    },
    dial: async () => {
      dialCalls += 1;
      throw new Error("the proxy must not dial after validation fails");
    },
  });

  try {
    const { response } = await exchange(
      proxy.host,
      proxy.port,
      "CONNECT jobs.example.com:443 HTTP/1.1\r\nHost: jobs.example.com:443\r\n\r\n",
    );

    expect(response).toBe(REJECTION_RESPONSE);
    expect(dialCalls).toBe(0);
  } finally {
    await proxy.close();
  }
});

test("abort closes the listener and both sides of an active tunnel", async () => {
  const controller = new AbortController();
  const accepted = Promise.withResolvers<Socket>();
  const upstream = createServer((socket) => accepted.resolve(socket));
  const upstreamPort = await listenLoopback(upstream);
  const proxy = await startPublicConnectProxy({
    signal: controller.signal,
    resolveAddresses: async () => {
      return [{ address: "93.184.216.34", family: 4 }] as const;
    },
    dial: async (_address, signal) => {
      signal.throwIfAborted();
      const socket = createConnection({ host: "127.0.0.1", port: upstreamPort });
      await once(socket, "connect");
      return socket;
    },
  });
  const client = createConnection({ host: proxy.host, port: proxy.port });

  try {
    await once(client, "connect");
    client.write(
      "CONNECT jobs.example.com:443 HTTP/1.1\r\nHost: jobs.example.com:443\r\n\r\n",
    );
    const [response] = await once(client, "data");
    expect(Buffer.from(response).toString("ascii")).toBe(CONNECTED_RESPONSE);
    const upstreamSocket = await accepted.promise;
    const clientClosed = once(client, "close");
    const upstreamClosed = once(upstreamSocket, "close");

    controller.abort(new Error("test abort"));
    await Promise.all([clientClosed, upstreamClosed]);
    const closePromise = proxy.close();
    expect(proxy.close()).toBe(closePromise);
    await closePromise;
    await expect(connectLoopback(proxy.host, proxy.port)).rejects.toMatchObject({
      code: "ECONNREFUSED",
    });
  } finally {
    client.destroy();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("accepts a CONNECT header split across socket reads", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listenLoopback(upstream);
  let resolverCalls = 0;
  const proxy = await startPublicConnectProxy({
    signal: new AbortController().signal,
    resolveAddresses: async () => {
      resolverCalls += 1;
      return [PUBLIC_ADDRESS];
    },
    dial: async (_address, signal) => dialLoopback(upstreamPort, signal),
  });
  const client = await connectClient(proxy.host, proxy.port);

  try {
    client.write("CONNECT jobs.example.com:443 HTTP/1.1\r\nHo");
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(resolverCalls).toBe(0);

    client.write("st: jobs.example.com:443\r\nX-Test: split");
    await new Promise<void>((resolve) => setImmediate(resolve));
    client.write("\r\n\r\n");

    const response = await readExact(client, Buffer.byteLength(CONNECTED_RESPONSE));
    expect(response.toString("ascii")).toBe(CONNECTED_RESPONSE);
    client.write(Buffer.from([0x00, 0xff, 0x41]));
    expect(await readExact(client, 3)).toEqual(Buffer.from([0x00, 0xff, 0x41]));
    expect(resolverCalls).toBe(1);
  } finally {
    client.destroy();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("accepts an exact 8 KiB CONNECT header and rejects the next byte", async () => {
  const upstream = createServer((socket) => socket.pipe(socket));
  const upstreamPort = await listenLoopback(upstream);
  let resolverCalls = 0;
  let dialCalls = 0;
  const proxy = await startPublicConnectProxy({
    signal: new AbortController().signal,
    resolveAddresses: async () => {
      resolverCalls += 1;
      return [PUBLIC_ADDRESS];
    },
    dial: async (_address, signal) => {
      dialCalls += 1;
      return dialLoopback(upstreamPort, signal);
    },
  });
  const exactHeader =
    `CONNECT jobs.example.com:443 HTTP/1.1\r\nX-Pad: ${"a".repeat(8_142)}\r\n\r\n`;
  const oversizedHeader =
    `CONNECT jobs.example.com:443 HTTP/1.1\r\nX-Pad: ${"a".repeat(8_143)}\r\n\r\n`;
  let exactClient: Socket | undefined;

  try {
    expect(Buffer.byteLength(exactHeader, "ascii")).toBe(8 * 1024);
    expect(Buffer.byteLength(oversizedHeader, "ascii")).toBe((8 * 1024) + 1);

    exactClient = await openTunnel(proxy.host, proxy.port, exactHeader);
    exactClient.write(Buffer.from([0xde, 0xad]));
    expect(await readExact(exactClient, 2)).toEqual(Buffer.from([0xde, 0xad]));
    exactClient.destroy();
    await waitForSocketClose(exactClient);

    const rejected = await exchange(proxy.host, proxy.port, oversizedHeader);
    expect(rejected.response).toBe(REJECTION_RESPONSE);
    expect(resolverCalls).toBe(1);
    expect(dialCalls).toBe(1);
  } finally {
    exactClient?.destroy();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("preserves trailing binary TLS bytes as one tunnel payload, not another request", async () => {
  const upstream = createServer();
  const upstreamPort = await listenLoopback(upstream);
  const resolvedHostnames: string[] = [];
  let dialCalls = 0;
  const proxy = await startPublicConnectProxy({
    signal: new AbortController().signal,
    resolveAddresses: async (hostname) => {
      resolvedHostnames.push(hostname);
      return [PUBLIC_ADDRESS];
    },
    dial: async (_address, signal) => {
      dialCalls += 1;
      return dialLoopback(upstreamPort, signal);
    },
  });
  const accepted = withDeadline(
    once(upstream, "connection").then(([socket]) => socket as Socket),
    "accepting the smuggling-boundary upstream socket",
  );
  const client = await connectClient(proxy.host, proxy.port);
  const initialPayload = Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01, 0x00, 0x2a, 0x00, 0xff]),
    Buffer.from(
      "\r\n\r\nCONNECT internal.example:443 HTTP/1.1\r\nHost: internal.example\r\n\r\n",
      "ascii",
    ),
  ]);
  let upstreamSocket: Socket | undefined;

  try {
    client.write(Buffer.concat([
      Buffer.from(CONNECT_REQUEST, "ascii"),
      initialPayload,
    ]));
    const response = await readExact(client, Buffer.byteLength(CONNECTED_RESPONSE));
    expect(response.toString("ascii")).toBe(CONNECTED_RESPONSE);

    upstreamSocket = await accepted;
    expect(await readExact(upstreamSocket, initialPayload.byteLength)).toEqual(initialPayload);
    expect(resolvedHostnames).toEqual(["jobs.example.com"]);
    expect(dialCalls).toBe(1);
  } finally {
    client.destroy();
    await proxy.close();
    upstreamSocket?.destroy();
    await closeServer(upstream);
  }
});

test("enforces the concurrent tunnel cap and releases it after cleanup", async () => {
  const upstream = createServer();
  const upstreamPort = await listenLoopback(upstream);
  let resolverCalls = 0;
  let dialCalls = 0;
  const proxy = await startPublicConnectProxy({
    signal: new AbortController().signal,
    resolveAddresses: async () => {
      resolverCalls += 1;
      return [PUBLIC_ADDRESS];
    },
    dial: async (_address, signal) => {
      dialCalls += 1;
      return dialLoopback(upstreamPort, signal);
    },
    maxConcurrentTunnels: 1,
    maxTotalTunnels: 3,
  });
  let firstClient: Socket | undefined;
  let firstUpstream: Socket | undefined;
  let thirdClient: Socket | undefined;
  let thirdUpstream: Socket | undefined;

  try {
    const firstAccepted = withDeadline(
      once(upstream, "connection").then(([socket]) => socket as Socket),
      "accepting the first capped upstream socket",
    );
    firstClient = await openTunnel(proxy.host, proxy.port);
    firstUpstream = await firstAccepted;

    const rejected = await exchange(proxy.host, proxy.port, CONNECT_REQUEST);
    expect(rejected.response).toBe(REJECTION_RESPONSE);
    expect(resolverCalls).toBe(1);
    expect(dialCalls).toBe(1);

    firstUpstream.resume();
    firstClient.destroy();
    await Promise.all([
      waitForSocketClose(firstClient),
      waitForSocketClose(firstUpstream),
    ]);

    const thirdAccepted = withDeadline(
      once(upstream, "connection").then(([socket]) => socket as Socket),
      "accepting the replacement upstream socket",
    );
    thirdClient = await openTunnel(proxy.host, proxy.port);
    thirdUpstream = await thirdAccepted;
    expect(resolverCalls).toBe(2);
    expect(dialCalls).toBe(2);
  } finally {
    firstClient?.destroy();
    firstUpstream?.destroy();
    thirdClient?.destroy();
    await proxy.close();
    thirdUpstream?.destroy();
    await closeServer(upstream);
  }
});

test("enforces the total tunnel cap after earlier tunnels are cleaned up", async () => {
  const upstream = createServer((socket) => socket.resume());
  const upstreamPort = await listenLoopback(upstream);
  let resolverCalls = 0;
  let dialCalls = 0;
  const proxy = await startPublicConnectProxy({
    signal: new AbortController().signal,
    resolveAddresses: async () => {
      resolverCalls += 1;
      return [PUBLIC_ADDRESS];
    },
    dial: async (_address, signal) => {
      dialCalls += 1;
      return dialLoopback(upstreamPort, signal);
    },
    maxConcurrentTunnels: 1,
    maxTotalTunnels: 2,
  });
  const openedClients: Socket[] = [];
  const acceptedSockets: Socket[] = [];

  try {
    for (let index = 0; index < 2; index += 1) {
      const accepted = withDeadline(
        once(upstream, "connection").then(([socket]) => socket as Socket),
        "accepting a total-capped upstream socket",
      );
      const client = await openTunnel(proxy.host, proxy.port);
      const upstreamSocket = await accepted;
      openedClients.push(client);
      acceptedSockets.push(upstreamSocket);

      client.destroy();
      await Promise.all([
        waitForSocketClose(client),
        waitForSocketClose(upstreamSocket),
      ]);
    }

    const rejected = await exchange(proxy.host, proxy.port, CONNECT_REQUEST);
    expect(rejected.response).toBe(REJECTION_RESPONSE);
    expect(resolverCalls).toBe(2);
    expect(dialCalls).toBe(2);
  } finally {
    for (const client of openedClients) client.destroy();
    for (const socket of acceptedSockets) socket.destroy();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("applies one aggregate byte cap across both tunnel directions", async () => {
  const upstream = createServer();
  const upstreamPort = await listenLoopback(upstream);
  const proxy = await startPublicConnectProxy({
    signal: new AbortController().signal,
    resolveAddresses: async () => [PUBLIC_ADDRESS],
    dial: async (_address, signal) => dialLoopback(upstreamPort, signal),
    maxTotalBytes: 5,
  });
  const accepted = withDeadline(
    once(upstream, "connection").then(([socket]) => socket as Socket),
    "accepting the byte-capped upstream socket",
  );
  let client: Socket | undefined;
  let upstreamSocket: Socket | undefined;

  try {
    client = await openTunnel(proxy.host, proxy.port);
    upstreamSocket = await accepted;

    const outbound = Buffer.from([0x00, 0x41, 0xff]);
    client.write(outbound);
    expect(await readExact(upstreamSocket, outbound.byteLength)).toEqual(outbound);

    const inbound = Buffer.from([0x16, 0x03]);
    upstreamSocket.write(inbound);
    expect(await readExact(client, inbound.byteLength)).toEqual(inbound);

    client.resume();
    upstreamSocket.resume();
    await Promise.all([
      waitForSocketClose(client),
      waitForSocketClose(upstreamSocket),
    ]);
  } finally {
    client?.destroy();
    upstreamSocket?.destroy();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("closes both tunnel sockets after the configured idle timeout", async () => {
  const upstream = createServer((socket) => socket.resume());
  const upstreamPort = await listenLoopback(upstream);
  const proxy = await startPublicConnectProxy({
    signal: new AbortController().signal,
    resolveAddresses: async () => [PUBLIC_ADDRESS],
    dial: async (_address, signal) => dialLoopback(upstreamPort, signal),
    socketIdleTimeoutMs: 25,
  });
  const accepted = withDeadline(
    once(upstream, "connection").then(([socket]) => socket as Socket),
    "accepting the idle upstream socket",
  );
  let client: Socket | undefined;
  let upstreamSocket: Socket | undefined;

  try {
    client = await openTunnel(proxy.host, proxy.port);
    upstreamSocket = await accepted;
    client.resume();

    // net.Socket idle expiry is driven by libuv, so fake timers cannot exercise it.
    await Promise.all([
      waitForSocketClose(client),
      waitForSocketClose(upstreamSocket),
    ]);
    expect(client.closed).toBeTrue();
    expect(upstreamSocket.closed).toBeTrue();
  } finally {
    client?.destroy();
    upstreamSocket?.destroy();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("resumes lossless forwarding after injected upstream write backpressure", async () => {
  const upstream = createServer();
  const upstreamPort = await listenLoopback(upstream);
  const accepted = withDeadline(
    once(upstream, "connection").then(([socket]) => socket as Socket),
    "accepting the backpressured upstream socket",
  );
  let forcedBackpressure = false;
  let injectedSocket: Socket | undefined;
  const proxy = await startPublicConnectProxy({
    signal: new AbortController().signal,
    resolveAddresses: async () => [PUBLIC_ADDRESS],
    dial: async (_address, signal) => {
      injectedSocket = await dialLoopback(upstreamPort, signal);
      const write = injectedSocket.write.bind(injectedSocket);
      let nextWriteBackpressures = true;
      injectedSocket.write = ((
        chunk: string | Uint8Array,
        encodingOrCallback?:
          | BufferEncoding
          | ((error: Error | null | undefined) => void),
        callback?: (error: Error | null | undefined) => void,
      ): boolean => {
        const writable = typeof encodingOrCallback === "string"
          ? write(chunk, encodingOrCallback, callback)
          : typeof encodingOrCallback === "function"
            ? write(chunk, encodingOrCallback)
            : write(chunk);
        if (!nextWriteBackpressures) return writable;
        nextWriteBackpressures = false;
        forcedBackpressure = true;
        return false;
      }) as Socket["write"];
      return injectedSocket;
    },
  });
  let client: Socket | undefined;
  let upstreamSocket: Socket | undefined;

  try {
    client = await openTunnel(proxy.host, proxy.port);
    upstreamSocket = await accepted;
    const backpressuredSocket = injectedSocket;
    if (backpressuredSocket === undefined) {
      throw new Error("proxy did not retain its injected upstream socket");
    }
    const first = Buffer.from([0x00, 0x01, 0x02]);
    const second = Buffer.from([0xfd, 0xfe, 0xff]);

    client.write(first);
    expect(await readExact(upstreamSocket, first.byteLength)).toEqual(first);
    expect(forcedBackpressure).toBeTrue();

    const sent = Promise.withResolvers<void>();
    client.write(second, (error) => {
      if (error) sent.reject(error);
      else sent.resolve();
    });
    await withDeadline(sent.promise, "writing after backpressure");
    const turn = Promise.withResolvers<void>();
    setImmediate(turn.resolve);
    await turn.promise;
    expect(upstreamSocket.read(1)).toBeNull();

    backpressuredSocket.emit("drain");
    expect(await readExact(upstreamSocket, second.byteLength)).toEqual(second);

    const echo = Buffer.concat([first, second]);
    upstreamSocket.write(echo);
    expect(await readExact(client, echo.byteLength)).toEqual(echo);
  } finally {
    client?.destroy();
    upstreamSocket?.destroy();
    await proxy.close();
    await closeServer(upstream);
  }
});
