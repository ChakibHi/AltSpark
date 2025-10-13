import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, getSettings, setSettings } from "../../storage.js";

const chromeStub = globalThis.__chromeStub;

beforeEach(() => {
  chromeStub.__clearStorage();
});

describe("storage settings", () => {
  it("returns defaults when nothing stored", async () => {
    const settings = await getSettings();
    expect(settings).toStrictEqual(DEFAULT_SETTINGS);
  });

  it("merges partial updates and persists", async () => {
    await setSettings({ auditImages: false, autoModeEnabled: true });

    const stored = chromeStub.storage.sync._store.get("a11yCopyHelperSettings");
    expect(stored.auditImages).toBe(false);
    expect(stored.autoModeEnabled).toBe(true);

    const roundTrip = await getSettings();
    expect(roundTrip.auditImages).toBe(false);
    expect(roundTrip.autoModeEnabled).toBe(true);
    expect(roundTrip.auditLinks).toBe(true);
  });

  it("coerces legacy autoApplySafe flag into autoModeEnabled", async () => {
    await setSettings({ autoApplySafe: true });
    const roundTrip = await getSettings();
    expect(roundTrip.autoModeEnabled).toBe(true);
  });
});
