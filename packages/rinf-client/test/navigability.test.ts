import { describe, expect, it } from "vitest";
import { navigability } from "@routebook/rinf-client";

describe("navigability", () => {
  it("reads Both, AB, BA and None", () => {
    const c = "http://data.europa.eu/949/concepts/navigabilities/";
    expect(navigability(`${c}Both`)).toEqual({ navigable: true });
    expect(navigability(`${c}AB`)).toEqual({ navigable: true, direction: "AB" });
    expect(navigability(`${c}BA`)).toEqual({ navigable: true, direction: "BA" });
    expect(navigability(`${c}None`)).toEqual({ navigable: false });
    expect(navigability(undefined)).toEqual({ navigable: false });
  });
});
