export type EntityId = string

export type Point2D = {
  x: number
  y: number
}

export type Point3D = {
  x: number
  y: number
  z: number
}

export type Polygon2D = Point2D[]

export const LUMENS_PRESETS = [1000, 2000, 3000] as const

export type LumensPreset = (typeof LUMENS_PRESETS)[number]

export type Room = {
  id: EntityId
  polygon: Polygon2D
  ceilingHeight: number
}

export type Table = {
  id: EntityId
  polygon: Polygon2D
  tableHeight: number
}

export type Luminaire = {
  id: EntityId
  position: Point3D
  rotationDeg: number
  lumensPreset: LumensPreset
}
