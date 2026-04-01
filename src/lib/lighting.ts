import type { Luminaire, Point2D, Polygon2D, Room, Table } from '@/types/scene'

export const DEFAULT_LIGHTING_GRID_X = 10
export const DEFAULT_LIGHTING_GRID_Y = 10
export const MIN_LIGHTING_GRID = 2
export const MAX_LIGHTING_GRID = 40
export const DEFAULT_LIGHTING_EPSILON = 0.1

export type LightingGrid = {
  x: number
  y: number
}

export type TableLightingStats = {
  tableId: string
  sampleCount: number
  minLux: number
  avgLux: number
  maxLux: number
}

export type LightingReport = {
  computedAt: number
  epsilon: number
  grid: LightingGrid
  tableStats: TableLightingStats[]
}

export type LightingCalculationResult =
  | {
      status: 'ready'
      report: LightingReport
    }
  | {
      status: 'blocked'
      reason: string
    }

type LightingInput = {
  room: Room | null
  tables: Table[]
  luminaires: Luminaire[]
}

function polygonArea(points: Polygon2D) {
  let sum = 0
  for (let i = 0; i < points.length; i += 1) {
    const p1 = points[i]
    const p2 = points[(i + 1) % points.length]
    sum += p1.x * p2.y - p2.x * p1.y
  }
  return sum / 2
}

function polygonBounds(points: Polygon2D) {
  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  points.forEach((point) => {
    minX = Math.min(minX, point.x)
    maxX = Math.max(maxX, point.x)
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  })

  return { minX, maxX, minY, maxY }
}

function pointInPolygon(point: Point2D, polygon: Polygon2D) {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y

    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + Number.EPSILON) + xi

    if (intersects) inside = !inside
  }

  return inside
}

function sampleTableSurface(table: Table, grid: LightingGrid): Point2D[] {
  const points: Point2D[] = []
  if (table.polygon.length < 3) return points

  const bounds = polygonBounds(table.polygon)
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  if (width <= 0 || height <= 0) return points

  const stepX = width / grid.x
  const stepY = height / grid.y

  for (let iy = 0; iy < grid.y; iy += 1) {
    for (let ix = 0; ix < grid.x; ix += 1) {
      const point = {
        x: bounds.minX + (ix + 0.5) * stepX,
        y: bounds.minY + (iy + 0.5) * stepY,
      }
      if (pointInPolygon(point, table.polygon)) {
        points.push(point)
      }
    }
  }

  // Narrow polygons can miss every cell center; fallback to polygon centroid.
  if (points.length === 0) {
    const centroid = table.polygon.reduce(
      (acc, item) => ({ x: acc.x + item.x, y: acc.y + item.y }),
      { x: 0, y: 0 },
    )
    centroid.x /= table.polygon.length
    centroid.y /= table.polygon.length
    if (pointInPolygon(centroid, table.polygon)) {
      points.push(centroid)
    }
  }

  return points
}

function computeLuxAtPoint(
  point: Point2D,
  tableHeight: number,
  luminaires: Luminaire[],
  epsilon: number,
) {
  let totalLux = 0

  luminaires.forEach((luminaire) => {
    const dx = luminaire.position.x - point.x
    const dy = luminaire.position.y - point.y
    const dz = luminaire.position.z - tableHeight
    const r = Math.hypot(dx, dy, dz)
    const safeR = Math.max(r, epsilon)
    const luminousIntensity = luminaire.lumensPreset / (4 * Math.PI)
    totalLux += luminousIntensity / (safeR * safeR)
  })

  return totalLux
}

function normalizeGrid(value: LightingGrid): LightingGrid {
  return {
    x: Math.max(MIN_LIGHTING_GRID, Math.min(MAX_LIGHTING_GRID, Math.round(value.x))),
    y: Math.max(MIN_LIGHTING_GRID, Math.min(MAX_LIGHTING_GRID, Math.round(value.y))),
  }
}

export function calculateLighting(
  input: LightingInput,
  options?: { grid?: LightingGrid; epsilon?: number },
): LightingCalculationResult {
  if (!input.room || input.room.polygon.length < 3 || Math.abs(polygonArea(input.room.polygon)) < 1e-6) {
    return {
      status: 'blocked',
      reason: 'Расчёт доступен только при валидном room-контуре.',
    }
  }

  if (input.tables.length === 0) {
    return {
      status: 'blocked',
      reason: 'Добавьте хотя бы один стол (table), чтобы выполнить расчёт.',
    }
  }

  const epsilon = Math.max(1e-6, options?.epsilon ?? DEFAULT_LIGHTING_EPSILON)
  const grid = normalizeGrid({
    x: options?.grid?.x ?? DEFAULT_LIGHTING_GRID_X,
    y: options?.grid?.y ?? DEFAULT_LIGHTING_GRID_Y,
  })

  const tableStats: TableLightingStats[] = []

  input.tables.forEach((table) => {
    const samples = sampleTableSurface(table, grid)
    if (samples.length === 0) return

    let minLux = Number.POSITIVE_INFINITY
    let maxLux = Number.NEGATIVE_INFINITY
    let sumLux = 0

    samples.forEach((sample) => {
      const lux = computeLuxAtPoint(sample, table.tableHeight, input.luminaires, epsilon)
      minLux = Math.min(minLux, lux)
      maxLux = Math.max(maxLux, lux)
      sumLux += lux
    })

    tableStats.push({
      tableId: table.id,
      sampleCount: samples.length,
      minLux,
      avgLux: sumLux / samples.length,
      maxLux,
    })
  })

  if (tableStats.length === 0) {
    return {
      status: 'blocked',
      reason: 'Не удалось получить точки сэмплирования для выбранных столов.',
    }
  }

  return {
    status: 'ready',
    report: {
      computedAt: Date.now(),
      epsilon,
      grid,
      tableStats,
    },
  }
}
