export * from './types.js';
export { stripBlockingTags } from './blocking.js';
export {
    DEFAULT_CLICHE_TERMS,
    DEFAULT_GATE_RULES,
    extractConcreteSimiles,
    normalizeSimileVehicle,
    type ExtractedSimile
} from './rules.js';
export { StaticProseGate } from './static-prose-gate.js';
export { normalizeForQuoteMatch, verifyDualQuotes } from './quote-verifier.js';
export {
    computeClicheDensity,
    computeKontoyiannisEntropy,
    computeMattr500,
    computeSentenceLengthCv,
    computeTelemetry,
    segmentWords
} from './telemetry.js';
