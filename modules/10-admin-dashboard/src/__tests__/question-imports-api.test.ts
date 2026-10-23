// RW-97: uploadImportApi sends multipart FormData (file last, no caller content-type).
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../api.js", () => ({
  adminApi: vi.fn(),
  AdminApiError: class AdminApiError extends Error {
    constructor(public status: number, public apiError: { code: string; message: string }) { super(apiError.message); }
  },
}));

import { uploadImportApi } from "../api/question-imports.js";

afterEach(() => vi.unstubAllGlobals());

describe("uploadImportApi", () => {
  it("sends the append target only when a set is chosen (EXP-36), and the file stays last", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ importId: "i" }) });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["a,b"], "q.csv", { type: "text/csv" });
    await uploadImportApi({ file_name: "q.csv", format: "csv", file, domain: "security", target_pack_id: "p-1", target_level_position: 2 });
    const form = (fetchMock.mock.calls[0]! as [string, RequestInit])[1].body as FormData;
    expect(form.get("target_pack_id")).toBe("p-1");
    expect(form.get("target_level_position")).toBe("2");
    expect(form.has("pack_name")).toBe(false);
    const names: string[] = [];
    form.forEach((_v, k) => names.push(k));
    expect(names[names.length - 1]).toBe("file");
  });

  it("omits the target fields when creating a new set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ importId: "i" }) });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["a,b"], "q.csv", { type: "text/csv" });
    await uploadImportApi({ file_name: "q.csv", format: "csv", file, domain: "security" });
    const form = (fetchMock.mock.calls[0]! as [string, RequestInit])[1].body as FormData;
    expect(form.has("target_pack_id")).toBe(false);
    expect(form.has("target_level_position")).toBe(false);
  });

  it("posts FormData with the file last and no content-type header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ importId: "i" }) });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["a,b"], "q.csv", { type: "text/csv" });
    await uploadImportApi({ file_name: "q.csv", format: "csv", file, domain: "security", pack_name: "P" });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("/api/admin/super/question-imports");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.headers).toBeUndefined();
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const names: string[] = [];
    form.forEach((_v, k) => names.push(k));
    expect(names[names.length - 1]).toBe("file");
    expect(form.get("format")).toBe("csv");
    expect(form.get("domain")).toBe("security");
    expect(form.get("pack_name")).toBe("P");
  });

  it("maps a non-2xx response to AdminApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 413, statusText: "x", json: async () => ({ error: { code: "FILE_TOO_LARGE", message: "big" } }),
    }));
    const file = new File(["a"], "q.csv");
    await expect(uploadImportApi({ file_name: "q.csv", format: "csv", file, domain: "d" }))
      .rejects.toMatchObject({ status: 413, apiError: { code: "FILE_TOO_LARGE" } });
  });
});
