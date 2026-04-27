import { describe, it, expect, vi } from "vitest";
import { ObserverPiece } from "../../pieces/observer";

type Sub = (msg: any) => void;

function makeBus() {
  const subs: Record<string, Sub[]> = {};
  const bus = {
    subscribe: (ch: string, cb: Sub) => {
      (subs[ch] ??= []).push(cb);
      return () => {};
    },
    emit: (ch: string, msg: any) => {
      for (const cb of subs[ch] ?? []) cb(msg);
    },
  };
  return bus;
}

describe("ObserverPiece", () => {
  it("emits turn on next user message", async () => {
    const onComplete = vi.fn();
    const piece = new ObserverPiece(onComplete);
    const bus = makeBus();
    await piece.start(bus as any);

    bus.emit("ai.request", { sessionId: "main", text: "first question" });
    bus.emit("ai.stream", { sessionId: "main", type: "text", text: "first " });
    bus.emit("ai.stream", { sessionId: "main", type: "text", text: "answer" });
    bus.emit("ai.request", { sessionId: "main", text: "second question" });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "main",
        user_message: "first question",
        assistant_response: "first answer",
        tool_calls: [],
      })
    );
  });

  it("buffers tool calls in current turn", async () => {
    const onComplete = vi.fn();
    const piece = new ObserverPiece(onComplete);
    const bus = makeBus();
    await piece.start(bus as any);

    bus.emit("ai.request", { sessionId: "main", text: "list files" });
    bus.emit("ai.stream", {
      sessionId: "main",
      type: "tool_done",
      tool: "list_dir",
      args: { path: "." },
      result: ["a", "b"],
    });
    bus.emit("ai.stream", {
      sessionId: "main",
      type: "tool_done",
      tool: "read_file",
      args: { path: "a" },
      result: "contents",
    });
    bus.emit("ai.stream", { sessionId: "main", type: "text", text: "done" });
    bus.emit("ai.request", { sessionId: "main", text: "next" });

    expect(onComplete).toHaveBeenCalledTimes(1);
    const turn = onComplete.mock.calls[0][0];
    expect(turn.tool_calls).toEqual([
      { tool: "list_dir", args: { path: "." }, result: ["a", "b"] },
      { tool: "read_file", args: { path: "a" }, result: "contents" },
    ]);
    expect(turn.assistant_response).toBe("done");
  });

  it("isolates buffers per session", async () => {
    const onComplete = vi.fn();
    const piece = new ObserverPiece(onComplete);
    const bus = makeBus();
    await piece.start(bus as any);

    bus.emit("ai.request", { sessionId: "alpha", text: "from alpha" });
    bus.emit("ai.request", { sessionId: "beta", text: "from beta" });
    bus.emit("ai.stream", { sessionId: "alpha", type: "text", text: "alpha-resp" });
    bus.emit("ai.stream", { sessionId: "beta", type: "text", text: "beta-resp" });

    // No flush yet (no second user msg per session)
    expect(onComplete).toHaveBeenCalledTimes(0);

    bus.emit("ai.request", { sessionId: "alpha", text: "alpha 2" });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      session_id: "alpha",
      user_message: "from alpha",
      assistant_response: "alpha-resp",
    });

    bus.emit("ai.request", { sessionId: "beta", text: "beta 2" });
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onComplete.mock.calls[1][0]).toMatchObject({
      session_id: "beta",
      user_message: "from beta",
      assistant_response: "beta-resp",
    });
  });

  it("flushes on stop()", async () => {
    const onComplete = vi.fn();
    const piece = new ObserverPiece(onComplete);
    const bus = makeBus();
    await piece.start(bus as any);

    bus.emit("ai.request", { sessionId: "main", text: "pending" });
    bus.emit("ai.stream", { sessionId: "main", type: "text", text: "partial" });

    expect(onComplete).toHaveBeenCalledTimes(0);
    await piece.stop();

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][0]).toMatchObject({
      session_id: "main",
      user_message: "pending",
      assistant_response: "partial",
    });
  });

  it("ignores stream messages with no open buffer", async () => {
    const onComplete = vi.fn();
    const piece = new ObserverPiece(onComplete);
    const bus = makeBus();
    await piece.start(bus as any);

    // No ai.request yet — these should be silently dropped
    bus.emit("ai.stream", { sessionId: "ghost", type: "text", text: "lost" });
    bus.emit("ai.stream", {
      sessionId: "ghost",
      type: "tool_done",
      tool: "x",
      args: {},
      result: null,
    });

    await piece.stop();
    expect(onComplete).toHaveBeenCalledTimes(0);
  });
});
