import { describe, expect, it } from "bun:test";
import { cancelTurn, startTurn, turnOwner } from "~/api/v1/chat.handler";

describe("chat turns", () => {
  const owner = turnOwner({ userId: "user-1", anonymousUserId: "anon-1" });
  const stranger = turnOwner({ userId: null, anonymousUserId: "anon-2" });

  it("only lets the owner stop a running turn", () => {
    const turnId = crypto.randomUUID();
    const turn = startTurn(turnId, owner);

    expect(cancelTurn(turnId, stranger)).toBe(false);
    expect(turn.signal.aborted).toBe(false);

    expect(cancelTurn(turnId, owner)).toBe(true);
    expect(turn.signal.aborted).toBe(true);
    // Already gone: a second Stop is a no-op.
    expect(cancelTurn(turnId, owner)).toBe(false);
  });

  it("forgets a finished turn", () => {
    const turnId = crypto.randomUUID();
    const turn = startTurn(turnId, owner);
    turn.end();
    expect(cancelTurn(turnId, owner)).toBe(false);
    expect(turn.signal.aborted).toBe(false);
  });

  it("identifies anonymous owners by their browser id", () => {
    expect(stranger).toBe("anon:anon-2");
    expect(owner).toBe("user-1");
  });
});

describe("citation markers", () => {
  it("drops file-search markers, finished or cut off", async () => {
    const { stripCitationMarkers } = await import("~/utils/chat.utils");
    expect(
      stripCitationMarkers(
        "Se föreläsningen. fileciteturn0file1turn0file5 Klart.",
      ),
    ).toBe("Se föreläsningen.  Klart.");
    expect(stripCitationMarkers("Slut filecitetur")).toBe("Slut ");
    expect(stripCitationMarkers("Vanlig text $x^2$")).toBe("Vanlig text $x^2$");
  });
});
