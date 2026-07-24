import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CONFIG_DEFAULTS, loadConfig } from "../src/shared/config.js";

const tmpFiles: string[] = [];

function writeConfigFile(content: unknown): string {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "delegate-config-")),
    "config.json",
  );
  fs.writeFileSync(file, JSON.stringify(content));
  tmpFiles.push(file);
  return file;
}

afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

describe("loadConfig", () => {
  it("returns defaults when no file or env is present", () => {
    const config = loadConfig({}, "/nonexistent/config.json");
    expect(config).toEqual(CONFIG_DEFAULTS);
  });

  it("file values override defaults", () => {
    const file = writeConfigFile({
      model: "my-model",
      stallSeconds: 60,
      permissionMode: "bypassPermissions",
    });
    const config = loadConfig({}, file);
    expect(config.model).toBe("my-model");
    expect(config.stallSeconds).toBe(60);
    expect(config.permissionMode).toBe("bypassPermissions");
    expect(config.baseUrl).toBe(CONFIG_DEFAULTS.baseUrl);
  });

  it("env values override file values", () => {
    const file = writeConfigFile({ model: "file-model", timeoutSeconds: 100 });
    const config = loadConfig(
      { DELEGATE_MODEL: "env-model", DELEGATE_TIMEOUT_SECONDS: "200" },
      file,
    );
    expect(config.model).toBe("env-model");
    expect(config.timeoutSeconds).toBe(200);
  });

  it("rejects malformed file values", () => {
    const file = writeConfigFile({ permissionMode: "yolo" });
    expect(() => loadConfig({}, file)).toThrow(/permissionMode/);
  });

  it("rejects non-integer env numbers", () => {
    expect(() =>
      loadConfig({ DELEGATE_STALL_SECONDS: "soon" }, "/nonexistent"),
    ).toThrow(/DELEGATE_STALL_SECONDS/);
  });
});
