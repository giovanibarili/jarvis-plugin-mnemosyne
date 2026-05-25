import type { CapabilityDefinition } from "@jarvis/core";
import type { MnemosyneStore } from "../store.js";
import type { Neo4jStatus } from "../neo4j-status.js";

export interface StatusState {
  lastNeo4jStatus: Neo4jStatus | null;
  graphDegraded: boolean;
}

/**
 * `mnemosyne_status` — report current Mnemosyne health.
 *
 * Receives a live `state` reference set by bootstrapAsync so it always
 * reflects the most recent probe result without module-level globals.
 */
export function buildMnemosyneStatusTool(
  store: MnemosyneStore,
  state?: StatusState
): CapabilityDefinition {
  return {
    name: "mnemosyne_status",
    description:
      "Report current Mnemosyne health: Neo4j status, graph degradation flag, and store counters. Use to diagnose memory system issues.",
    input_schema: { type: "object", properties: {} },
    handler: async () => {
      let shortCount = 0;
      let longCount = 0;
      try {
        shortCount = await store.chroma.count("short").catch(() => 0);
        longCount = await store.chroma.count("long").catch(() => 0);
      } catch {
        // chroma may be unavailable — report zeros
      }

      const s = state ?? { lastNeo4jStatus: null, graphDegraded: false };
      return {
        neo4j: s.lastNeo4jStatus
          ? {
              code: s.lastNeo4jStatus.code,
              message: s.lastNeo4jStatus.userMessage ?? "ok",
              remediation: s.lastNeo4jStatus.remediation ?? null,
            }
          : { code: "unknown", message: "Bootstrap not completed", remediation: null },
        graphDegraded: s.graphDegraded,
        store: {
          shortMemories: shortCount,
          longMemories: longCount,
          total: shortCount + longCount,
        },
      };
    },
  };
}
