import { expect, test } from "bun:test";
import {
  DISCOVERY_SYNC_DEADLINE_MS,
  DISCOVERY_WEB_PROXY_TIMEOUT_MS,
} from "@jobhunter/pipeline/discovery-config";
import nextConfig from "../next.config";

test("the web proxy outlives the bounded discovery synchronization", () => {
  expect(DISCOVERY_SYNC_DEADLINE_MS).toBe(600_000);
  expect(DISCOVERY_WEB_PROXY_TIMEOUT_MS).toBe(660_000);
  expect(DISCOVERY_WEB_PROXY_TIMEOUT_MS).toBeGreaterThan(DISCOVERY_SYNC_DEADLINE_MS);
  expect(nextConfig.experimental?.proxyTimeout).toBe(DISCOVERY_WEB_PROXY_TIMEOUT_MS);
});
