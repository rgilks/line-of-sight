// Barrel for the line-of-sight core. The implementation lives in three focused
// modules; everything is re-exported here so existing `…/core/los` imports keep
// resolving unchanged.
//
//   ./geometry   — shared types (Point, Occluder, …) + segment primitives
//   ./visibility — line-of-sight gating and the viewer visibility polygon
//   ./detect     — raster image analysis (walls + doors from an RGBA tile)
export * from './geometry'
export * from './visibility'
export * from './detect'
