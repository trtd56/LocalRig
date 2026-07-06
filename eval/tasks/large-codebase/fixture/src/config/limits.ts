/** Hard limits enforced across the domain and service layers. */
export const MAX_ORDER_LINES = 50;
export const MAX_QUANTITY_PER_LINE = 999;

/** Stock at or below this level shows up on the reorder report. */
export const REORDER_THRESHOLD = 10;

/** Below this, the UI flags the SKU as running low. */
export const LOW_STOCK_WARNING = 5;
