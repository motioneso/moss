// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindUnselectedDraft,
  boundDraftKey,
  loadChatDrafts,
  saveChatDrafts
} from "../../apps/web/src/chat/chat-draft-storage.js";

describe("chat draft storage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("restores durable drafts only for their owner and never stores private drafts", () => {
    saveChatDrafts("owner-a", {
      "main-thread": "main draft",
      "side-thread": "side draft",
      __private__: "private draft"
    });

    expect(loadChatDrafts("owner-a")).toEqual({
      "main-thread": "main draft",
      "side-thread": "side draft"
    });
    expect(loadChatDrafts("owner-b")).toEqual({});
    expect(localStorage.getItem("moss.chatDrafts")).not.toContain("private draft");
  });

  it("keeps the owner and drafts bound when browser storage rejects a replacement", () => {
    saveChatDrafts("owner-a", { "main-thread": "first owner's draft" });
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string
    ) {
      // The old two-write implementation saved the new drafts, then failed while updating owner.
      // The atomic record write now fails before either half can replace the prior owner's record.
      if (value.includes("owner-b")) throw new Error("storage full");
      setItem.call(this, key, value);
    });

    saveChatDrafts("owner-b", { "side-thread": "second owner's draft" });

    expect(loadChatDrafts("owner-a")).toEqual({ "main-thread": "first owner's draft" });
    expect(loadChatDrafts("owner-b")).toEqual({});
  });

  it("keeps canonical and collided fallback drafts in separate thread-bound slots", () => {
    const firstCollision = bindUnselectedDraft(
      { "__surface__:module": "Fallback A", a: "Canonical A" },
      "module",
      "a"
    );
    const secondCollision = bindUnselectedDraft(
      { ...firstCollision, "__surface__:module": "Fallback B", b: "Canonical B" },
      "module",
      "b"
    );

    expect(secondCollision).toEqual({
      a: "Canonical A",
      b: "Canonical B",
      [boundDraftKey("module", "a")]: "Fallback A",
      [boundDraftKey("module", "b")]: "Fallback B"
    });
  });
});
