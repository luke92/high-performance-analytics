/** Numeric limits shared by validation, generation and documentation. */

/** Maximum |value|. Keeps sums of MAX_EVENTS values far from overflow. */
export const MAX_ABS_VALUE = 1e12;

/** Maximum timestamp: the ECMAScript Date range, in ms since the Unix epoch. */
export const MAX_TIMESTAMP = 8_640_000_000_000_000;

/** Maximum events per dataset accepted by the core. */
export const MAX_EVENTS = 5_000_000;

export const MAX_STRING_LENGTH = 64;
/** Allowed characters for category and eventType. */
export const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export const DEFAULT_HISTOGRAM_BINS = 10;
export const MAX_HISTOGRAM_BINS = 1024;

export const MAX_UINT32 = 4_294_967_295;
export const DEFAULT_START_TIMESTAMP = 1_700_000_000_000;
export const DEFAULT_INTERVAL_MS = 1000;
export const MAX_INTERVAL_MS = 86_400_000;
