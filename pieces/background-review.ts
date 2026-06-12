/**
 * @module pieces/background-review
 *
 * BackgroundReviewPiece — periodic cognitive curation loop for Mnemosyne.
 *
 * WHY this piece exists:
 *   The encoder piece processes every turn eagerly. But extraction quality
 *   degrades when done in-band — the LLM is in "assistant mode", not
 *   "observer mode". A separate, asynchronous review pass on a copy-on-write
 *   fork gives the hermes-reviewer role a clean view of the conversation
 *   with no in-flight state contamination.
 *
 * Design decisions:
 *
 *   D1. ANTI-LOOP GUARD — `REVIEW_SOURCES` set.
 *       The review itself produces ai.request/ai.stream events tagged with
 *       source "background-review". Without filtering, those events would
 *       increment the turn counter and trigger another review → infinite loop.
 *       Any source in REVIEW_SOURCES is silently ignored.
 *
 *   D2. CADENCE GATE — turn counter per session.
 *       We accumulate `turnCount[sessionId]` on every qualifying turn.
 *       When count >= reviewEveryNTurns we fire and reset. This is the
 *       primary trigger; the idle timer is the secondary trigger.
 *
 *   D3. IDLE TRIGGER — session-keyed timers.
 *       A debounced timer fires after `idleTriggerMinutes` of inactivity.
 *       Re-armed on every qualifying turn. Fires only if the session has at
 *       least 1 turn counted since last review (avoids re-firing repeatedly
 *       on a cold session).
 *
 *   D4. ANTI-SPAM — `activeReviews` Set.
 *       A session in this set is currently under review. Subsequent triggers
 *       are dropped until the review completes (success or timeout). Without
 *       this gate the idle timer could stack reviews for slow sessions.
 *
 *   D5. FORK via `(ctx.sessionManager as any).fork()`.
 *       `fork()` is on the concrete SessionManager class, not the public
 *       SessionManager interface (packages/core/src/ai.ts). The plugin-manager
 *       passes the real class instance cast as `as unknown as SessionManager`,
 *       so the method is available at runtime. We cast again here to call it.
 *       This is intentional tech debt — a future public interface update will
 *       add fork() to SessionManager and remove the cast.
 *
 *   D6. PROMPT DELIVERY via bus ai.request.
 *       We publish directly to the fork session ID. JarvisCore routes any
 *       target — not just "main" — via SessionManager.get(). The fork session
 *       is pre-seeded with the source's history, so the LLM receives the full
 *       context without rehydration.
 *
 *   D7. COMPLETION DETECTION via ai.stream "complete" + "aborted" + "error".
 *       We subscribe to ai.stream filtered by target===reviewSessionId. The
 *       first terminal event resolves our completion promise. A hard timeout
 *       (timeoutSeconds) guards against hung sessions.
 *
 *   D8. CLEANUP — sessions.close(reviewSessionId) after every review.
 *       Fork sessions are ephemeral (never persisted). close() removes them
 *       from the session map, releasing memory. Must always run — hence the
 *       try/finally pattern.
 *
 *   D9. TIER 1 PREAMBLE injected in the prompt.
 *       We read `store.getAttentionState(sourceSessionId)` and build the
 *       [HERMES REVIEW] prefix. This gives the reviewer its Tier 1 context
 *       (active domains/entities/categories) without requiring a tool call.
 *
 *   D10. SESSION_EXCLUDE filter matches the retriever injector.
 *        The forked session ID starts with "hermes-review-" — excluded from
 *        Mnemosyne injection (SESSION_EXCLUDE = /mnemosyne-skip/ in index.ts).
 *        We additionally suppress via fork()'s R2 (setContextInjector no-op).
 */

import type { Piece, EventBus } from "@jarvis/core";
import type { MnemosyneStore } from "../lib/store.js";
import type { AttentionState } from "../lib/types.js";
import { log } from "../lib/log.js";
import { v4 as uuidv4 } from "uuid";

/** Sources that identify machine-generated turns. Must never trigger a review. */
const REVIEW_SOURCES = new Set([
  "background-review",
  "cron",
  "hermes-reviewer",
  "mnemosyne-background-review",
  "mnemosyne",
]);

export interface BackgroundReviewConfig {
  /** Master switch — piece is inert when false. Default: false. */
  enabled: boolean;
  /**
   * Trigger a review after this many completed turns per session.
   * Default: 5.
   */
  reviewEveryNTurns?: number;
  /**
   * Trigger a review if the session has been idle for this many minutes
   * with at least one un-reviewed turn. Default: 5.
   */
  idleTriggerMinutes?: number;
  /**
   * Hard timeout for a single review run (seconds). Default: 60.
   * After this, the fork is closed and activeReviews is cleared so the
   * next trigger can start a fresh review.
   */
  timeoutSeconds?: number;
}

/**
 * BackgroundReviewPiece
 *
 * Listens to `system.event: turn.summary`, counts qualified turns per session,
 * and periodically forks the session to run the hermes-reviewer LLM against
 * the full conversation history.
 */
export class BackgroundReviewPiece implements Piece {
  readonly id = "mnemosyne-background-review";
  readonly name = "Mnemosyne Background Review";

  private bus!: EventBus;
  private unsubs: Array<() => void> = [];

  /** Qualified turns since last review, per session. */
  private turnCount: Map<string, number> = new Map();
  /** Review history for the HUD — last 50 reviews. */
  readonly _reviewHistory: Array<{ sessionId: string; turn: number; l1: number; l2: number; edges: number; savedAt: number }> = [];

  /**
   * Sessions currently under review. Triggers for sessions in this set are
   * dropped to prevent concurrent reviews (D4).
   */
  private activeReviews: Set<string> = new Set();

  /** Debounce timers for idle trigger, per session (D3). */
  private idleTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    private store: MnemosyneStore,
    private ctx: { bus: EventBus; sessionManager?: unknown },
    private config: BackgroundReviewConfig
  ) {}

  async start(bus: EventBus): Promise<void> {
    this.bus = bus;

    if (!this.config.enabled) {
      log.info({ id: this.id }, "BackgroundReviewPiece: disabled, not subscribing");
      return;
    }

    // Subscribe to turn.summary events (system.event channel per core contract)
    this.unsubs.push(
      bus.subscribe("system.event", (msg: any) => {
        if (msg.event !== "turn.summary") return;
        this.onTurnSummary(msg.data);
      })
    );

    log.info(
      {
        id: this.id,
        reviewEveryNTurns: this.reviewEveryNTurns,
        idleTriggerMinutes: this.idleTriggerMinutes,
        timeoutSeconds: this.timeoutSeconds,
      },
      "BackgroundReviewPiece: started"
    );
  }

  async stop(): Promise<void> {
    for (const u of this.unsubs) u();
    this.unsubs = [];

    // Clear all pending idle timers
    for (const [, timer] of this.idleTimers) clearTimeout(timer);
    this.idleTimers.clear();

    log.info({ id: this.id }, "BackgroundReviewPiece: stopped");
  }

  // ---------------------------------------------------------------------------
  // Config accessors with defaults
  // ---------------------------------------------------------------------------

  private get reviewEveryNTurns(): number {
    return (this.config.reviewEveryNTurns ?? 5);
  }

  private get idleTriggerMinutes(): number {
    return (this.config.idleTriggerMinutes ?? 5);
  }

  private get timeoutSeconds(): number {
    return (this.config.timeoutSeconds ?? 60);
  }

  // ---------------------------------------------------------------------------
  // Event handler
  // ---------------------------------------------------------------------------

  /**
   * Called for every `system.event: turn.summary` message.
   * Applies the anti-loop guard (D1) then increments the cadence counter and
   * re-arms the idle timer.
   */
  private onTurnSummary(summary: {
    sessionId: string;
    source: string;
    outcome: string;
    traceId: string;
  }): void {
    const { sessionId, source, outcome } = summary;

    // D1: anti-loop guard — ignore our own reviews and internal machine turns
    if (REVIEW_SOURCES.has(source)) {
      log.debug({ id: this.id, source, sessionId }, "BackgroundReviewPiece: skipping machine-sourced turn");
      return;
    }

    // Only process completed turns — aborted/error turns don't contain
    // full conversation content worth reviewing.
    if (outcome !== "completed") {
      log.debug({ id: this.id, outcome, sessionId }, "BackgroundReviewPiece: skipping non-completed turn");
      return;
    }

    // Increment turn counter
    const prev = this.turnCount.get(sessionId) ?? 0;
    const next = prev + 1;
    this.turnCount.set(sessionId, next);

    log.debug({ id: this.id, sessionId, turnCount: next, threshold: this.reviewEveryNTurns }, "BackgroundReviewPiece: turn counted");

    // D2: cadence gate — fire when we hit the threshold
    if (next >= this.reviewEveryNTurns) {
      this.turnCount.set(sessionId, 0);
      this.clearIdleTimer(sessionId);
      log.info({ id: this.id, sessionId, reason: "cadence" }, "BackgroundReviewPiece: review triggered (cadence)");
      this.triggerReview(sessionId, summary.traceId, "cadence").catch((err) => {
        log.error({ id: this.id, sessionId, err: String(err) }, "BackgroundReviewPiece: review error (cadence)");
      });
      return;
    }

    // D3: re-arm idle timer
    this.armIdleTimer(sessionId, summary.traceId);
  }

  // ---------------------------------------------------------------------------
  // Idle timer (D3)
  // ---------------------------------------------------------------------------

  private armIdleTimer(sessionId: string, traceId: string): void {
    this.clearIdleTimer(sessionId);
    const ms = this.idleTriggerMinutes * 60 * 1000;
    const timer = setTimeout(() => {
      this.idleTimers.delete(sessionId);
      const count = this.turnCount.get(sessionId) ?? 0;
      if (count === 0) {
        // Nothing accumulated since last review — skip
        return;
      }
      this.turnCount.set(sessionId, 0);
      log.info({ id: this.id, sessionId, count, reason: "idle" }, "BackgroundReviewPiece: review triggered (idle)");
      this.triggerReview(sessionId, traceId, "idle").catch((err) => {
        log.error({ id: this.id, sessionId, err: String(err) }, "BackgroundReviewPiece: review error (idle)");
      });
    }, ms);
    this.idleTimers.set(sessionId, timer);
  }

  private clearIdleTimer(sessionId: string): void {
    const existing = this.idleTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(sessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Core review orchestration (D5, D6, D7, D8, D9)
  // ---------------------------------------------------------------------------

  /**
   * Forks the source session, sends the cognitive curation prompt to the fork,
   * waits for completion, then closes the fork.
   *
   * @param sourceSessionId - the user-facing session to review
   * @param traceId         - trace ID of the turn that triggered this review
   * @param reason          - "cadence" | "idle" — for logging
   */
  private async triggerReview(
    sourceSessionId: string,
    traceId: string,
    reason: string
  ): Promise<void> {
    // D4: anti-spam — drop if already reviewing this session
    if (this.activeReviews.has(sourceSessionId)) {
      log.info({ id: this.id, sourceSessionId, reason }, "BackgroundReviewPiece: review skipped (already active)");
      return;
    }
    this.activeReviews.add(sourceSessionId);

    // Unique review session ID — short enough for logs but unique enough to
    // avoid collisions if multiple sessions are reviewed simultaneously.
    const reviewSessionId = `hermes-review-${sourceSessionId}-${uuidv4().slice(0, 8)}`;

    log.info({ id: this.id, sourceSessionId, reviewSessionId, reason, traceId }, "BackgroundReviewPiece: starting review");

    try {
      // D5: fork the source session
      const sessions = this.ctx.sessionManager as any;
      if (!sessions || typeof sessions.fork !== "function") {
        log.error({ id: this.id, sourceSessionId }, "BackgroundReviewPiece: sessionManager.fork not available — cannot review");
        return;
      }

      sessions.fork(sourceSessionId, reviewSessionId);
      log.debug({ id: this.id, reviewSessionId }, "BackgroundReviewPiece: fork created");

      // D9: build tier 1 preamble from attention state
      const prompt = this.buildPrompt(sourceSessionId, traceId);

      // D6: send prompt into the fork session via bus
      this.bus.publish({
        channel: "ai.request",
        source: "background-review",
        target: reviewSessionId,
        text: prompt,
      } as any);

      // D7: wait for completion or timeout
      await this.waitForCompletion(reviewSessionId);

      log.info({ id: this.id, sourceSessionId, reviewSessionId }, "BackgroundReviewPiece: review complete");
    } catch (err) {
      log.error({ id: this.id, sourceSessionId, reviewSessionId, err: String(err) }, "BackgroundReviewPiece: review failed");
    } finally {
      // D8: always close the fork session
      try {
        const sessions = this.ctx.sessionManager as any;
        if (sessions && typeof sessions.close === "function") {
          sessions.close(reviewSessionId);
          log.debug({ id: this.id, reviewSessionId }, "BackgroundReviewPiece: fork closed");
        }
      } catch (closeErr) {
        // Non-fatal — the session may have already been closed or never opened
        log.warn({ id: this.id, reviewSessionId, err: String(closeErr) }, "BackgroundReviewPiece: fork close warning");
      }
      this.activeReviews.delete(sourceSessionId);
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt builder (D9)
  // ---------------------------------------------------------------------------

  /**
   * Builds the classification prompt with the Tier 1 preamble.
   * The preamble substitutes the {{...}} placeholders in hermes-reviewer.md
   * so the reviewer starts with correct attention state context.
   */
  private buildPrompt(sessionId: string, traceId: string): string {
    const attention: AttentionState | undefined = this.store.getAttentionState(sessionId);

    const domains = attention?.active_domains?.join(", ") || "(none declared yet)";
    const entities = attention?.active_entities?.join(", ") || "(none)";
    const categories = attention?.active_categories?.join(", ") || "(none)";

    return [
      `[HERMES REVIEW — session: ${sessionId}, traceId: ${traceId}]`,
      "",
      "## Current session attention (Tier 1)",
      `Active domains:    ${domains}`,
      `Active entities:   ${entities}`,
      `Active categories: ${categories}`,
      "",
      "Review the conversation above and apply the cognitive curation protocol.",
    ].join("\n");
  }

  // ---------------------------------------------------------------------------
  // Completion waiter (D7)
  // ---------------------------------------------------------------------------

  /**
   * Returns a Promise that resolves when the review session emits a terminal
   * ai.stream event (complete, aborted, error) or the timeout fires.
   *
   * WHY listen on ai.stream instead of system.event turn.summary:
   *   turn.summary is emitted by the TurnTracker at close — but the fork
   *   session has `source: "background-review"` which our own onTurnSummary
   *   handler would filter (D1 is correct behavior). Listening directly on
   *   ai.stream for the specific reviewSessionId is more precise and avoids
   *   re-entrant logic.
   */
  private waitForCompletion(reviewSessionId: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;

      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        unsub();
        resolve();
      };

      // Hard timeout guard
      const timeoutHandle = setTimeout(() => {
        log.warn({ id: this.id, reviewSessionId, timeoutSeconds: this.timeoutSeconds }, "BackgroundReviewPiece: review timed out");
        settle();
      }, this.timeoutSeconds * 1000);

      // Subscribe to terminal ai.stream events for the review session
      const unsub = this.bus.subscribe("ai.stream", (msg: any) => {
        // Only care about events from our fork session
        if (msg.target !== reviewSessionId && msg.sessionId !== reviewSessionId) return;

        const ev = msg.event;
        if (ev === "complete" || ev === "aborted" || ev === "error") {
          log.debug({ id: this.id, reviewSessionId, event: ev }, "BackgroundReviewPiece: review stream terminal");
          settle();
        }
      });
    });
  }
}
