import { describe, expect, it } from "vitest";
import { acceptDisclaimer, acceptanceKey, defaultDisclaimer, disclaimerAccepted, resolveDisclaimer } from "../src/disclaimer.js";

describe("disclaimer", () => {
  it("is on by default, names the publisher, and can be switched off", () => {
    const d = resolveDisclaimer(undefined)!;
    expect(d.banner).toMatch(/^Demo environment: not for operational use/);
    expect(d.text.join(" ")).toContain("The publisher of this site does not manage this data");
    expect(d.print).toBe("DEMO: NOT FOR OPERATIONAL USE");
    expect(resolveDisclaimer(true)).toEqual(d);
    expect(resolveDisclaimer(false)).toBeUndefined();
    expect(resolveDisclaimer({ publisher: "Matdata" })!.text.join(" ")).toContain("Matdata does not manage this data and is not responsible for it");
    expect(resolveDisclaimer({ publisher: "Matdata" })!.text.join(" ")).toContain("Matdata accepts no liability");
  });

  it("takes configured wording and ignores empty parts", () => {
    const d = resolveDisclaimer({ banner: " Test instance ", title: "", text: ["Only this.", ""], print: "TEST" })!;
    expect(d.banner).toBe("Test instance");
    expect(d.title).toBe(defaultDisclaimer().title);
    expect(d.text).toEqual(["Only this."]);
    expect(d.print).toBe("TEST");
  });

  it("asks for a new acknowledgement when the wording changes", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    const d = defaultDisclaimer();
    expect(disclaimerAccepted(d, storage)).toBe(false);
    acceptDisclaimer(d, storage);
    expect(disclaimerAccepted(d, storage)).toBe(true);
    expect(acceptanceKey(d)).not.toBe(acceptanceKey({ ...d, title: "Other" }));
    expect(acceptanceKey(d)).toMatch(/^2026-10-17:/);
  });
});
