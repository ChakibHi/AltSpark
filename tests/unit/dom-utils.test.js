import { afterEach, describe, expect, it } from "vitest";
import { truncateText, normalizeElementList } from "../../dom-utils.js";

let mountedNodes = [];

function mount(node) {
  document.body.appendChild(node);
  mountedNodes.push(node);
  return node;
}

afterEach(() => {
  for (const node of mountedNodes.splice(0)) {
    node.remove();
  }
});

describe("truncateText", () => {
  it("returns input when shorter than limit", () => {
    expect(truncateText("hello", 10)).toBe("hello");
  });

  it("truncates and appends ellipsis by default", () => {
    const result = truncateText("abcdefghij", 6);
    expect(result).toBe("abc...");
  });

  it("honours custom options", () => {
    const result = truncateText("hello world", 7, { ellipsis: "--", trim: true });
    expect(result).toBe("hello--");
  });
});

describe("normalizeElementList", () => {
  it("filters non-elements and duplicates", () => {
    const host = mount(document.createElement("div"));
    const link = document.createElement("a");
    host.appendChild(link);

    const result = normalizeElementList([link, link, null, 42]);

    expect(result).toHaveLength(1);
    expect(result?.[0]).toBe(link);
  });

  it("returns null for empty input", () => {
    expect(normalizeElementList([])).toBeNull();
    expect(normalizeElementList(null)).toBeNull();
  });
});
