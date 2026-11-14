export { TopoNetwork, endKey, parseEndKey, otherEnd, type End, type EndRef } from "./network.js";
export {
  classifySwitches,
  continuousBranch,
  compactSwitches,
  expandSwitches,
  type SwitchInfo,
  type ClassifyOptions,
  type ContinuityRule,
  type BranchSide,
  type CompactSwitch,
} from "./switches.js";
export { LocalFrame, signedAngle, curvature, type LngLat, type XY } from "./geo.js";
export {
  layoutRouteSchematic,
  schematicX,
  schematicDistance,
  type Schematic,
  type SchematicTrack,
  type SchematicSwitch,
  type SchematicPoint,
  type SchematicCrossing,
  type SchematicConnection,
  type SchematicWindow,
  type LayoutOptions,
  type LayoutInput,
} from "./layout.js";
export { addKinks, type KinkOptions } from "./kinks.js";
export {
  layoutRouteSchematicSolved,
  prepareSolvedLayout,
  windowBudget,
  LIMITED,
  type SolvedLayoutOptions,
  type LpProblem,
  type LpSolution,
  type LpSolver,
  type WindowReport,
} from "./solver.js";
export { loadHighs, solveWithHighs, highsSolver, type HighsLike, type HighsLoadOptions } from "./highs.js";
export { drawnPolyline, layoutMetrics, layoutQuality, type LayoutMetrics, type QualityMetrics } from "./metrics.js";
