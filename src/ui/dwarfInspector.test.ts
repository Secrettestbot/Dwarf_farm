import { describe, it, expect } from "vitest";
import { mourningAgoPhrase, relationshipsHtml, FamilySnapshot } from "./dwarfInspector";

const EMPTY_FAMILY: FamilySnapshot = { parents: [], children: [], siblings: [] };

describe("mourningAgoPhrase recency bands", () => {
  it("reads as 'this season' for a fresh loss", () => {
    expect(mourningAgoPhrase(0)).toBe("lost this season");
  });

  it("counts seasons within the first year", () => {
    expect(mourningAgoPhrase(1)).toBe("lost a season ago");
    expect(mourningAgoPhrase(2)).toBe("lost 2 seasons ago");
    expect(mourningAgoPhrase(3)).toBe("lost 3 seasons ago");
  });

  it("rolls over to years past the fourth season", () => {
    expect(mourningAgoPhrase(4)).toBe("lost a year ago");
    expect(mourningAgoPhrase(8)).toBe("lost 2 years ago");
    expect(mourningAgoPhrase(13)).toBe("lost 3 years ago");
  });
});

describe("relationshipsHtml grouping", () => {
  it("renders nothing when the dwarf has no ties", () => {
    const html = relationshipsHtml({
      partnerName: null,
      mourning: null,
      family: EMPTY_FAMILY,
      grudgesRow: "",
    });
    expect(html).toBe("");
  });

  it("shows a RELATIONSHIPS header once any tie exists", () => {
    const html = relationshipsHtml({
      partnerName: "Doren",
      mourning: null,
      family: EMPTY_FAMILY,
      grudgesRow: "",
    });
    expect(html).toContain("RELATIONSHIPS");
    expect(html).toContain("Partnered with");
    expect(html).toContain("Doren");
  });

  it("surfaces the mourning line for a widowed dwarf", () => {
    const html = relationshipsHtml({
      partnerName: null,
      mourning: { name: "Kogan", seasonsSince: 2 },
      family: EMPTY_FAMILY,
      grudgesRow: "",
    });
    expect(html).toContain("Mourning");
    expect(html).toContain("Kogan");
    expect(html).toContain("lost 2 seasons ago");
  });

  it("a re-paired widow can show both a partner and (until cleared) a mourning line", () => {
    // The sim clears lostPartnerGrave on re-pair, but the inspector
    // renders whatever state it's handed — both lines coexist if both
    // are passed, so the grouping must not drop either.
    const html = relationshipsHtml({
      partnerName: "Tilda",
      mourning: { name: "Kogan", seasonsSince: 6 },
      family: EMPTY_FAMILY,
      grudgesRow: "",
    });
    expect(html).toContain("Partnered with");
    expect(html).toContain("Tilda");
    expect(html).toContain("Mourning");
    expect(html).toContain("lost a year ago");
  });

  it("includes family rows and a grudges row when present", () => {
    const html = relationshipsHtml({
      partnerName: null,
      mourning: null,
      family: { parents: [{ name: "Urist", status: "deceased" }], children: ["Sigrun"], siblings: [] },
      grudgesRow: `<div>feuding with <span>Mardak</span></div>`,
    });
    expect(html).toContain("Parents:");
    expect(html).toContain("Urist");
    expect(html).toContain("(deceased)");
    expect(html).toContain("Children:");
    expect(html).toContain("Sigrun");
    expect(html).toContain("feuding with");
    expect(html).toContain("Mardak");
  });
});
