import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: "DBG",
  info: "INF",
  warn: "WRN",
  error: "ERR",
};

export class Logger {
  private context: string;
  private minLevel: LogLevel;

  constructor(context: string, minLevel: LogLevel = "info") {
    this.context = context;
    this.minLevel = minLevel;
  }

  child(context: string): Logger {
    return new Logger(`${this.context}:${context}`, this.minLevel);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>): void {
    this.log("info", msg, data);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.log("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.log("error", msg, data);
  }

  private log(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const color = LEVEL_COLORS[level];
    const label = LEVEL_LABELS[level];
    const time = new Date().toISOString().slice(11, 23);
    const ctx = chalk.dim(`[${this.context}]`);

    let line = `${chalk.dim(time)} ${color(label)} ${ctx} ${msg}`;

    if (data) {
      const pairs = Object.entries(data)
        .map(([k, v]) => `${chalk.dim(k)}=${formatValue(v)}`)
        .join(" ");
      line += ` ${pairs}`;
    }

    console.log(line);
  }
}

function formatValue(v: unknown): string {
  if (typeof v === "number") return chalk.cyan(v.toString());
  if (typeof v === "string") return chalk.green(`"${v}"`);
  if (typeof v === "boolean") return chalk.magenta(v.toString());
  return JSON.stringify(v);
}

// Global logger instance
export const logger = new Logger("arcti");
