import { describe, it, expect, vi, beforeEach } from "vitest";
import { Auditor } from "../../auditor.js";

describe("Auditor translation application", () => {
  beforeEach(() => {
    document.body.innerHTML = '<img id="target-image" width="200" height="200">';
    document.documentElement.setAttribute("lang", "en");
  });

  it("applies translated alt text when a preferred language variant exists", async () => {
    const img = document.getElementById("target-image");
    const ai = {
      detectLanguage: vi.fn().mockResolvedValue({ language: "en" }),
      summarizeText: vi.fn(async (_input, options) => (options?.type === "key-points" ? "Summary" : "Seed")),
      describeImageWithPrompt: vi.fn().mockResolvedValue(null),
      rewriteText: vi.fn().mockResolvedValue("Original alt text"),
      translateText: vi.fn().mockResolvedValue("Texte traduit"),
    };
    const settings = {
      auditImages: true,
      auditLinks: false,
      auditHeadings: false,
      offerTranslations: true,
      userLanguage: "fr",
    };

    const auditor = new Auditor(ai, settings);
    const report = await auditor.audit({ scope: "page", hintNodes: [img] });

    expect(report.images).toHaveLength(1);
    const issue = report.images[0];
    expect(issue.suggestion).toBe("Original alt text");
    expect(issue.translatedSuggestion).toBe("Texte traduit");

    issue.apply();

    expect(img?.getAttribute("alt")).toBe("Texte traduit");
    expect(img?.hasAttribute("aria-hidden")).toBe(false);
  });
});
