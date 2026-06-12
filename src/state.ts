import { LOG_RING_CAPACITY } from "./constants.js";
import { EngineLogManager } from "./services/engine.js";
import { GameProcessManager } from "./services/processes.js";

/** Process-wide singletons shared across tool invocations. */
export const games = new GameProcessManager(LOG_RING_CAPACITY);
export const engineLogs = new EngineLogManager();

export async function shutdown(): Promise<void> {
  engineLogs.disconnectAll();
  await games.stopAll();
}
