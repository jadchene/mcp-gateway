import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { Logger } from "./logger.ts";

/**
 * Watches one config file and emits debounced reload callbacks.
 */
export class ConfigFileWatcher {
  /**
   * Stores the config file path being watched.
   */
  private readonly configPath: string;

  /**
   * Stores the shared logger instance.
   */
  private readonly logger: Logger;

  /**
   * Stores the async callback used after debounced file changes.
   */
  private readonly onChange: () => Promise<void>;

  /**
   * Stores the debounce duration in milliseconds.
   */
  private readonly debounceMs: number;

  /**
   * Stores the active file watcher instance.
   */
  private watcher: FSWatcher | null = null;

  /**
   * Stores the debouncing timer used to collapse rapid save bursts.
   */
  private timer: NodeJS.Timeout | null = null;

  /**
   * Creates a watcher bound to one config file path.
   */
  public constructor(
    configPath: string,
    logger: Logger,
    onChange: () => Promise<void>,
    debounceMs = 250
  ) {
    this.configPath = configPath;
    this.logger = logger;
    this.onChange = onChange;
    this.debounceMs = debounceMs;
  }

  /**
   * Starts watching the config file.
   */
  public start(): void {
    if (this.watcher) {
      return;
    }

    const absolutePath = resolve(this.configPath);
    this.watcher = watch(absolutePath, () => {
      this.logger.info("config.file.changed", { configPath: absolutePath });
      this.scheduleReload();
    });
    this.watcher.on("error", (error) => {
      this.logger.error("config.file.watch_error", {
        configPath: absolutePath,
        message: error.message
      });
    });
  }

  /**
   * Stops watching the config file.
   */
  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * Schedules one debounced reload operation.
   */
  private scheduleReload(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.onChange();
    }, this.debounceMs);
  }
}
