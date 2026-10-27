import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  isRunningInsideDaemon,
  stopDaemon,
  restartDaemon,
} from "../src/cli/daemon-ctl.ts";

describe("Daemon Control & Suicide Prevention Guard", () => {
  const originalEnvDaemon = process.env.MINCLAW_IS_DAEMON;
  const originalEnvPid = process.env.MINCLAW_DAEMON_PID;

  beforeEach(() => {
    delete process.env.MINCLAW_IS_DAEMON;
    delete process.env.MINCLAW_DAEMON_PID;
  });

  afterEach(() => {
    if (originalEnvDaemon !== undefined) {
      process.env.MINCLAW_IS_DAEMON = originalEnvDaemon;
    } else {
      delete process.env.MINCLAW_IS_DAEMON;
    }
    if (originalEnvPid !== undefined) {
      process.env.MINCLAW_DAEMON_PID = originalEnvPid;
    } else {
      delete process.env.MINCLAW_DAEMON_PID;
    }
  });

  test("isRunningInsideDaemon returns false in normal CLI environment", () => {
    expect(isRunningInsideDaemon()).toBe(false);
  });

  test("isRunningInsideDaemon returns true when MINCLAW_IS_DAEMON is set to 1", () => {
    process.env.MINCLAW_IS_DAEMON = "1";
    expect(isRunningInsideDaemon()).toBe(true);
  });

  test("stopDaemon refuses to terminate when running inside daemon without force flag", async () => {
    process.env.MINCLAW_IS_DAEMON = "1";

    let errorLogged = false;
    const origError = console.error;
    console.error = (...args: any[]) => {
      errorLogged = true;
    };

    try {
      await stopDaemon();
      expect(errorLogged).toBe(true);
    } finally {
      console.error = origError;
    }
  });

  test("restartDaemon refuses to terminate when running inside daemon without force flag", async () => {
    process.env.MINCLAW_IS_DAEMON = "1";

    let errorLogged = false;
    const origError = console.error;
    console.error = (...args: any[]) => {
      errorLogged = true;
    };

    try {
      await restartDaemon();
      expect(errorLogged).toBe(true);
    } finally {
      console.error = origError;
    }
  });
});
