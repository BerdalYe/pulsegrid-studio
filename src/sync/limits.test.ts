import { describe, expect, it } from "vitest";

import { MAX_PROJECTS, QUOTA_BYTES, cloudUsage, formatBytes } from "./limits";

const rows = (count: number, size: number) => Array.from({ length: count }, () => ({ size_bytes: size }));

describe("cloudUsage", () => {
  it("counts projects and bytes", () => {
    const usage = cloudUsage(rows(3, 1024 * 1024));
    expect(usage.count).toBe(3);
    expect(usage.bytes).toBe(3 * 1024 * 1024);
    expect(usage.nearLimit).toBe(false);
    expect(usage.atLimit).toBe(false);
  });

  it("warns when projects are nearly used up", () => {
    expect(cloudUsage(rows(89, 1000)).nearLimit).toBe(false);
    expect(cloudUsage(rows(90, 1000)).nearLimit).toBe(true);
    expect(cloudUsage(rows(MAX_PROJECTS, 1000)).atLimit).toBe(true);
  });

  it("warns when storage is nearly used up, even with few projects", () => {
    const usage = cloudUsage(rows(2, QUOTA_BYTES * 0.46));
    expect(usage.nearLimit).toBe(true);
    expect(usage.atLimit).toBe(false);
    expect(cloudUsage(rows(2, QUOTA_BYTES / 2)).atLimit).toBe(true);
  });

  it("is empty for an empty cloud", () => {
    expect(cloudUsage([])).toMatchObject({ count: 0, bytes: 0, fullness: 0, nearLimit: false });
  });
});

describe("formatBytes", () => {
  it("shows sizes the way people read them", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(300)).toBe("1 KB");
    expect(formatBytes(310 * 1024)).toBe("310 KB");
    expect(formatBytes(4.2 * 1024 * 1024)).toBe("4.2 MB");
    expect(formatBytes(QUOTA_BYTES)).toBe("250 MB");
  });
});
