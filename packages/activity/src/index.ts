export { buildActivitySnapshot } from "./aggregate.js";
export {
  computeBuySizeEntropyBps,
  computeBuySizeGiniBps,
  computeRepeatedSizeBuyPctBps,
  type BuyShapeEvent
} from "./buy-shape.js";
export { decodeSwapLog, type DecodedSwapEvent } from "./decode.js";
export { ActivityHaltError, SwapDecodeError } from "./errors.js";
export {
  normalizeSwapEvent,
  toPoolSwapEventInsert,
  type NormalizedSwapEvent,
  type SwapSide
} from "./normalize.js";
export {
  runActivityPass,
  type ActivityPassOptions,
  type ActivityPassResult
} from "./poller.js";
