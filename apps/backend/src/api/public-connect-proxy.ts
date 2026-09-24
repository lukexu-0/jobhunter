import {
  createConnection,
  createServer,
  isIP,
  type Server,
  type Socket,
} from "node:net";

export interface ProxyAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ResolveProxyAddresses = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ProxyAddress[]>;

export type DialProxySocket = (
  address: ProxyAddress,
  signal: AbortSignal,
) => Promise<Socket>;

export interface PublicConnectProxyOptions {
  readonly signal: AbortSignal;
  readonly resolveAddresses: ResolveProxyAddresses;
  readonly dial?: DialProxySocket;
  readonly maxConcurrentTunnels?: number;
  readonly maxTotalTunnels?: number;
  readonly maxTotalBytes?: number;
  readonly maxHeaderBytes?: number;
  readonly socketIdleTimeoutMs?: number;
}

export interface PublicConnectProxy {
  readonly host: "127.0.0.1";
  readonly port: number;
  close(): Promise<void>;
}

const LOOPBACK_HOST = "127.0.0.1" as const;
const HTTPS_PORT = 443;
const DEFAULT_MAX_CONCURRENT_TUNNELS = 32;
const DEFAULT_MAX_TOTAL_TUNNELS = 256;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 15_000;
const FORBIDDEN_RESPONSE = Buffer.from(
  "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  "ascii",
);
const CONNECTED_RESPONSE = Buffer.from(
  "HTTP/1.1 200 Connection Established\r\n\r\n",
  "ascii",
);
const HEADER_TERMINATOR = Buffer.from("\r\n\r\n", "ascii");
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function parseDnsConnectRequest(header: Buffer): string | undefined {
  const lines = header.subarray(0, header.byteLength - HEADER_TERMINATOR.byteLength)
    .toString("latin1")
    .split("\r\n");
  const requestLine = lines.shift();
  const match = requestLine?.match(/^CONNECT ([A-Za-z0-9.-]+):443 HTTP\/1\.1$/);
  if (!match) return undefined;

  const hostname = match[1]!;
  const nameWithoutFinalDot = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (
    nameWithoutFinalDot.length === 0
    || nameWithoutFinalDot.length > 253
    || isIP(nameWithoutFinalDot) !== 0
    || /^[0-9.]+$/.test(nameWithoutFinalDot)
    || !nameWithoutFinalDot.split(".").every((label) => DNS_LABEL.test(label))
  ) {
    return undefined;
  }

  for (const line of lines) {
    const colon = line.indexOf(":");
    if (
      colon <= 0
      || !HEADER_NAME.test(line.slice(0, colon))
      || !HEADER_VALUE.test(line.slice(colon + 1))
    ) {
      return undefined;
    }
  }

  return hostname.toLowerCase();
}

function normalizedAddresses(addresses: readonly ProxyAddress[]): readonly ProxyAddress[] | undefined {
  if (!Array.isArray(addresses) || addresses.length === 0) return undefined;
  const normalized: ProxyAddress[] = [];
  const seen = new Set<string>();
  for (const candidate of addresses) {
    if (
      !candidate
      || (candidate.family !== 4 && candidate.family !== 6)
      || isIP(candidate.address) !== candidate.family
    ) {
      return undefined;
    }
    const key = `${candidate.family}:${candidate.address}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ address: candidate.address, family: candidate.family });
    }
  }
  return normalized;
}

function defaultDial(address: ProxyAddress, signal: AbortSignal): Promise<Socket> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const socket = createConnection({ host: address.address, port: HTTPS_PORT });
  const { promise, resolve, reject } = Promise.withResolvers<Socket>();
  let settled = false;

  const cleanup = (): void => {
    socket.off("connect", onConnect);
    socket.off("error", onError);
    signal.removeEventListener("abort", onAbort);
  };
  const onConnect = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(socket);
  };
  const onError = (error: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    socket.destroy();
    reject(abortReason(signal));
  };

  socket.once("connect", onConnect);
  socket.once("error", onError);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return promise;
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let settled = false;
  const done = (): void => {
    if (settled) return;
    settled = true;
    server.off("close", done);
    resolve();
  };
  server.once("close", done);
  try {
    server.close(done);
  } catch {
    done();
  }
  return promise;
}

export async function startPublicConnectProxy(
  options: PublicConnectProxyOptions,
): Promise<PublicConnectProxy> {
  if (options.signal.aborted) throw abortReason(options.signal);

  const maxConcurrentTunnels = positiveInteger(
    options.maxConcurrentTunnels,
    DEFAULT_MAX_CONCURRENT_TUNNELS,
    "maxConcurrentTunnels",
  );
  const maxTotalTunnels = positiveInteger(
    options.maxTotalTunnels,
    DEFAULT_MAX_TOTAL_TUNNELS,
    "maxTotalTunnels",
  );
  const maxTotalBytes = positiveInteger(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    "maxTotalBytes",
  );
  const maxHeaderBytes = positiveInteger(
    options.maxHeaderBytes,
    DEFAULT_MAX_HEADER_BYTES,
    "maxHeaderBytes",
  );
  const socketIdleTimeoutMs = positiveInteger(
    options.socketIdleTimeoutMs,
    DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
    "socketIdleTimeoutMs",
  );
  const dial = options.dial ?? defaultDial;
  const lifecycle = new AbortController();
  const operationSignal = AbortSignal.any([options.signal, lifecycle.signal]);
  const clients = new Set<Socket>();
  const upstreams = new Set<Socket>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let totalTunnels = 0;
  let totalBytes = 0;

  const server = createServer({ allowHalfOpen: true });

  const shutdown = (reason: unknown): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    lifecycle.abort(reason);
    for (const socket of clients) socket.destroy();
    for (const socket of upstreams) socket.destroy();
    closePromise = closeServer(server).finally(() => {
      options.signal.removeEventListener("abort", onAbort);
      for (const socket of clients) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      clients.clear();
      upstreams.clear();
    });
    return closePromise;
  };

  const onAbort = (): void => {
    void shutdown(abortReason(options.signal));
  };

  server.on("connection", (client) => {
    client.on("error", () => {});
    client.setNoDelay(true);
    client.setTimeout(socketIdleTimeoutMs, () => client.destroy());
    clients.add(client);
    client.once("close", () => clients.delete(client));

    const rejectClient = (): void => {
      if (client.destroyed) return;
      client.pause();
      client.end(FORBIDDEN_RESPONSE, () => client.destroy());
    };

    if (closing || clients.size > maxConcurrentTunnels || totalTunnels >= maxTotalTunnels) {
      rejectClient();
      return;
    }

    let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let requestComplete = false;

    const onPrematureEnd = (): void => {
      if (!requestComplete) rejectClient();
    };

    const establishTunnel = async (hostname: string, initialPayload: Buffer): Promise<void> => {
      let addresses: readonly ProxyAddress[] | undefined;
      try {
        addresses = normalizedAddresses(
          await options.resolveAddresses(hostname, operationSignal),
        );
      } catch {
        rejectClient();
        return;
      }
      if (closing || operationSignal.aborted || client.destroyed || addresses === undefined) {
        if (!closing && !operationSignal.aborted) rejectClient();
        else client.destroy();
        return;
      }

      let upstream: Socket | undefined;
      for (const address of addresses) {
        if (closing || operationSignal.aborted || client.destroyed) break;
        try {
          const candidate = await dial(address, operationSignal);
          if (closing || operationSignal.aborted || client.destroyed || candidate.destroyed) {
            candidate.destroy();
            continue;
          }
          upstream = candidate;
          break;
        } catch {
          // A later independently validated address may still be reachable.
        }
      }

      if (upstream === undefined) {
        if (!closing && !operationSignal.aborted) rejectClient();
        else client.destroy();
        return;
      }

      upstreams.add(upstream);
      upstream.setNoDelay(true);
      upstream.setTimeout(socketIdleTimeoutMs, () => upstream!.destroy());
      upstream.on("error", () => {});
      upstream.once("close", () => upstreams.delete(upstream!));

      let tunnelClosed = false;
      const closeTunnel = (): void => {
        if (tunnelClosed) return;
        tunnelClosed = true;
        client.destroy();
        upstream!.destroy();
      };
      const forward = (source: Socket, target: Socket, chunk: Buffer): void => {
        if (tunnelClosed || chunk.byteLength === 0) return;
        const remaining = maxTotalBytes - totalBytes;
        if (chunk.byteLength > remaining) {
          closeTunnel();
          return;
        }
        totalBytes += chunk.byteLength;
        const exhausted = totalBytes === maxTotalBytes;
        const writable = exhausted
          ? target.write(chunk, closeTunnel)
          : target.write(chunk);
        if (exhausted) {
          client.pause();
          upstream!.pause();
        } else if (!writable) {
          source.pause();
          target.once("drain", () => {
            if (!tunnelClosed && !source.destroyed) source.resume();
          });
        }
      };

      client.on("data", (chunk: Buffer) => forward(client, upstream!, chunk));
      upstream.on("data", (chunk: Buffer) => forward(upstream!, client, chunk));
      client.once("end", () => upstream!.end());
      upstream.once("end", () => client.end());
      client.once("error", closeTunnel);
      upstream.once("error", closeTunnel);
      client.once("close", closeTunnel);
      upstream.once("close", closeTunnel);

      client.write(CONNECTED_RESPONSE);
      if (initialPayload.byteLength > 0) forward(client, upstream, initialPayload);
      if (!tunnelClosed && totalBytes < maxTotalBytes) client.resume();
    };

    const readHeader = (chunk: Buffer): void => {
      client.pause();
      if (requestComplete || closing) {
        if (closing) client.destroy();
        return;
      }
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      const terminatorIndex = pending.indexOf(HEADER_TERMINATOR);
      if (terminatorIndex < 0) {
        if (pending.byteLength > maxHeaderBytes) {
          requestComplete = true;
          rejectClient();
        } else {
          client.resume();
        }
        return;
      }

      const headerLength = terminatorIndex + HEADER_TERMINATOR.byteLength;
      requestComplete = true;
      client.off("data", readHeader);
      client.off("end", onPrematureEnd);
      if (headerLength > maxHeaderBytes) {
        rejectClient();
        return;
      }
      const hostname = parseDnsConnectRequest(pending.subarray(0, headerLength));
      if (hostname === undefined || totalTunnels >= maxTotalTunnels) {
        rejectClient();
        return;
      }
      totalTunnels += 1;
      const initialPayload = pending.subarray(headerLength);
      pending = Buffer.alloc(0);
      void establishTunnel(hostname, initialPayload);
    };

    client.on("data", readHeader);
    client.on("end", onPrematureEnd);
    client.resume();
  });

  const startup = Promise.withResolvers<void>();
  const onStartupError = (error: Error): void => startup.reject(error);
  const onListening = (): void => startup.resolve();
  server.once("error", onStartupError);
  server.once("listening", onListening);
  options.signal.addEventListener("abort", onAbort, { once: true });

  let rejectStartupForAbort: ((reason: unknown) => void) | undefined;
  const startupAbort = new Promise<never>((_resolve, reject) => {
    rejectStartupForAbort = reject;
  });
  void startupAbort.catch(() => {});
  const abortDuringStartup = (): void => {
    const reason = abortReason(options.signal);
    rejectStartupForAbort?.(reason);
    onAbort();
  };
  options.signal.removeEventListener("abort", onAbort);
  options.signal.addEventListener("abort", abortDuringStartup, { once: true });

  try {
    if (options.signal.aborted) throw abortReason(options.signal);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true });
    await Promise.race([startup.promise, startupAbort]);
  } catch (error) {
    await shutdown(error);
    throw error;
  } finally {
    server.off("error", onStartupError);
    server.off("listening", onListening);
    options.signal.removeEventListener("abort", abortDuringStartup);
  }

  rejectStartupForAbort = undefined;
  if (closing || options.signal.aborted) {
    const reason = abortReason(options.signal);
    await shutdown(reason);
    throw reason;
  }
  options.signal.addEventListener("abort", onAbort, { once: true });
  server.on("error", onAbort);

  const address = server.address();
  if (address === null || typeof address === "string") {
    const error = new Error("public CONNECT proxy did not bind a TCP address");
    await shutdown(error);
    throw error;
  }

  return {
    host: LOOPBACK_HOST,
    port: address.port,
    close: () => shutdown(new DOMException("The proxy was closed", "AbortError")),
  };
}
