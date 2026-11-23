/**
 * Client-side gas budget profiling for Soroban transaction simulations.
 *
 * Soroban RPC returns the resources consumed by a simulated invocation in a
 * `cost` object containing `cpuInsns` and `memBytes`. This module parses those
 * values, compares them with the network's per-transaction limits, and emits a
 * structured warning before a transaction gets close to exhausting its budget.
 *
 * The defaults match the Protocol 22 mainnet limits used by the Anchor Gate
 * contract benchmarks: 100,000,000 CPU instructions and 41,943,040 bytes
 * (40 MiB) of memory per transaction. Both limits and the warning threshold
 * are configurable for testnets or custom networks.
 *
 * @packageDocumentation
 */

/** Default CPU instruction limit for a Soroban transaction. */
export const DEFAULT_CPU_INSN_LIMIT = 100_000_000;

/** Default memory limit, in bytes, for a Soroban transaction (40 MiB). */
export const DEFAULT_MEM_BYTES_LIMIT = 41_943_040;

/**
 * Default utilization fraction at which a warning is emitted.
 *
 * A warning is emitted only when consumption is strictly greater than this
 * threshold, so exactly 80% is considered safe.
 */
export const DEFAULT_WARNING_THRESHOLD = 0.8;

/**
 * Resource cost values returned by a Soroban `simulateTransaction` response.
 *
 * Soroban RPC may encode these integers either as JSON numbers or as decimal
 * strings, so both forms are accepted.
 */
export interface SimulationCost {
  /** CPU instructions consumed by the simulated invocation. */
  cpuInsns: number | string;
  /** Memory bytes consumed by the simulated invocation. */
  memBytes: number | string;
}

/**
 * Per-transaction resource limits used for profiling.
 *
 * Values may be supplied as numbers or decimal strings and must be positive
 * safe integers.
 */
export interface BudgetLimits {
  /** Maximum CPU instructions available to one transaction. */
  cpuInsns: number | string;
  /** Maximum memory bytes available to one transaction. */
  memBytes: number | string;
}

/** Identifier for the resource described by a {@link BudgetWarning}. */
export type BudgetResource = "cpuInsns" | "memBytes";

/**
 * Structured warning emitted when a resource exceeds the warning threshold.
 */
export interface BudgetWarning {
  /** Resource that exceeded the warning threshold. */
  resource: BudgetResource;
  /** Amount of the resource consumed by the simulation. */
  used: number;
  /** Per-transaction limit for the resource. */
  limit: number;
  /** Consumption as a fraction of the limit, where `0.8` means 80%. */
  utilization: number;
  /** Consumption as a percentage of the limit, where `80` means 80%. */
  percentage: number;
  /** Configured warning threshold as a fraction of the limit. */
  threshold: number;
  /** Human-readable warning suitable for logs and operator alerts. */
  message: string;
}

/**
 * Logger invoked for each {@link BudgetWarning}.
 *
 * The default logger is `console.warn`. The first argument is a formatted
 * message, and the second is the complete structured warning for log
 * aggregation or telemetry.
 */
export type BudgetWarningLogger = (
  message: string,
  warning: BudgetWarning
) => void;

/**
 * Options for {@link profileGasBudget}.
 */
export interface BudgetProfilerOptions {
  /**
   * Override either per-transaction resource limit. Omitted values fall back
   * to {@link DEFAULT_CPU_INSN_LIMIT} and {@link DEFAULT_MEM_BYTES_LIMIT}.
   */
  limits?: Partial<BudgetLimits>;
  /**
   * Utilization fraction above which a warning is emitted. Defaults to
   * {@link DEFAULT_WARNING_THRESHOLD} (`0.8`). Must be between `0` and `1`.
   */
  warningThreshold?: number;
  /**
   * Callback invoked for every warning. Defaults to `console.warn` with a
   * formatted message and the structured warning object.
   */
  logger?: BudgetWarningLogger;
}

/**
 * Utilization details for a single Soroban resource.
 */
export interface ResourceBudgetProfile {
  /** Amount of the resource consumed by the simulation. */
  used: number;
  /** Per-transaction limit for the resource. */
  limit: number;
  /** Consumption as a fraction of the limit. May exceed `1`. */
  utilization: number;
  /** Consumption as a percentage of the limit. May exceed `100`. */
  percentage: number;
  /** Whether utilization is strictly greater than the warning threshold. */
  exceedsWarningThreshold: boolean;
}

/**
 * Complete gas budget report returned by {@link profileGasBudget}.
 */
export interface BudgetProfile {
  /** CPU instruction utilization for the simulated transaction. */
  cpu: ResourceBudgetProfile;
  /** Memory byte utilization for the simulated transaction. */
  memory: ResourceBudgetProfile;
  /** Warning threshold applied to both resources. */
  warningThreshold: number;
  /** Warnings emitted for resources that exceeded the threshold. */
  warnings: BudgetWarning[];
  /** Whether any resource exceeded the warning threshold. */
  exceedsWarningThreshold: boolean;
}

/** Classification for errors raised while profiling a transaction budget. */
export type BudgetProfileErrorKind = "invalid_cost" | "invalid_options";

/**
 * Error raised when a cost object or profiler option is malformed.
 */
export class BudgetProfileError extends Error {
  /** Stable category suitable for programmatic handling. */
  public readonly kind: BudgetProfileErrorKind;

  /**
   * Creates a budget profiling error.
   *
   * @param message - Human-readable description of the invalid input.
   * @param kind - Category of the failure.
   */
  constructor(message: string, kind: BudgetProfileErrorKind) {
    super(message);
    this.name = "BudgetProfileError";
    this.kind = kind;
  }
}

const defaultLogger: BudgetWarningLogger = (message, warning) => {
  console.warn(message, warning);
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidCost(message: string): BudgetProfileError {
  return new BudgetProfileError(message, "invalid_cost");
}

function invalidOptions(message: string): BudgetProfileError {
  return new BudgetProfileError(message, "invalid_options");
}

function parseResource(
  value: unknown,
  field: string,
  kind: BudgetProfileErrorKind
): number {
  const fail = (reason: string): never => {
    const message = `${field} must be ${reason}`;
    throw kind === "invalid_cost" ? invalidCost(message) : invalidOptions(message);
  };

  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) {
      return fail("a non-negative integer or decimal integer string");
    }
    parsed = Number(text);
  } else {
    return fail("a non-negative integer or decimal integer string");
  }

  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < 0) {
    return fail("a non-negative safe integer");
  }
  return parsed;
}

function parseLimit(
  value: unknown,
  field: string,
  kind: BudgetProfileErrorKind
): number {
  const parsed = parseResource(value, field, kind);
  if (parsed === 0) {
    const message = `${field} must be greater than zero`;
    throw kind === "invalid_cost" ? invalidCost(message) : invalidOptions(message);
  }
  return parsed;
}

function extractCost(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) {
    throw invalidCost("Simulation cost must be an object");
  }
  if ("cpuInsns" in input || "memBytes" in input) {
    return input;
  }
  if ("cost" in input) {
    if (!isRecord(input.cost)) {
      throw invalidCost("Simulation response cost must be an object");
    }
    return input.cost;
  }
  throw invalidCost(
    "Simulation cost is missing cpuInsns and memBytes"
  );
}

function resourceLabel(resource: BudgetResource): string {
  return resource === "cpuInsns" ? "CPU instructions" : "memory bytes";
}

function formatWarningMessage(
  resource: BudgetResource,
  used: number,
  limit: number,
  percentage: number,
  threshold: number
): string {
  const thresholdPercentage = Number((threshold * 100).toFixed(2));
  return (
    `Soroban ${resourceLabel(resource)} budget warning: ` +
    `${used} of ${limit} used (${percentage.toFixed(2)}%), ` +
    `exceeding the ${thresholdPercentage}% warning threshold.`
  );
}

function buildResourceProfile(
  resource: BudgetResource,
  used: number,
  limit: number,
  threshold: number,
  warnings: BudgetWarning[]
): ResourceBudgetProfile {
  const utilization = used / limit;
  const percentage = utilization * 100;
  const exceedsWarningThreshold = utilization > threshold;
  if (exceedsWarningThreshold) {
    warnings.push({
      resource,
      used,
      limit,
      utilization,
      percentage,
      threshold,
      message: formatWarningMessage(
        resource,
        used,
        limit,
        percentage,
        threshold
      ),
    });
  }
  return {
    used,
    limit,
    utilization,
    percentage,
    exceedsWarningThreshold,
  };
}

/**
 * Profiles the CPU and memory consumption reported by a Soroban simulation.
 *
 * The input may be either a raw cost object with `cpuInsns` and `memBytes`, or
 * a complete `simulateTransaction` response whose `cost` property contains
 * those fields. Values are accepted as numbers or decimal strings and must be
 * non-negative safe integers.
 *
 * A warning is logged for each resource whose utilization is strictly greater
 * than `warningThreshold` (80% by default). Exactly 80% does not warn, while
 * any value above it does. Warnings are also returned in the report so callers
 * can surface them in a UI or forward them to telemetry.
 *
 * @param input - Raw simulation cost or a Soroban simulation response.
 * @param options - Optional limits, warning threshold, and logger override.
 * @returns CPU and memory utilization details plus any structured warnings.
 * @throws {BudgetProfileError} If the cost object or profiler options are
 *   malformed.
 *
 * @example
 * ```ts
 * const profile = profileGasBudget({
 *   cost: { cpuInsns: "85000000", memBytes: "20000000" },
 * });
 * // Logs a warning because CPU usage is 85% of the 100M instruction limit.
 * console.log(profile.cpu.percentage); // 85
 * ```
 */
export function profileGasBudget(
  input: unknown,
  options: BudgetProfilerOptions = {}
): BudgetProfile {
  if (!isRecord(options)) {
    throw invalidOptions("Budget profiler options must be an object");
  }

  const cost = extractCost(input);

  const rawLimits = options.limits;
  if (typeof rawLimits !== "undefined" && !isRecord(rawLimits)) {
    throw invalidOptions("limits must be an object");
  }
  const limits: { cpuInsns: number; memBytes: number } = {
    cpuInsns: parseLimit(
      rawLimits?.cpuInsns === undefined
        ? DEFAULT_CPU_INSN_LIMIT
        : rawLimits.cpuInsns,
      "limits.cpuInsns",
      "invalid_options"
    ),
    memBytes: parseLimit(
      rawLimits?.memBytes === undefined
        ? DEFAULT_MEM_BYTES_LIMIT
        : rawLimits.memBytes,
      "limits.memBytes",
      "invalid_options"
    ),
  };

  const threshold =
    options.warningThreshold === undefined
      ? DEFAULT_WARNING_THRESHOLD
      : options.warningThreshold;
  if (
    typeof threshold !== "number" ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1
  ) {
    throw invalidOptions(
      "warningThreshold must be a finite number between 0 and 1"
    );
  }

  const logger =
    options.logger === undefined ? defaultLogger : options.logger;
  if (typeof logger !== "function") {
    throw invalidOptions("logger must be a function");
  }

  const cpuUsed = parseResource(
    cost.cpuInsns,
    "cost.cpuInsns",
    "invalid_cost"
  );
  const memoryUsed = parseResource(
    cost.memBytes,
    "cost.memBytes",
    "invalid_cost"
  );

  const warnings: BudgetWarning[] = [];
  const cpu = buildResourceProfile(
    "cpuInsns",
    cpuUsed,
    limits.cpuInsns,
    threshold,
    warnings
  );
  const memory = buildResourceProfile(
    "memBytes",
    memoryUsed,
    limits.memBytes,
    threshold,
    warnings
  );

  for (const warning of warnings) {
    logger(warning.message, warning);
  }

  return {
    cpu,
    memory,
    warningThreshold: threshold,
    warnings,
    exceedsWarningThreshold: warnings.length > 0,
  };
}
