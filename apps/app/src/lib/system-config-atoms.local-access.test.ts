import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchHostStatus: vi.fn(),
  onConnected: vi.fn(
    (
      _listener: (event: {
        reconnected: boolean;
        disconnectedAt?: number;
      }) => void,
    ) =>
      () => {},
  ),
  fetchSdkSystemConfig: vi.fn(async () => ({
    hostDaemonPort: 38_887,
    localHelperPorts: [38_887, 38_888],
  })),
  fetchSystemConfig: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      hostDaemonPort: 38_887,
      localHelperPorts: [38_887, 38_888],
    }),
  })),
}));

vi.mock("./api-server", () => ({
  apiClient: {
    system: {
      config: {
        $get: mocks.fetchSystemConfig,
      },
    },
  },
}));

vi.mock("./api-host-daemon", () => ({
  fetchHostStatus: mocks.fetchHostStatus,
  fetchWorkspaceOpenTargets: vi.fn(async () => []),
}));

vi.mock("./sdk", () => ({
  sdk: {
    system: {
      config: mocks.fetchSdkSystemConfig,
    },
  },
}));

vi.mock("./bb-desktop", () => ({
  getBbDesktopInfo: () => null,
}));

vi.mock("./ws", () => ({
  wsManager: {
    getConnectionState: () => "connected",
    onChanged: () => () => {},
    onConnected: mocks.onConnected,
  },
}));

import {
  hostDaemonPortAtom,
  localHostDaemonAccessStateAtom,
  localHostStatusAtom,
  requestLocalHostDaemonAccessAtom,
} from "./system-config-atoms";
import { appQueryClient } from "./app-query-client";
import { sdk } from "./sdk";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";

beforeEach(() => {
  appQueryClient.clear();
  mocks.fetchHostStatus.mockReset();
  mocks.onConnected.mockClear();
  mocks.fetchSdkSystemConfig.mockClear();
  mocks.fetchSystemConfig.mockClear();
  vi.stubGlobal("window", {
    location: {
      hostname: "remote.getbb.app",
      origin: "https://remote.getbb.app",
    },
  });
  vi.stubGlobal("navigator", {
    permissions: {
      query: vi.fn(async () => ({ state: "prompt" })),
    },
    userAgent: "test",
  });
});

afterEach(() => {
  appQueryClient.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("local host daemon access atoms", () => {
  it("shares the system config request with the app query owner", async () => {
    const store = createStore();
    const query = appQueryClient.fetchQuery({
      queryKey: systemConfigQueryKey(),
      queryFn: ({ signal }) => sdk.system.config({ signal }),
      staleTime: 60_000,
    });

    await Promise.all([query, store.get(localHostDaemonAccessStateAtom)]);

    expect(
      mocks.fetchSdkSystemConfig.mock.calls.length +
        mocks.fetchSystemConfig.mock.calls.length,
    ).toBe(1);
  });

  it("does not restart status discovery on the initial server connection", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => ({ state: "granted" })),
      },
      userAgent: "test",
    });
    mocks.fetchHostStatus.mockResolvedValue({
      connected: true,
      hostId: "host-local",
      serverUrl: "https://remote.getbb.app",
    });
    const store = createStore();
    const unsubscribe = store.sub(localHostStatusAtom, () => {});

    await expect(store.get(localHostStatusAtom)).resolves.toMatchObject({
      hostId: "host-local",
    });
    for (const [listener] of mocks.onConnected.mock.calls) {
      listener({ reconnected: false });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("refreshes status discovery after a server reconnection", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => ({ state: "granted" })),
      },
      userAgent: "test",
    });
    mocks.fetchHostStatus.mockResolvedValue({
      connected: true,
      hostId: "host-local",
      serverUrl: "https://remote.getbb.app",
    });
    const store = createStore();
    const unsubscribe = store.sub(localHostStatusAtom, () => {});

    await expect(store.get(localHostStatusAtom)).resolves.toMatchObject({
      hostId: "host-local",
    });
    for (const [listener] of mocks.onConnected.mock.calls) {
      listener({ reconnected: true, disconnectedAt: Date.now() });
    }

    await vi.waitFor(() => {
      expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(4);
    });
    unsubscribe();
  });

  it("does not probe loopback while a remote page is in prompt state", async () => {
    const store = createStore();

    await expect(store.get(localHostDaemonAccessStateAtom)).resolves.toBe(
      "permission-required",
    );
    await expect(store.get(localHostStatusAtom)).resolves.toBeNull();
    expect(mocks.fetchHostStatus).not.toHaveBeenCalled();
  });

  it("probes every advertised helper port when access is explicitly requested", async () => {
    mocks.fetchHostStatus.mockResolvedValue(null);
    const store = createStore();

    await expect(store.set(requestLocalHostDaemonAccessAtom)).resolves.toBe(
      false,
    );
    expect(mocks.fetchHostStatus.mock.calls).toEqual([[38_887], [38_888]]);
  });

  it("keeps successful explicit access when permission queries are unsupported", async () => {
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => {
          throw new TypeError("unsupported permission");
        }),
      },
      userAgent: "test",
    });
    mocks.fetchHostStatus.mockResolvedValue({
      connected: true,
      hostId: "host-local",
      serverUrl: "https://remote.getbb.app",
    });
    const store = createStore();

    await expect(store.get(localHostDaemonAccessStateAtom)).resolves.toBe(
      "unsupported",
    );
    await expect(store.set(requestLocalHostDaemonAccessAtom)).resolves.toBe(
      true,
    );
    await expect(store.get(localHostDaemonAccessStateAtom)).resolves.toBe(
      "available",
    );
  });

  it("prefers the helper enrolled with the server serving the browser", async () => {
    mocks.fetchHostStatus.mockImplementation(async (port: number) => ({
      connected: true,
      hostId: port === 38_888 ? "host-browser-machine" : "host-primary",
      serverUrl:
        port === 38_888 ? "https://remote.getbb.app" : "http://127.0.0.1:38886",
    }));
    const store = createStore();

    await expect(store.set(requestLocalHostDaemonAccessAtom)).resolves.toBe(
      true,
    );
    await expect(store.get(hostDaemonPortAtom)).resolves.toBe(38_888);
    await expect(store.get(localHostStatusAtom)).resolves.toMatchObject({
      hostId: "host-browser-machine",
    });
  });

  it("retries unreachable helpers twice at one-second intervals", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", {
      permissions: {
        query: vi.fn(async () => ({ state: "granted" })),
      },
      userAgent: "test",
    });
    mocks.fetchHostStatus.mockResolvedValue(null);
    const store = createStore();

    const status = store.get(localHostStatusAtom);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(999);
    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(status).resolves.toBeNull();
    expect(mocks.fetchHostStatus).toHaveBeenCalledTimes(6);
  });
});
