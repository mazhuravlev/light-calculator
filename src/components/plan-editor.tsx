import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LUMENS_PRESETS, type LumensPreset, type Point2D, type Polygon2D } from '@/types/scene'
import { useSceneStore } from '@/store/scene-store'

type Tool =
  | 'select'
  | 'segment'
  | 'luminaire'
  | 'brush'
  | 'eraser'
  | 'line'
  | 'rectangle'
  | 'arrow'
  | 'highlight'

type Vertex = {
  id: string
  x: number
  y: number
}

type Segment = {
  id: string
  a: string
  b: string
}

type Luminaire2D = {
  id: string
  x: number
  y: number
  lumensPreset: LumensPreset
}

type Face = {
  key: string
  vertexIds: string[]
  points: Polygon2D
  area: number
  segmentIds: string[]
}

type FaceRole = 'room' | 'table'

type FaceMeta = {
  role?: FaceRole
  ceilingHeight: number
  tableHeight: number
}

type DrawingLayer = {
  id: string
  name: string
  visible: boolean
  locked: boolean
}

type PathDrawable = {
  id: string
  type: 'path'
  layerId: string
  points: Point2D[]
  color: string
  width: number
  opacity: number
}

type LineDrawable = {
  id: string
  type: 'line' | 'arrow'
  layerId: string
  start: Point2D
  end: Point2D
  color: string
  width: number
  opacity: number
}

type RectDrawable = {
  id: string
  type: 'rectangle' | 'highlight'
  layerId: string
  start: Point2D
  end: Point2D
  color: string
  width: number
  opacity: number
}

type Drawable = PathDrawable | LineDrawable | RectDrawable

type Selection =
  | { type: 'vertex'; id: string }
  | { type: 'segment'; id: string }
  | { type: 'face'; key: string }
  | { type: 'luminaire'; id: string }
  | { type: 'drawable'; id: string }
  | null

type HistorySnapshot = {
  drawables: Drawable[]
  layers: DrawingLayer[]
  activeLayerId: string
  selection: Selection
}

const VIEW_SIZE = 20
const GRID_STEP = 1
const SNAP_DISTANCE = 0.15
const HIT_VERTEX = 0.32
const HIT_SEGMENT = 0.24
const COINCIDENT_DISTANCE = 0.05
const DEFAULT_CEILING_HEIGHT = 3
const DEFAULT_TABLE_HEIGHT = 0.75
const PLAN_EDITOR_STORAGE_KEY = 'light:plan-editor:v2'
const HISTORY_LIMIT = 120

const DEFAULT_LAYER_ID = 'layer_default'
const DEFAULT_BRUSH_SIZE = 0.18
const DEFAULT_BRUSH_OPACITY = 0.9
const DEFAULT_BRUSH_SMOOTHING = 0.45
const DEFAULT_BRUSH_COLOR = '#0f172a'

type PersistedPlanEditorState = {
  tool: Tool
  vertices: Vertex[]
  segments: Segment[]
  luminaires: Luminaire2D[]
  selection: Selection
  pendingStart: string | null
  faceMeta: Record<string, FaceMeta>
  faceMetaByPolygon?: Record<string, FaceMeta>
  drawables: Drawable[]
  layers: DrawingLayer[]
  activeLayerId: string
  brushSize: number
  brushOpacity: number
  brushSmoothing: number
  brushColor: string
}

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function snap(value: number) {
  return Math.round(value / GRID_STEP) * GRID_STEP
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function snapPoint(point: Point2D): Point2D {
  return {
    x: snap(point.x),
    y: snap(point.y),
  }
}

function distance(a: Point2D, b: Point2D) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function smoothPoint(last: Point2D, next: Point2D, smoothing: number): Point2D {
  const t = clamp(1 - smoothing, 0.08, 1)
  return {
    x: lerp(last.x, next.x, t),
    y: lerp(last.y, next.y, t),
  }
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

function pointToSegmentDistance(point: Point2D, a: Point2D, b: Point2D) {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const l2 = abx * abx + aby * aby
  if (l2 === 0) return distance(point, a)

  let t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / l2
  t = Math.max(0, Math.min(1, t))

  const projection = {
    x: a.x + t * abx,
    y: a.y + t * aby,
  }

  return distance(point, projection)
}

function rectBounds(start: Point2D, end: Point2D) {
  const x = Math.min(start.x, end.x)
  const y = Math.min(start.y, end.y)
  const width = Math.abs(end.x - start.x)
  const height = Math.abs(end.y - start.y)
  return { x, y, width, height }
}

function pointInRect(point: Point2D, start: Point2D, end: Point2D, pad = 0) {
  const b = rectBounds(start, end)
  return (
    point.x >= b.x - pad &&
    point.x <= b.x + b.width + pad &&
    point.y >= b.y - pad &&
    point.y <= b.y + b.height + pad
  )
}

function toRgba(hex: string, alpha: number) {
  const normalized = hex.replace('#', '')
  if (normalized.length !== 6) return `rgba(15,23,42,${clamp(alpha, 0, 1)})`
  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`
}

function canonicalCycleKey(vertexIds: string[]) {
  const cycle = [...vertexIds]
  const rev = [...vertexIds].reverse()

  const rotations = (arr: string[]) => {
    const out: string[] = []
    for (let i = 0; i < arr.length; i += 1) {
      out.push([...arr.slice(i), ...arr.slice(0, i)].join('|'))
    }
    return out
  }

  return [...rotations(cycle), ...rotations(rev)].sort()[0]
}

function undirectedEdgeKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function canonicalPolygonSignature(points: Polygon2D) {
  if (points.length === 0) return ''

  const tokens = points.map(({ x, y }) => `${x.toFixed(4)},${y.toFixed(4)}`)
  const reversed = [...tokens].reverse()

  const rotations = (arr: string[]) => {
    const out: string[] = []
    for (let i = 0; i < arr.length; i += 1) {
      out.push([...arr.slice(i), ...arr.slice(0, i)].join('|'))
    }
    return out
  }

  return [...rotations(tokens), ...rotations(reversed)].sort()[0]
}

function findSelfIntersections(vertices: Vertex[], segments: Segment[]) {
  const vertexById = new Map(vertices.map((v) => [v.id, v]))
  const intersections: string[] = []

  const orientation = (p: Point2D, q: Point2D, r: Point2D) => {
    const value = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y)
    if (Math.abs(value) < 1e-9) return 0
    return value > 0 ? 1 : 2
  }

  const onSegment = (p: Point2D, q: Point2D, r: Point2D) => {
    return (
      q.x <= Math.max(p.x, r.x) &&
      q.x >= Math.min(p.x, r.x) &&
      q.y <= Math.max(p.y, r.y) &&
      q.y >= Math.min(p.y, r.y)
    )
  }

  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const s1 = segments[i]
      const s2 = segments[j]
      if (s1.a === s2.a || s1.a === s2.b || s1.b === s2.a || s1.b === s2.b) continue

      const p1 = vertexById.get(s1.a)
      const q1 = vertexById.get(s1.b)
      const p2 = vertexById.get(s2.a)
      const q2 = vertexById.get(s2.b)
      if (!p1 || !q1 || !p2 || !q2) continue

      const o1 = orientation(p1, q1, p2)
      const o2 = orientation(p1, q1, q2)
      const o3 = orientation(p2, q2, p1)
      const o4 = orientation(p2, q2, q1)

      let intersects = false
      if (o1 !== o2 && o3 !== o4) intersects = true
      if (o1 === 0 && onSegment(p1, p2, q1)) intersects = true
      if (o2 === 0 && onSegment(p1, q2, q1)) intersects = true
      if (o3 === 0 && onSegment(p2, p1, q2)) intersects = true
      if (o4 === 0 && onSegment(p2, q1, q2)) intersects = true

      if (intersects) intersections.push(`${s1.id}:${s2.id}`)
    }
  }

  return intersections
}

function detectFaces(vertices: Vertex[], segments: Segment[]) {
  const vertexById = new Map(vertices.map((v) => [v.id, v]))
  const adjacency = new Map<string, string[]>()

  segments.forEach((segment) => {
    if (!adjacency.has(segment.a)) adjacency.set(segment.a, [])
    if (!adjacency.has(segment.b)) adjacency.set(segment.b, [])
    adjacency.get(segment.a)?.push(segment.b)
    adjacency.get(segment.b)?.push(segment.a)
  })

  const sortedNeighbors = new Map<string, string[]>()
  adjacency.forEach((neighbors, id) => {
    const base = vertexById.get(id)
    if (!base) return
    const ordered = [...neighbors].sort((n1, n2) => {
      const p1 = vertexById.get(n1)
      const p2 = vertexById.get(n2)
      if (!p1 || !p2) return 0
      const a1 = Math.atan2(p1.y - base.y, p1.x - base.x)
      const a2 = Math.atan2(p2.y - base.y, p2.x - base.x)
      return a1 - a2
    })
    sortedNeighbors.set(id, ordered)
  })

  const usedDirected = new Set<string>()
  const segmentByEdge = new Map<string, string>()

  segments.forEach((s) => {
    segmentByEdge.set(undirectedEdgeKey(s.a, s.b), s.id)
  })

  const faces: Face[] = []

  for (const segment of segments) {
    for (const start of [segment.a, segment.b]) {
      const next = start === segment.a ? segment.b : segment.a
      const directedKey = `${start}>${next}`
      if (usedDirected.has(directedKey)) continue

      const polygonVertexIds: string[] = []
      const polygonPoints: Polygon2D = []
      const polygonSegments: string[] = []

      let prev = start
      let current = next
      let guard = 0

      while (guard < segments.length * 4) {
        guard += 1
        const edgeKey = `${prev}>${current}`
        if (usedDirected.has(edgeKey)) break
        usedDirected.add(edgeKey)

        if (!polygonVertexIds.includes(prev)) {
          polygonVertexIds.push(prev)
          const point = vertexById.get(prev)
          if (point) polygonPoints.push({ x: point.x, y: point.y })
        }

        const segmentId = segmentByEdge.get(undirectedEdgeKey(prev, current))
        if (segmentId) polygonSegments.push(segmentId)

        const neighbors = sortedNeighbors.get(current) ?? []
        const indexOfPrev = neighbors.indexOf(prev)
        if (indexOfPrev === -1 || neighbors.length < 2) break

        const nextIndex = (indexOfPrev - 1 + neighbors.length) % neighbors.length
        const candidate = neighbors[nextIndex]

        if (candidate === start && current === next) {
          break
        }

        const isClosed = current === start && candidate === next
        prev = current
        current = candidate

        if (isClosed) break
        if (current === start && prev === next) break
      }

      const hasEnough = polygonVertexIds.length >= 3
      if (!hasEnough) continue

      const area = polygonArea(polygonPoints)
      if (Math.abs(area) < 1e-6 || area <= 0) continue

      const key = canonicalCycleKey(polygonVertexIds)
      if (faces.some((face) => face.key === key)) continue

      faces.push({
        key,
        vertexIds: polygonVertexIds,
        points: polygonPoints,
        area,
        segmentIds: [...new Set(polygonSegments)],
      })
    }
  }

  return faces
}

function mergeVertices(vertices: Vertex[], segments: Segment[]) {
  const parent = new Map(vertices.map((v) => [v.id, v.id]))

  const find = (id: string): string => {
    const p = parent.get(id)
    if (!p || p === id) return id
    const root = find(p)
    parent.set(id, root)
    return root
  }

  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(rb, ra)
  }

  for (let i = 0; i < vertices.length; i += 1) {
    for (let j = i + 1; j < vertices.length; j += 1) {
      if (distance(vertices[i], vertices[j]) <= SNAP_DISTANCE) {
        union(vertices[i].id, vertices[j].id)
      }
    }
  }

  const groups = new Map<string, Vertex[]>()
  vertices.forEach((v) => {
    const root = find(v.id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)?.push(v)
  })

  const mergedVertices: Vertex[] = []
  const mapping = new Map<string, string>()

  groups.forEach((group, root) => {
    const x = snap(group.reduce((sum, item) => sum + item.x, 0) / group.length)
    const y = snap(group.reduce((sum, item) => sum + item.y, 0) / group.length)
    mergedVertices.push({ id: root, x, y })
    group.forEach((item) => mapping.set(item.id, root))
  })

  const mergedSegments: Segment[] = []
  const seen = new Set<string>()

  segments.forEach((segment) => {
    const a = mapping.get(segment.a) ?? segment.a
    const b = mapping.get(segment.b) ?? segment.b
    if (a === b) return
    const edgeKey = undirectedEdgeKey(a, b)
    if (seen.has(edgeKey)) return
    seen.add(edgeKey)
    mergedSegments.push({ ...segment, a, b })
  })

  return {
    vertices: mergedVertices,
    segments: mergedSegments,
  }
}

function toScreenPoint(svg: SVGSVGElement, clientX: number, clientY: number): Point2D {
  const ctm = svg.getScreenCTM()
  let x: number
  let y: number

  if (ctm) {
    const svgPoint = svg.createSVGPoint()
    svgPoint.x = clientX
    svgPoint.y = clientY
    const point = svgPoint.matrixTransform(ctm.inverse())
    x = point.x
    y = point.y
  } else {
    const rect = svg.getBoundingClientRect()
    x = ((clientX - rect.left) / rect.width) * VIEW_SIZE
    y = ((clientY - rect.top) / rect.height) * VIEW_SIZE
  }

  return {
    x: Math.max(0, Math.min(VIEW_SIZE, x)),
    y: Math.max(0, Math.min(VIEW_SIZE, y)),
  }
}

function isPolygonInside(inner: Polygon2D, outer: Polygon2D) {
  return inner.every((point) => pointInPolygon(point, outer))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseFaceMetaRecord(value: unknown) {
  if (!value || typeof value !== 'object') return {}

  return Object.entries(value).reduce<Record<string, FaceMeta>>((acc, [key, meta]) => {
    if (!meta || typeof meta !== 'object') return acc
    const role = meta.role === 'room' || meta.role === 'table' ? meta.role : undefined
    const ceilingHeight = isFiniteNumber(meta.ceilingHeight)
      ? Math.max(0.1, meta.ceilingHeight)
      : DEFAULT_CEILING_HEIGHT
    const tableHeight = isFiniteNumber(meta.tableHeight)
      ? Math.max(0.1, meta.tableHeight)
      : DEFAULT_TABLE_HEIGHT
    acc[key] = { role, ceilingHeight, tableHeight }
    return acc
  }, {})
}

function parseLayers(value: unknown): DrawingLayer[] {
  const parsed = Array.isArray(value)
    ? value.filter(
        (layer): layer is DrawingLayer =>
          !!layer &&
          typeof layer.id === 'string' &&
          typeof layer.name === 'string' &&
          typeof layer.visible === 'boolean' &&
          typeof layer.locked === 'boolean',
      )
    : []

  if (parsed.length === 0) {
    return [{ id: DEFAULT_LAYER_ID, name: 'Layer 1', visible: true, locked: false }]
  }

  if (!parsed.some((layer) => layer.id === DEFAULT_LAYER_ID)) {
    return [{ id: DEFAULT_LAYER_ID, name: 'Layer 1', visible: true, locked: false }, ...parsed]
  }

  return parsed
}

function parseDrawables(value: unknown, layerIds: Set<string>): Drawable[] {
  if (!Array.isArray(value)) return []

  return value
    .map((raw): Drawable | null => {
      if (!raw || typeof raw !== 'object') return null
      const candidate = raw as Partial<Drawable>

      const layerId = typeof candidate.layerId === 'string' && layerIds.has(candidate.layerId)
        ? candidate.layerId
        : DEFAULT_LAYER_ID

      const color = typeof candidate.color === 'string' ? candidate.color : DEFAULT_BRUSH_COLOR
      const width = isFiniteNumber(candidate.width) ? clamp(candidate.width, 0.02, 2) : DEFAULT_BRUSH_SIZE
      const opacity = isFiniteNumber(candidate.opacity) ? clamp(candidate.opacity, 0.05, 1) : DEFAULT_BRUSH_OPACITY

      if (candidate.type === 'path' && Array.isArray(candidate.points)) {
        const points = candidate.points
          .filter((p): p is Point2D => !!p && isFiniteNumber(p.x) && isFiniteNumber(p.y))
          .map((p) => ({ x: clamp(p.x, 0, VIEW_SIZE), y: clamp(p.y, 0, VIEW_SIZE) }))
        if (points.length < 2 || typeof candidate.id !== 'string') return null
        return { id: candidate.id, type: 'path', points, color, width, opacity, layerId }
      }

      if (
        (candidate.type === 'line' || candidate.type === 'arrow' || candidate.type === 'rectangle' || candidate.type === 'highlight') &&
        candidate.start &&
        candidate.end &&
        isFiniteNumber(candidate.start.x) &&
        isFiniteNumber(candidate.start.y) &&
        isFiniteNumber(candidate.end.x) &&
        isFiniteNumber(candidate.end.y) &&
        typeof candidate.id === 'string'
      ) {
        const start = { x: clamp(candidate.start.x, 0, VIEW_SIZE), y: clamp(candidate.start.y, 0, VIEW_SIZE) }
        const end = { x: clamp(candidate.end.x, 0, VIEW_SIZE), y: clamp(candidate.end.y, 0, VIEW_SIZE) }
        return {
          id: candidate.id,
          type: candidate.type,
          start,
          end,
          color,
          width,
          opacity,
          layerId,
        }
      }

      return null
    })
    .filter((item): item is Drawable => item !== null)
}

function parsePersistedPlanEditorState(value: unknown): PersistedPlanEditorState | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Partial<PersistedPlanEditorState>
  const tool: Tool =
    raw.tool === 'segment' ||
    raw.tool === 'luminaire' ||
    raw.tool === 'brush' ||
    raw.tool === 'eraser' ||
    raw.tool === 'line' ||
    raw.tool === 'rectangle' ||
    raw.tool === 'arrow' ||
    raw.tool === 'highlight'
      ? raw.tool
      : 'select'

  const vertices = Array.isArray(raw.vertices)
    ? raw.vertices.filter(
        (vertex): vertex is Vertex =>
          !!vertex &&
          typeof vertex.id === 'string' &&
          isFiniteNumber(vertex.x) &&
          isFiniteNumber(vertex.y),
      )
    : []

  const vertexIds = new Set(vertices.map((vertex) => vertex.id))

  const segments = Array.isArray(raw.segments)
    ? raw.segments.filter(
        (segment): segment is Segment =>
          !!segment &&
          typeof segment.id === 'string' &&
          typeof segment.a === 'string' &&
          typeof segment.b === 'string' &&
          segment.a !== segment.b &&
          vertexIds.has(segment.a) &&
          vertexIds.has(segment.b),
      )
    : []

  const luminaires = Array.isArray(raw.luminaires)
    ? raw.luminaires.filter(
        (luminaire): luminaire is Luminaire2D =>
          !!luminaire &&
          typeof luminaire.id === 'string' &&
          isFiniteNumber(luminaire.x) &&
          isFiniteNumber(luminaire.y) &&
          (LUMENS_PRESETS as readonly number[]).includes(luminaire.lumensPreset),
      )
    : []

  const pendingStart =
    typeof raw.pendingStart === 'string' && vertexIds.has(raw.pendingStart) ? raw.pendingStart : null

  let selection: Selection = null
  if (raw.selection && typeof raw.selection === 'object') {
    const candidate = raw.selection as { type?: unknown; id?: unknown; key?: unknown }
    if (candidate.type === 'vertex' && typeof candidate.id === 'string' && vertexIds.has(candidate.id)) {
      selection = { type: 'vertex', id: candidate.id }
    }
    if (
      candidate.type === 'segment' &&
      typeof candidate.id === 'string' &&
      segments.some((segment) => segment.id === candidate.id)
    ) {
      selection = { type: 'segment', id: candidate.id }
    }
    if (
      candidate.type === 'luminaire' &&
      typeof candidate.id === 'string' &&
      luminaires.some((luminaire) => luminaire.id === candidate.id)
    ) {
      selection = { type: 'luminaire', id: candidate.id }
    }
    if (candidate.type === 'face' && typeof candidate.key === 'string') {
      selection = { type: 'face', key: candidate.key }
    }
    if (candidate.type === 'drawable' && typeof candidate.id === 'string') {
      selection = { type: 'drawable', id: candidate.id }
    }
  }

  const layers = parseLayers(raw.layers)
  const layerIds = new Set(layers.map((layer) => layer.id))
  const drawables = parseDrawables(raw.drawables, layerIds)

  const activeLayerId =
    typeof raw.activeLayerId === 'string' && layerIds.has(raw.activeLayerId)
      ? raw.activeLayerId
      : layers[0]?.id ?? DEFAULT_LAYER_ID

  const brushSize = isFiniteNumber(raw.brushSize) ? clamp(raw.brushSize, 0.02, 2) : DEFAULT_BRUSH_SIZE
  const brushOpacity = isFiniteNumber(raw.brushOpacity)
    ? clamp(raw.brushOpacity, 0.05, 1)
    : DEFAULT_BRUSH_OPACITY
  const brushSmoothing = isFiniteNumber(raw.brushSmoothing)
    ? clamp(raw.brushSmoothing, 0, 0.95)
    : DEFAULT_BRUSH_SMOOTHING
  const brushColor = typeof raw.brushColor === 'string' ? raw.brushColor : DEFAULT_BRUSH_COLOR

  const faceMeta = parseFaceMetaRecord(raw.faceMeta)
  const faceMetaByPolygon = parseFaceMetaRecord(raw.faceMetaByPolygon)

  return {
    tool,
    vertices,
    segments,
    luminaires,
    selection,
    pendingStart,
    faceMeta,
    faceMetaByPolygon,
    drawables,
    layers,
    activeLayerId,
    brushSize,
    brushOpacity,
    brushSmoothing,
    brushColor,
  }
}

function cloneDrawables(drawables: Drawable[]) {
  return drawables.map((drawable) => {
    if (drawable.type === 'path') {
      return {
        ...drawable,
        points: drawable.points.map((point) => ({ ...point })),
      }
    }
    return {
      ...drawable,
      start: { ...drawable.start },
      end: { ...drawable.end },
    }
  })
}

type PlanEditorProps = {
  onRoomAssigned?: () => void
}

export function PlanEditor({ onRoomAssigned }: PlanEditorProps) {
  const [tool, setTool] = useState<Tool>('select')
  const [vertices, setVertices] = useState<Vertex[]>([])
  const [segments, setSegments] = useState<Segment[]>([])
  const [luminaires, setLuminaires] = useState<Luminaire2D[]>([])
  const [selection, setSelection] = useState<Selection>(null)
  const [hovered, setHovered] = useState<Selection>(null)
  const [pendingStart, setPendingStart] = useState<string | null>(null)
  const [faceMeta, setFaceMeta] = useState<Record<string, FaceMeta>>({})
  const [message, setMessage] = useState<string>('')
  const [isLoadedFromStorage, setIsLoadedFromStorage] = useState(false)
  const [snappedCursorPoint, setSnappedCursorPoint] = useState<Point2D | null>(null)

  const [drawables, setDrawables] = useState<Drawable[]>([])
  const [layers, setLayers] = useState<DrawingLayer[]>([
    { id: DEFAULT_LAYER_ID, name: 'Layer 1', visible: true, locked: false },
  ])
  const [activeLayerId, setActiveLayerId] = useState(DEFAULT_LAYER_ID)

  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE)
  const [brushOpacity, setBrushOpacity] = useState(DEFAULT_BRUSH_OPACITY)
  const [brushSmoothing, setBrushSmoothing] = useState(DEFAULT_BRUSH_SMOOTHING)
  const [brushColor, setBrushColor] = useState(DEFAULT_BRUSH_COLOR)

  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  const [dragState, setDragState] = useState<{
    vertexIds: string[]
    pointerStart: Point2D
    origin: Map<string, Point2D>
  } | null>(null)

  const [drawableDragState, setDrawableDragState] = useState<{
    drawableId: string
    pointerStart: Point2D
    origin: Drawable
  } | null>(null)

  const [pathDraft, setPathDraft] = useState<PathDrawable | null>(null)
  const [shapeDraft, setShapeDraft] = useState<LineDrawable | RectDrawable | null>(null)
  const [eraserActive, setEraserActive] = useState(false)

  const svgRef = useRef<SVGSVGElement>(null)
  const pendingFaceMetaByPolygonRef = useRef<Record<string, FaceMeta> | null>(null)

  const drawablesRef = useRef<Drawable[]>(drawables)
  const layersRef = useRef<DrawingLayer[]>(layers)
  const activeLayerIdRef = useRef(activeLayerId)
  const selectionRef = useRef<Selection>(selection)
  const historyPastRef = useRef<HistorySnapshot[]>([])
  const historyFutureRef = useRef<HistorySnapshot[]>([])

  const setRoom = useSceneStore((state) => state.setRoom)
  const clearRoom = useSceneStore((state) => state.clearRoom)
  const setTablesStore = useSceneStore((state) => state.setTables)
  const setLuminairesStore = useSceneStore((state) => state.setLuminaires)

  useEffect(() => {
    drawablesRef.current = drawables
  }, [drawables])

  useEffect(() => {
    layersRef.current = layers
  }, [layers])

  useEffect(() => {
    activeLayerIdRef.current = activeLayerId
  }, [activeLayerId])

  useEffect(() => {
    selectionRef.current = selection
  }, [selection])

  const updateHistoryFlags = useCallback(() => {
    setCanUndo(historyPastRef.current.length > 0)
    setCanRedo(historyFutureRef.current.length > 0)
  }, [])

  const makeHistorySnapshot = useCallback((): HistorySnapshot => {
    const selected = selectionRef.current
    const normalizedSelection =
      selected?.type === 'drawable' ? selected : null

    return {
      drawables: cloneDrawables(drawablesRef.current),
      layers: layersRef.current.map((layer) => ({ ...layer })),
      activeLayerId: activeLayerIdRef.current,
      selection: normalizedSelection,
    }
  }, [])

  const applyHistorySnapshot = useCallback((snapshot: HistorySnapshot) => {
    setDrawables(snapshot.drawables)
    setLayers(snapshot.layers)
    setActiveLayerId(snapshot.activeLayerId)
    setSelection(snapshot.selection)
  }, [])

  const pushHistory = useCallback(() => {
    const snapshot = makeHistorySnapshot()
    historyPastRef.current = [...historyPastRef.current, snapshot].slice(-HISTORY_LIMIT)
    historyFutureRef.current = []
    updateHistoryFlags()
  }, [makeHistorySnapshot, updateHistoryFlags])

  const undo = useCallback(() => {
    const prev = historyPastRef.current
    if (prev.length === 0) return

    const snapshot = prev[prev.length - 1]
    historyPastRef.current = prev.slice(0, -1)
    historyFutureRef.current = [...historyFutureRef.current, makeHistorySnapshot()].slice(-HISTORY_LIMIT)
    applyHistorySnapshot(snapshot)
    updateHistoryFlags()
  }, [applyHistorySnapshot, makeHistorySnapshot, updateHistoryFlags])

  const redo = useCallback(() => {
    const next = historyFutureRef.current
    if (next.length === 0) return

    const snapshot = next[next.length - 1]
    historyFutureRef.current = next.slice(0, -1)
    historyPastRef.current = [...historyPastRef.current, makeHistorySnapshot()].slice(-HISTORY_LIMIT)
    applyHistorySnapshot(snapshot)
    updateHistoryFlags()
  }, [applyHistorySnapshot, makeHistorySnapshot, updateHistoryFlags])

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      const raw = window.localStorage.getItem(PLAN_EDITOR_STORAGE_KEY)
      if (raw) {
        const parsed = parsePersistedPlanEditorState(JSON.parse(raw))
        if (parsed) {
          setTool(parsed.tool)
          setVertices(parsed.vertices)
          setSegments(parsed.segments)
          setLuminaires(parsed.luminaires)
          setSelection(parsed.selection)
          setPendingStart(parsed.pendingStart)
          setFaceMeta(parsed.faceMeta)
          pendingFaceMetaByPolygonRef.current = parsed.faceMetaByPolygon ?? null

          setDrawables(parsed.drawables)
          setLayers(parsed.layers)
          setActiveLayerId(parsed.activeLayerId)
          setBrushSize(parsed.brushSize)
          setBrushOpacity(parsed.brushOpacity)
          setBrushSmoothing(parsed.brushSmoothing)
          setBrushColor(parsed.brushColor)
        }
      }
    } catch {
      // Ignore corrupted persisted editor state and continue with defaults.
    } finally {
      setIsLoadedFromStorage(true)
    }
  }, [])

  useEffect(() => {
    if (!isLoadedFromStorage || typeof window === 'undefined') return

    const facesForPersistence = detectFaces(vertices, segments)
    const stateToPersist: PersistedPlanEditorState = {
      tool,
      vertices,
      segments,
      luminaires,
      selection,
      pendingStart,
      faceMeta,
      faceMetaByPolygon: facesForPersistence.reduce<Record<string, FaceMeta>>((acc, face) => {
        const meta = faceMeta[face.key]
        if (meta) {
          acc[canonicalPolygonSignature(face.points)] = meta
        }
        return acc
      }, {}),
      drawables,
      layers,
      activeLayerId,
      brushSize,
      brushOpacity,
      brushSmoothing,
      brushColor,
    }

    window.localStorage.setItem(PLAN_EDITOR_STORAGE_KEY, JSON.stringify(stateToPersist))
  }, [
    isLoadedFromStorage,
    tool,
    vertices,
    segments,
    luminaires,
    selection,
    pendingStart,
    faceMeta,
    drawables,
    layers,
    activeLayerId,
    brushSize,
    brushOpacity,
    brushSmoothing,
    brushColor,
  ])

  const layerById = useMemo(() => new Map(layers.map((layer) => [layer.id, layer])), [layers])
  const visibleLayerIds = useMemo(
    () => new Set(layers.filter((layer) => layer.visible).map((layer) => layer.id)),
    [layers],
  )

  const drawablesByLayer = useMemo(() => {
    const indexMap = new Map(layers.map((layer, index) => [layer.id, index]))
    return [...drawables]
      .filter((drawable) => visibleLayerIds.has(drawable.layerId))
      .sort((left, right) => {
        const layerDelta = (indexMap.get(left.layerId) ?? 0) - (indexMap.get(right.layerId) ?? 0)
        if (layerDelta !== 0) return layerDelta
        return drawables.findIndex((item) => item.id === left.id) - drawables.findIndex((item) => item.id === right.id)
      })
  }, [drawables, layers, visibleLayerIds])

  const vertexById = useMemo(() => new Map(vertices.map((v) => [v.id, v])), [vertices])
  const selfIntersections = useMemo(
    () => findSelfIntersections(vertices, segments),
    [vertices, segments],
  )

  const faces = useMemo(() => {
    if (selfIntersections.length > 0) return []
    return detectFaces(vertices, segments)
  }, [vertices, segments, selfIntersections.length])

  const orphanSegmentIds = useMemo(() => {
    const inFaces = new Set<string>()
    faces.forEach((face) => face.segmentIds.forEach((segmentId) => inFaces.add(segmentId)))
    return new Set(segments.filter((segment) => !inFaces.has(segment.id)).map((s) => s.id))
  }, [faces, segments])

  useEffect(() => {
    const pendingFaceMetaByPolygon = pendingFaceMetaByPolygonRef.current

    setFaceMeta((prev) => {
      const next: Record<string, FaceMeta> = {}
      faces.forEach((face) => {
        const byKey = prev[face.key]
        const byPolygon = pendingFaceMetaByPolygon
          ? pendingFaceMetaByPolygon[canonicalPolygonSignature(face.points)]
          : undefined
        next[face.key] = byKey ?? byPolygon ?? {
          ceilingHeight: DEFAULT_CEILING_HEIGHT,
          tableHeight: DEFAULT_TABLE_HEIGHT,
        }
      })
      return next
    })

    if (pendingFaceMetaByPolygon && faces.length > 0) {
      pendingFaceMetaByPolygonRef.current = null
    }

    if (selection?.type === 'face' && !faces.some((face) => face.key === selection.key)) {
      setSelection(null)
    }
    if (hovered?.type === 'face' && !faces.some((face) => face.key === hovered.key)) {
      setHovered(null)
    }
  }, [faces, selection, hovered])

  useEffect(() => {
    if (selection?.type !== 'drawable') return
    if (!drawables.some((drawable) => drawable.id === selection.id)) {
      setSelection(null)
    }
  }, [drawables, selection])

  useEffect(() => {
    if (!layers.some((layer) => layer.id === activeLayerId)) {
      setActiveLayerId(layers[0]?.id ?? DEFAULT_LAYER_ID)
    }
  }, [layers, activeLayerId])

  const roomFace = useMemo(() => {
    return faces.find((face) => faceMeta[face.key]?.role === 'room') ?? null
  }, [faces, faceMeta])

  const tableFaces = useMemo(() => {
    return faces.filter((face) => faceMeta[face.key]?.role === 'table')
  }, [faces, faceMeta])

  useEffect(() => {
    if (!roomFace) {
      clearRoom()
      setTablesStore([])
      setLuminairesStore([])
      return
    }

    const roomHeight = faceMeta[roomFace.key]?.ceilingHeight ?? DEFAULT_CEILING_HEIGHT

    setRoom({
      id: roomFace.key,
      polygon: roomFace.points,
      ceilingHeight: roomHeight,
    })

    const tables = tableFaces
      .filter((face) => isPolygonInside(face.points, roomFace.points))
      .map((face) => ({
        id: face.key,
        polygon: face.points,
        tableHeight: faceMeta[face.key]?.tableHeight ?? DEFAULT_TABLE_HEIGHT,
      }))

    setTablesStore(tables)

    const lightZ = Math.max(0.1, roomHeight - 0.1)
    const storeLuminaires = luminaires
      .filter((luminaire) => pointInPolygon(luminaire, roomFace.points))
      .map((luminaire) => ({
        id: luminaire.id,
        position: { x: luminaire.x, y: luminaire.y, z: lightZ },
        rotationDeg: 0,
        lumensPreset: luminaire.lumensPreset,
      }))

    setLuminairesStore(storeLuminaires)
  }, [
    roomFace,
    tableFaces,
    luminaires,
    faceMeta,
    setRoom,
    clearRoom,
    setTablesStore,
    setLuminairesStore,
  ])

  const hitDrawable = useCallback(
    (point: Point2D, extraPad = 0) => {
      const layerOrder = new Map(layers.map((layer, index) => [layer.id, index]))
      const sorted = [...drawables]
        .filter((drawable) => {
          const layer = layerById.get(drawable.layerId)
          return !!layer?.visible
        })
        .sort((left, right) => {
          const l = (layerOrder.get(left.layerId) ?? 0) - (layerOrder.get(right.layerId) ?? 0)
          if (l !== 0) return l
          return drawables.findIndex((item) => item.id === left.id) - drawables.findIndex((item) => item.id === right.id)
        })
        .reverse()

      for (const drawable of sorted) {
        if (drawable.type === 'path') {
          const threshold = Math.max(0.12, drawable.width * 0.6) + extraPad
          for (let i = 1; i < drawable.points.length; i += 1) {
            const a = drawable.points[i - 1]
            const b = drawable.points[i]
            if (pointToSegmentDistance(point, a, b) <= threshold) {
              return drawable
            }
          }
        }

        if (drawable.type === 'line' || drawable.type === 'arrow') {
          const threshold = Math.max(0.12, drawable.width * 0.7) + extraPad
          if (pointToSegmentDistance(point, drawable.start, drawable.end) <= threshold) {
            return drawable
          }
        }

        if (drawable.type === 'rectangle') {
          const threshold = Math.max(0.1, drawable.width * 0.9) + extraPad
          const b = rectBounds(drawable.start, drawable.end)
          const onHorizontal =
            point.x >= b.x - threshold &&
            point.x <= b.x + b.width + threshold &&
            (Math.abs(point.y - b.y) <= threshold || Math.abs(point.y - (b.y + b.height)) <= threshold)
          const onVertical =
            point.y >= b.y - threshold &&
            point.y <= b.y + b.height + threshold &&
            (Math.abs(point.x - b.x) <= threshold || Math.abs(point.x - (b.x + b.width)) <= threshold)
          if (onHorizontal || onVertical || pointInRect(point, drawable.start, drawable.end, threshold * 0.4)) {
            return drawable
          }
        }

        if (drawable.type === 'highlight') {
          if (pointInRect(point, drawable.start, drawable.end, extraPad + 0.08)) {
            return drawable
          }
        }
      }

      return null
    },
    [drawables, layerById, layers],
  )

  const eraseAtPoint = useCallback(
    (point: Point2D) => {
      const radius = Math.max(0.18, brushSize * 0.7)
      let changed = false
      setDrawables((prev) => {
        const next = prev.filter((drawable) => {
          const hit = hitDrawable(point, radius)
          if (hit?.id === drawable.id) {
            changed = true
            return false
          }
          return true
        })
        return next
      })
      if (changed && selectionRef.current?.type === 'drawable') {
        setSelection(null)
      }
      return changed
    },
    [brushSize, hitDrawable],
  )

  useEffect(() => {
    const isTextInputTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextInputTarget(event.target)) return

      const key = event.key.toLowerCase()
      const withMeta = event.ctrlKey || event.metaKey

      if (withMeta && key === 'z' && !event.shiftKey) {
        event.preventDefault()
        undo()
        return
      }

      if (withMeta && (key === 'y' || (event.shiftKey && key === 'z'))) {
        event.preventDefault()
        redo()
        return
      }

      if (event.key === 'Escape') {
        setPendingStart(null)
        setDragState(null)
        setDrawableDragState(null)
        setPathDraft(null)
        setShapeDraft(null)
        setEraserActive(false)
      }

      if (event.key === 'Delete' && selection?.type === 'segment') {
        event.preventDefault()
        setSegments((prev) => prev.filter((segment) => segment.id !== selection.id))
        setSelection(null)
      }

      if (event.key === 'Delete' && selection?.type === 'drawable') {
        event.preventDefault()
        pushHistory()
        setDrawables((prev) => prev.filter((drawable) => drawable.id !== selection.id))
        setSelection(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [redo, selection, undo, pushHistory])

  const upsertVertex = (point: Point2D, pool: Vertex[]) => {
    const existing = pool.find((vertex) => distance(vertex, point) <= SNAP_DISTANCE)
    if (existing) return existing.id
    const id = createId('v')
    pool.push({ id, ...point })
    return id
  }

  const hitTestAtPoint = (point: Point2D): Selection => {
    const hitDraw = hitDrawable(point)
    if (hitDraw) {
      return { type: 'drawable', id: hitDraw.id }
    }

    const coincidentVertices = vertices.filter((vertex) => distance(vertex, point) <= HIT_VERTEX)
    if (coincidentVertices.length > 0) {
      return { type: 'vertex', id: coincidentVertices[0].id }
    }

    const nearestSegment = segments
      .map((segment) => {
        const a = vertexById.get(segment.a)
        const b = vertexById.get(segment.b)
        if (!a || !b) return null
        return {
          id: segment.id,
          dist: pointToSegmentDistance(point, a, b),
        }
      })
      .filter((item): item is { id: string; dist: number } => item !== null)
      .sort((left, right) => left.dist - right.dist)[0]

    if (nearestSegment && nearestSegment.dist <= HIT_SEGMENT) {
      return { type: 'segment', id: nearestSegment.id }
    }

    const containingFace = faces
      .filter((face) => pointInPolygon(point, face.points))
      .sort((left, right) => Math.abs(left.area) - Math.abs(right.area))[0]

    if (containingFace) {
      return { type: 'face', key: containingFace.key }
    }

    const luminaireHit = luminaires
      .map((luminaire) => ({
        id: luminaire.id,
        dist: distance(point, luminaire),
      }))
      .sort((left, right) => left.dist - right.dist)[0]

    if (luminaireHit && luminaireHit.dist <= HIT_VERTEX) {
      return { type: 'luminaire', id: luminaireHit.id }
    }

    return null
  }

  const startVertexDrag = (point: Point2D, vertexId: string) => {
    const base = vertexById.get(vertexId)
    if (!base) return

    const moving = vertices
      .filter((vertex) => distance(vertex, base) <= COINCIDENT_DISTANCE)
      .map((vertex) => vertex.id)

    const origin = new Map<string, Point2D>()
    moving.forEach((id) => {
      const vertex = vertexById.get(id)
      if (vertex) origin.set(id, { x: vertex.x, y: vertex.y })
    })

    setDragState({
      vertexIds: moving,
      pointerStart: point,
      origin,
    })
  }

  const startDrawableDrag = (point: Point2D, drawable: Drawable) => {
    const layer = layerById.get(drawable.layerId)
    if (!layer || layer.locked || !layer.visible) {
      setMessage('Слой скрыт или заблокирован. Разблокируйте слой для перемещения объекта.')
      return
    }

    pushHistory()
    setDrawableDragState({
      drawableId: drawable.id,
      pointerStart: point,
      origin: drawable.type === 'path'
        ? { ...drawable, points: drawable.points.map((p) => ({ ...p })) }
        : { ...drawable, start: { ...drawable.start }, end: { ...drawable.end } },
    })
  }

  const buildShapeFromDraft = (
    currentTool: Tool,
    start: Point2D,
    end: Point2D,
    layerId: string,
  ): LineDrawable | RectDrawable | null => {
    if (currentTool === 'line' || currentTool === 'arrow') {
      return {
        id: createId('d'),
        type: currentTool,
        start,
        end,
        layerId,
        color: brushColor,
        width: brushSize,
        opacity: brushOpacity,
      }
    }

    if (currentTool === 'rectangle' || currentTool === 'highlight') {
      return {
        id: createId('d'),
        type: currentTool,
        start,
        end,
        layerId,
        color: brushColor,
        width: brushSize,
        opacity: brushOpacity,
      }
    }

    return null
  }

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return

    const rawPoint = toScreenPoint(svg, event.clientX, event.clientY)
    const point = snapPoint(rawPoint)
    setSnappedCursorPoint(point)
    setMessage('')

    if (tool === 'brush') {
      const activeLayer = layerById.get(activeLayerId)
      if (!activeLayer || activeLayer.locked || !activeLayer.visible) {
        setMessage('Выберите видимый и разблокированный слой для рисования.')
        return
      }

      pushHistory()
      const widthWithPressure = brushSize * clamp(event.pressure || 1, 0.5, 1.6)
      setPathDraft({
        id: createId('d'),
        type: 'path',
        layerId: activeLayer.id,
        points: [point],
        color: brushColor,
        width: clamp(widthWithPressure, 0.02, 2),
        opacity: brushOpacity,
      })
      return
    }

    if (tool === 'eraser') {
      pushHistory()
      setEraserActive(true)
      eraseAtPoint(point)
      return
    }

    if (tool === 'line' || tool === 'rectangle' || tool === 'arrow' || tool === 'highlight') {
      const activeLayer = layerById.get(activeLayerId)
      if (!activeLayer || activeLayer.locked || !activeLayer.visible) {
        setMessage('Выберите видимый и разблокированный слой для рисования.')
        return
      }

      const draft = buildShapeFromDraft(tool, point, point, activeLayer.id)
      if (!draft) return
      pushHistory()
      setShapeDraft(draft)
      return
    }

    if (tool === 'segment') {
      setMessage('')
      const nextVertices = [...vertices]

      if (!pendingStart) {
        const startId = upsertVertex(point, nextVertices)
        setVertices(nextVertices)
        setPendingStart(startId)
        return
      }

      const start = nextVertices.find((vertex) => vertex.id === pendingStart)
      if (!start) {
        const startId = upsertVertex(point, nextVertices)
        setVertices(nextVertices)
        setPendingStart(startId)
        return
      }

      const dx = Math.abs(point.x - start.x)
      const dy = Math.abs(point.y - start.y)
      const endPoint = dx >= dy ? { x: point.x, y: start.y } : { x: start.x, y: point.y }

      const endId = upsertVertex(snapPoint(endPoint), nextVertices)
      setVertices(nextVertices)

      if (endId === start.id) return

      const edge = undirectedEdgeKey(start.id, endId)
      const exists = segments.some((segment) => undirectedEdgeKey(segment.a, segment.b) === edge)
      if (!exists) {
        setSegments([...segments, { id: createId('s'), a: start.id, b: endId }])
      }
      setPendingStart(endId)

      return
    }

    if (tool === 'luminaire') {
      if (roomFace && !pointInPolygon(point, roomFace.points)) {
        setMessage('Светильник можно поставить только внутри room-контура.')
        return
      }

      const luminaire = {
        id: createId('l'),
        x: point.x,
        y: point.y,
        lumensPreset: 1000 as LumensPreset,
      }

      setLuminaires((prev) => [...prev, luminaire])
      setSelection({ type: 'luminaire', id: luminaire.id })
      return
    }

    const hit = hitTestAtPoint(point)
    setSelection(hit)

    if (hit?.type === 'drawable') {
      const drawable = drawables.find((item) => item.id === hit.id)
      if (drawable) {
        startDrawableDrag(point, drawable)
      }
      return
    }

    const hitVertex = vertices.find((vertex) => distance(vertex, point) <= HIT_VERTEX)
    if (hitVertex) {
      startVertexDrag(point, hitVertex.id)
    }
  }

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return

    const rawPointer = toScreenPoint(svg, event.clientX, event.clientY)
    const pointer = snapPoint(rawPointer)
    setSnappedCursorPoint(pointer)
    setHovered(hitTestAtPoint(pointer))

    if (pathDraft) {
      const last = pathDraft.points[pathDraft.points.length - 1]
      const smoothed = smoothPoint(last, pointer, brushSmoothing)
      if (distance(last, smoothed) < 0.04) return
      setPathDraft((prev) => {
        if (!prev) return prev
        return {
          ...prev,
          points: [...prev.points, smoothed],
        }
      })
      return
    }

    if (shapeDraft) {
      setShapeDraft((prev) => (prev ? { ...prev, end: pointer } : prev))
      return
    }

    if (eraserActive) {
      eraseAtPoint(pointer)
      return
    }

    if (drawableDragState && tool === 'select') {
      const dx = pointer.x - drawableDragState.pointerStart.x
      const dy = pointer.y - drawableDragState.pointerStart.y

      setDrawables((prev) =>
        prev.map((drawable) => {
          if (drawable.id !== drawableDragState.drawableId) return drawable
          const source = drawableDragState.origin
          if (source.type === 'path') {
            return {
              ...drawable,
              points: source.points.map((p) => ({ x: clamp(snap(p.x + dx), 0, VIEW_SIZE), y: clamp(snap(p.y + dy), 0, VIEW_SIZE) })),
            }
          }

          return {
            ...drawable,
            start: {
              x: clamp(snap(source.start.x + dx), 0, VIEW_SIZE),
              y: clamp(snap(source.start.y + dy), 0, VIEW_SIZE),
            },
            end: {
              x: clamp(snap(source.end.x + dx), 0, VIEW_SIZE),
              y: clamp(snap(source.end.y + dy), 0, VIEW_SIZE),
            },
          }
        }),
      )
      return
    }

    if (!dragState || tool !== 'select') return

    const dx = pointer.x - dragState.pointerStart.x
    const dy = pointer.y - dragState.pointerStart.y

    setVertices((prev) =>
      prev.map((vertex) => {
        if (!dragState.vertexIds.includes(vertex.id)) return vertex
        const origin = dragState.origin.get(vertex.id)
        if (!origin) return vertex
        return {
          ...vertex,
          x: snap(origin.x + dx),
          y: snap(origin.y + dy),
        }
      }),
    )
  }

  const onPointerUp = () => {
    if (pathDraft) {
      if (pathDraft.points.length > 1) {
        setDrawables((prev) => [...prev, pathDraft])
        setSelection({ type: 'drawable', id: pathDraft.id })
      }
      setPathDraft(null)
    }

    if (shapeDraft) {
      const isLargeEnough = distance(shapeDraft.start, shapeDraft.end) >= 0.1
      if (isLargeEnough) {
        setDrawables((prev) => [...prev, shapeDraft])
        setSelection({ type: 'drawable', id: shapeDraft.id })
      }
      setShapeDraft(null)
    }

    setEraserActive(false)

    if (dragState) {
      const merged = mergeVertices(vertices, segments)
      setVertices(merged.vertices)
      setSegments(merged.segments)
      setDragState(null)
    }

    if (drawableDragState) {
      setDrawableDragState(null)
    }
  }

  const onPointerLeave = () => {
    setHovered(null)
    setSnappedCursorPoint(null)
    onPointerUp()
  }

  const selectedFace =
    selection?.type === 'face' ? faces.find((face) => face.key === selection.key) : null
  const selectedLuminaire =
    selection?.type === 'luminaire'
      ? luminaires.find((luminaire) => luminaire.id === selection.id)
      : null
  const selectedDrawable =
    selection?.type === 'drawable'
      ? drawables.find((drawable) => drawable.id === selection.id)
      : null

  const assignFaceRole = (role: FaceRole | '') => {
    if (!selectedFace) return

    if (role === 'table') {
      if (!roomFace) {
        setMessage('Сначала назначьте room-контур, затем table.')
        return
      }
      if (!isPolygonInside(selectedFace.points, roomFace.points)) {
        setMessage('Table-контур должен быть внутри room.')
        return
      }
    }

    setFaceMeta((prev) => {
      const next = { ...prev }

      if (role === 'room') {
        Object.keys(next).forEach((key) => {
          if (next[key].role === 'room' && key !== selectedFace.key) {
            next[key] = { ...next[key], role: undefined }
          }
        })
      }

      next[selectedFace.key] = {
        ceilingHeight: next[selectedFace.key]?.ceilingHeight ?? DEFAULT_CEILING_HEIGHT,
        tableHeight: next[selectedFace.key]?.tableHeight ?? DEFAULT_TABLE_HEIGHT,
        role: role || undefined,
      }

      return next
    })

    if (role === 'room') {
      onRoomAssigned?.()
    }

    setMessage('')
  }

  const updateFaceHeight = (field: 'ceilingHeight' | 'tableHeight', value: number) => {
    if (!selectedFace || Number.isNaN(value)) return

    setFaceMeta((prev) => ({
      ...prev,
      [selectedFace.key]: {
        ceilingHeight: prev[selectedFace.key]?.ceilingHeight ?? DEFAULT_CEILING_HEIGHT,
        tableHeight: prev[selectedFace.key]?.tableHeight ?? DEFAULT_TABLE_HEIGHT,
        role: prev[selectedFace.key]?.role,
        [field]: Math.max(0.1, value),
      },
    }))
  }

  const updateLumens = (value: LumensPreset) => {
    if (!selectedLuminaire) return
    setLuminaires((prev) =>
      prev.map((luminaire) =>
        luminaire.id === selectedLuminaire.id ? { ...luminaire, lumensPreset: value } : luminaire,
      ),
    )
  }

  const updateSelectedDrawableLayer = (nextLayerId: string) => {
    if (!selectedDrawable) return
    if (!layers.some((layer) => layer.id === nextLayerId)) return

    pushHistory()
    setDrawables((prev) =>
      prev.map((drawable) =>
        drawable.id === selectedDrawable.id ? { ...drawable, layerId: nextLayerId } : drawable,
      ),
    )
  }

  const bringSelectedDrawable = (direction: 'front' | 'back') => {
    if (!selectedDrawable) return
    pushHistory()

    setDrawables((prev) => {
      const index = prev.findIndex((drawable) => drawable.id === selectedDrawable.id)
      if (index < 0) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      if (direction === 'front') {
        next.push(item)
      } else {
        next.unshift(item)
      }
      return next
    })
  }

  const addLayer = () => {
    pushHistory()
    const id = createId('layer')
    setLayers((prev) => [
      ...prev,
      { id, name: `Layer ${prev.length + 1}`, visible: true, locked: false },
    ])
    setActiveLayerId(id)
  }

  const updateLayer = (layerId: string, patch: Partial<DrawingLayer>) => {
    pushHistory()
    setLayers((prev) =>
      prev.map((layer) => (layer.id === layerId ? { ...layer, ...patch } : layer)),
    )
  }

  const removeLayer = (layerId: string) => {
    if (layers.length <= 1) {
      setMessage('Нужен минимум один слой.')
      return
    }

    pushHistory()

    const fallbackLayer = layers.find((layer) => layer.id !== layerId)
    if (!fallbackLayer) return

    setDrawables((prev) =>
      prev.map((drawable) =>
        drawable.layerId === layerId ? { ...drawable, layerId: fallbackLayer.id } : drawable,
      ),
    )

    setLayers((prev) => prev.filter((layer) => layer.id !== layerId))
    setActiveLayerId((prev) => (prev === layerId ? fallbackLayer.id : prev))
  }

  const moveLayer = (layerId: string, direction: 'up' | 'down') => {
    pushHistory()
    setLayers((prev) => {
      const index = prev.findIndex((layer) => layer.id === layerId)
      if (index < 0) return prev
      const target = direction === 'up' ? index + 1 : index - 1
      if (target < 0 || target >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return next
    })
  }

  const clearEditor = () => {
    setVertices([])
    setSegments([])
    setLuminaires([])
    setFaceMeta({})
    setSelection(null)
    setPendingStart(null)
    setMessage('')

    setDrawables([])
    setLayers([{ id: DEFAULT_LAYER_ID, name: 'Layer 1', visible: true, locked: false }])
    setActiveLayerId(DEFAULT_LAYER_ID)

    historyPastRef.current = []
    historyFutureRef.current = []
    updateHistoryFlags()
  }

  const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const renderArrowHead = (start: Point2D, end: Point2D, width: number) => {
    const angle = Math.atan2(end.y - start.y, end.x - start.x)
    const size = Math.max(0.25, width * 2.4)
    const spread = Math.PI / 7
    const p1 = {
      x: end.x - size * Math.cos(angle - spread),
      y: end.y - size * Math.sin(angle - spread),
    }
    const p2 = {
      x: end.x - size * Math.cos(angle + spread),
      y: end.y - size * Math.sin(angle + spread),
    }
    return `${end.x},${end.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`
  }

  const buildSvgMarkup = () => {
    const polygons = faces
      .map((face) => {
        const role = faceMeta[face.key]?.role
        const fill =
          role === 'room'
            ? 'rgba(14,116,144,0.16)'
            : role === 'table'
              ? 'rgba(22,163,74,0.22)'
              : 'rgba(99,102,241,0.08)'
        return `<polygon points="${face.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="${fill}" />`
      })
      .join('')

    const segmentLines = segments
      .map((segment) => {
        const a = vertexById.get(segment.a)
        const b = vertexById.get(segment.b)
        if (!a || !b) return ''
        return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="#334155" stroke-width="0.06" />`
      })
      .join('')

    const luminaireNodes = luminaires
      .map(
        (luminaire) =>
          `<circle cx="${luminaire.x}" cy="${luminaire.y}" r="0.14" fill="#facc15" stroke="#854d0e" stroke-width="0.04" />`,
      )
      .join('')

    const drawableNodes = drawablesByLayer
      .map((drawable) => {
        if (drawable.type === 'path') {
          return `<polyline points="${drawable.points.map((p) => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="${drawable.color}" stroke-width="${drawable.width}" stroke-opacity="${drawable.opacity}" stroke-linecap="round" stroke-linejoin="round" />`
        }

        if (drawable.type === 'line') {
          return `<line x1="${drawable.start.x}" y1="${drawable.start.y}" x2="${drawable.end.x}" y2="${drawable.end.y}" stroke="${drawable.color}" stroke-width="${drawable.width}" stroke-opacity="${drawable.opacity}" stroke-linecap="round" />`
        }

        if (drawable.type === 'arrow') {
          return `<g><line x1="${drawable.start.x}" y1="${drawable.start.y}" x2="${drawable.end.x}" y2="${drawable.end.y}" stroke="${drawable.color}" stroke-width="${drawable.width}" stroke-opacity="${drawable.opacity}" stroke-linecap="round" /><polygon points="${renderArrowHead(drawable.start, drawable.end, drawable.width)}" fill="${drawable.color}" fill-opacity="${drawable.opacity}" /></g>`
        }

        const bounds = rectBounds(drawable.start, drawable.end)

        if (drawable.type === 'rectangle') {
          return `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="none" stroke="${drawable.color}" stroke-width="${drawable.width}" stroke-opacity="${drawable.opacity}" />`
        }

        return `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="${toRgba(drawable.color, drawable.opacity * 0.35)}" stroke="${drawable.color}" stroke-width="${Math.max(0.02, drawable.width * 0.5)}" stroke-opacity="${Math.min(1, drawable.opacity * 0.8)}" />`
      })
      .join('')

    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_SIZE} ${VIEW_SIZE}">\n  <rect x="0" y="0" width="${VIEW_SIZE}" height="${VIEW_SIZE}" fill="#ffffff" />\n  ${polygons}\n  ${segmentLines}\n  ${luminaireNodes}\n  ${drawableNodes}\n</svg>`
  }

  const exportJson = () => {
    const payload = {
      tool,
      vertices,
      segments,
      luminaires,
      faceMeta,
      drawables,
      layers,
      activeLayerId,
      brush: {
        size: brushSize,
        opacity: brushOpacity,
        smoothing: brushSmoothing,
        color: brushColor,
      },
      exportedAt: new Date().toISOString(),
    }

    downloadBlob(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `light-editor-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`,
    )
  }

  const exportSvg = () => {
    downloadBlob(
      new Blob([buildSvgMarkup()], { type: 'image/svg+xml;charset=utf-8' }),
      `light-editor-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.svg`,
    )
  }

  const exportPng = async () => {
    const svgText = buildSvgMarkup()
    const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
    const svgUrl = URL.createObjectURL(svgBlob)

    try {
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Не удалось подготовить SVG для PNG экспорта.'))
        img.src = svgUrl
      })

      const scale = 80
      const canvas = document.createElement('canvas')
      canvas.width = VIEW_SIZE * scale
      canvas.height = VIEW_SIZE * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Не удалось создать canvas контекст для PNG.')

      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

      canvas.toBlob((blob) => {
        if (!blob) {
          setMessage('Не удалось сформировать PNG файл.')
          return
        }
        downloadBlob(
          blob,
          `light-editor-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`,
        )
      }, 'image/png')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Ошибка экспорта PNG.')
    } finally {
      URL.revokeObjectURL(svgUrl)
    }
  }

  const invalidTables = roomFace
    ? tableFaces.filter((face) => !isPolygonInside(face.points, roomFace.points)).length
    : tableFaces.length

  const invalidLuminaires = roomFace
    ? luminaires.filter((luminaire) => !pointInPolygon(luminaire, roomFace.points)).length
    : luminaires.length

  return (
    <div className="grid h-full gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button variant={tool === 'select' ? 'default' : 'outline'} onClick={() => setTool('select')}>
            Select
          </Button>
          <Button variant={tool === 'segment' ? 'default' : 'outline'} onClick={() => setTool('segment')}>
            Add Segment
          </Button>
          <Button
            variant={tool === 'luminaire' ? 'default' : 'outline'}
            onClick={() => setTool('luminaire')}
          >
            Add Luminaire
          </Button>
          <Button variant={tool === 'brush' ? 'default' : 'outline'} onClick={() => setTool('brush')}>
            Brush
          </Button>
          <Button variant={tool === 'eraser' ? 'default' : 'outline'} onClick={() => setTool('eraser')}>
            Eraser
          </Button>
          <Button variant={tool === 'line' ? 'default' : 'outline'} onClick={() => setTool('line')}>
            Line
          </Button>
          <Button variant={tool === 'rectangle' ? 'default' : 'outline'} onClick={() => setTool('rectangle')}>
            Rectangle
          </Button>
          <Button variant={tool === 'arrow' ? 'default' : 'outline'} onClick={() => setTool('arrow')}>
            Arrow
          </Button>
          <Button variant={tool === 'highlight' ? 'default' : 'outline'} onClick={() => setTool('highlight')}>
            Highlight
          </Button>
          <Button variant="outline" onClick={undo} disabled={!canUndo}>
            Undo
          </Button>
          <Button variant="outline" onClick={redo} disabled={!canRedo}>
            Redo
          </Button>
          <Button variant="outline" onClick={clearEditor}>
            Clear
          </Button>
          {pendingStart && tool === 'segment' ? (
            <span className="self-center text-xs text-muted-foreground">
              Segment mode: choose end point (Esc to cancel chain)
            </span>
          ) : null}
        </div>

        <div className="grid gap-2 rounded-lg border bg-card p-3 md:grid-cols-2">
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Brush color</span>
            <input
              type="color"
              className="h-9 w-full cursor-pointer rounded border"
              value={brushColor}
              onChange={(event) => setBrushColor(event.target.value)}
            />
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Brush size</span>
            <input
              type="range"
              min={0.02}
              max={1}
              step={0.01}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
            <div className="text-[11px] text-muted-foreground">{brushSize.toFixed(2)} m</div>
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Brush opacity</span>
            <input
              type="range"
              min={0.05}
              max={1}
              step={0.01}
              value={brushOpacity}
              onChange={(event) => setBrushOpacity(Number(event.target.value))}
            />
            <div className="text-[11px] text-muted-foreground">{Math.round(brushOpacity * 100)}%</div>
          </label>
          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">Brush smoothing</span>
            <input
              type="range"
              min={0}
              max={0.95}
              step={0.01}
              value={brushSmoothing}
              onChange={(event) => setBrushSmoothing(Number(event.target.value))}
            />
            <div className="text-[11px] text-muted-foreground">{brushSmoothing.toFixed(2)}</div>
          </label>
          <div className="flex flex-wrap items-end gap-2 md:col-span-2">
            <Button size="sm" variant="outline" onClick={exportJson}>
              Export JSON
            </Button>
            <Button size="sm" variant="outline" onClick={exportSvg}>
              Export SVG
            </Button>
            <Button size="sm" variant="outline" onClick={exportPng}>
              Export PNG
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Undo/Redo: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+Y
            </span>
          </div>
        </div>

        <div className="h-[520px] rounded-lg border bg-card">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${VIEW_SIZE} ${VIEW_SIZE}`}
            className="h-full w-full"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerLeave}
          >
            <defs>
              <pattern id="plan-grid" patternUnits="userSpaceOnUse" width={GRID_STEP} height={GRID_STEP}>
                <path
                  d={`M ${GRID_STEP} 0 L 0 0 0 ${GRID_STEP}`}
                  fill="none"
                  stroke="rgba(2,6,23,0.20)"
                  strokeWidth={0.01}
                />
              </pattern>
            </defs>

            <rect x={0} y={0} width={VIEW_SIZE} height={VIEW_SIZE} fill="url(#plan-grid)" />

            {faces.map((face) => {
              const role = faceMeta[face.key]?.role
              const isHovered = hovered?.type === 'face' && hovered.key === face.key
              const isSelected = selection?.type === 'face' && selection.key === face.key
              const fill =
                role === 'room'
                  ? isHovered
                    ? 'rgba(14,116,144,0.24)'
                    : 'rgba(14,116,144,0.16)'
                  : role === 'table'
                    ? isHovered
                      ? 'rgba(22,163,74,0.30)'
                      : 'rgba(22,163,74,0.22)'
                    : isHovered
                      ? 'rgba(99,102,241,0.16)'
                      : 'rgba(99,102,241,0.08)'
              const stroke = isSelected ? '#0f172a' : isHovered ? '#334155' : 'transparent'
              const strokeWidth = isSelected ? 0.12 : isHovered ? 0.08 : 0.05
              const points = face.points.map((point) => `${point.x},${point.y}`).join(' ')
              return (
                <polygon key={face.key} points={points} fill={fill} stroke={stroke} strokeWidth={strokeWidth} />
              )
            })}

            {segments.map((segment) => {
              const a = vertexById.get(segment.a)
              const b = vertexById.get(segment.b)
              if (!a || !b) return null

              const isSelected = selection?.type === 'segment' && selection.id === segment.id
              const isHovered = hovered?.type === 'segment' && hovered.id === segment.id
              const isOrphan = orphanSegmentIds.has(segment.id)

              return (
                <line
                  key={segment.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke={
                    isSelected ? '#0f172a' : isHovered ? '#0369a1' : isOrphan ? '#f97316' : '#334155'
                  }
                  strokeWidth={isSelected ? 0.11 : isHovered ? 0.09 : 0.06}
                />
              )
            })}

            {vertices.map((vertex) => {
              const selected = selection?.type === 'vertex' && selection.id === vertex.id
              const isHovered = hovered?.type === 'vertex' && hovered.id === vertex.id
              return (
                <circle
                  key={vertex.id}
                  cx={vertex.x}
                  cy={vertex.y}
                  r={selected ? 0.16 : isHovered ? 0.14 : 0.11}
                  fill={selected ? '#0f172a' : isHovered ? '#0369a1' : '#475569'}
                />
              )
            })}

            {luminaires.map((luminaire) => {
              const selected = selection?.type === 'luminaire' && selection.id === luminaire.id
              return (
                <g key={luminaire.id}>
                  <circle
                    cx={luminaire.x}
                    cy={luminaire.y}
                    r={selected ? 0.18 : 0.14}
                    fill={selected ? '#ca8a04' : '#facc15'}
                    stroke="#854d0e"
                    strokeWidth={0.04}
                  />
                </g>
              )
            })}

            {drawablesByLayer.map((drawable) => {
              const selected = selection?.type === 'drawable' && selection.id === drawable.id
              const hoveredDrawable = hovered?.type === 'drawable' && hovered.id === drawable.id

              if (drawable.type === 'path') {
                return (
                  <polyline
                    key={drawable.id}
                    points={drawable.points.map((p) => `${p.x},${p.y}`).join(' ')}
                    fill="none"
                    stroke={drawable.color}
                    strokeWidth={selected ? drawable.width * 1.2 : drawable.width}
                    strokeOpacity={drawable.opacity}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ filter: hoveredDrawable ? 'brightness(1.08)' : undefined }}
                  />
                )
              }

              if (drawable.type === 'line') {
                return (
                  <line
                    key={drawable.id}
                    x1={drawable.start.x}
                    y1={drawable.start.y}
                    x2={drawable.end.x}
                    y2={drawable.end.y}
                    stroke={drawable.color}
                    strokeWidth={selected ? drawable.width * 1.2 : drawable.width}
                    strokeOpacity={drawable.opacity}
                    strokeLinecap="round"
                    style={{ filter: hoveredDrawable ? 'brightness(1.08)' : undefined }}
                  />
                )
              }

              if (drawable.type === 'arrow') {
                return (
                  <g key={drawable.id}>
                    <line
                      x1={drawable.start.x}
                      y1={drawable.start.y}
                      x2={drawable.end.x}
                      y2={drawable.end.y}
                      stroke={drawable.color}
                      strokeWidth={selected ? drawable.width * 1.2 : drawable.width}
                      strokeOpacity={drawable.opacity}
                      strokeLinecap="round"
                      style={{ filter: hoveredDrawable ? 'brightness(1.08)' : undefined }}
                    />
                    <polygon
                      points={renderArrowHead(drawable.start, drawable.end, selected ? drawable.width * 1.2 : drawable.width)}
                      fill={drawable.color}
                      fillOpacity={drawable.opacity}
                    />
                  </g>
                )
              }

              const bounds = rectBounds(drawable.start, drawable.end)
              if (drawable.type === 'rectangle') {
                return (
                  <rect
                    key={drawable.id}
                    x={bounds.x}
                    y={bounds.y}
                    width={bounds.width}
                    height={bounds.height}
                    fill="none"
                    stroke={drawable.color}
                    strokeOpacity={drawable.opacity}
                    strokeWidth={selected ? drawable.width * 1.2 : drawable.width}
                    style={{ filter: hoveredDrawable ? 'brightness(1.08)' : undefined }}
                  />
                )
              }

              return (
                <rect
                  key={drawable.id}
                  x={bounds.x}
                  y={bounds.y}
                  width={bounds.width}
                  height={bounds.height}
                  fill={toRgba(drawable.color, drawable.opacity * 0.35)}
                  stroke={drawable.color}
                  strokeWidth={Math.max(0.02, drawable.width * 0.5)}
                  strokeOpacity={Math.min(1, drawable.opacity * 0.8)}
                  style={{ filter: hoveredDrawable ? 'brightness(1.08)' : undefined }}
                />
              )
            })}

            {pathDraft ? (
              <polyline
                points={pathDraft.points.map((p) => `${p.x},${p.y}`).join(' ')}
                fill="none"
                stroke={pathDraft.color}
                strokeWidth={pathDraft.width}
                strokeOpacity={pathDraft.opacity}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}

            {shapeDraft ? (
              shapeDraft.type === 'line' ? (
                <line
                  x1={shapeDraft.start.x}
                  y1={shapeDraft.start.y}
                  x2={shapeDraft.end.x}
                  y2={shapeDraft.end.y}
                  stroke={shapeDraft.color}
                  strokeWidth={shapeDraft.width}
                  strokeOpacity={shapeDraft.opacity}
                  strokeDasharray="0.2 0.1"
                />
              ) : shapeDraft.type === 'arrow' ? (
                <g>
                  <line
                    x1={shapeDraft.start.x}
                    y1={shapeDraft.start.y}
                    x2={shapeDraft.end.x}
                    y2={shapeDraft.end.y}
                    stroke={shapeDraft.color}
                    strokeWidth={shapeDraft.width}
                    strokeOpacity={shapeDraft.opacity}
                    strokeDasharray="0.2 0.1"
                  />
                  <polygon
                    points={renderArrowHead(shapeDraft.start, shapeDraft.end, shapeDraft.width)}
                    fill={shapeDraft.color}
                    fillOpacity={shapeDraft.opacity}
                  />
                </g>
              ) : (
                (() => {
                  const b = rectBounds(shapeDraft.start, shapeDraft.end)
                  if (shapeDraft.type === 'rectangle') {
                    return (
                      <rect
                        x={b.x}
                        y={b.y}
                        width={b.width}
                        height={b.height}
                        fill="none"
                        stroke={shapeDraft.color}
                        strokeWidth={shapeDraft.width}
                        strokeOpacity={shapeDraft.opacity}
                        strokeDasharray="0.2 0.1"
                      />
                    )
                  }

                  return (
                    <rect
                      x={b.x}
                      y={b.y}
                      width={b.width}
                      height={b.height}
                      fill={toRgba(shapeDraft.color, shapeDraft.opacity * 0.35)}
                      stroke={shapeDraft.color}
                      strokeWidth={Math.max(0.02, shapeDraft.width * 0.5)}
                      strokeOpacity={Math.min(1, shapeDraft.opacity * 0.8)}
                      strokeDasharray="0.2 0.1"
                    />
                  )
                })()
              )
            ) : null}

            {snappedCursorPoint ? (
              <circle
                cx={snappedCursorPoint.x}
                cy={snappedCursorPoint.y}
                r={tool === 'eraser' ? Math.max(0.18, brushSize * 0.7) : 0.12}
                fill="none"
                stroke={tool === 'eraser' ? '#dc2626' : '#ef4444'}
                strokeWidth={0.05}
                strokeDasharray={tool === 'eraser' ? '0.12 0.08' : undefined}
              />
            ) : null}
          </svg>
        </div>

        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>Vertices: {vertices.length}</span>
          <span>Segments: {segments.length}</span>
          <span>Faces: {faces.length}</span>
          <span>Drawings: {drawables.length}</span>
          <span>Layers: {layers.length}</span>
          <span>Orphan segments: {orphanSegmentIds.size}</span>
          <span>Intersections: {selfIntersections.length}</span>
        </div>

        {message ? <p className="text-sm text-amber-600">{message}</p> : null}
      </div>

      <aside className="space-y-3 rounded-lg border bg-card p-3">
        <h3 className="text-sm font-semibold">2D Properties</h3>

        <div className="text-xs text-muted-foreground">
          <div>Room assigned: {roomFace ? 'yes' : 'no'}</div>
          <div>Tables outside room: {invalidTables}</div>
          <div>Luminaires outside room: {invalidLuminaires}</div>
        </div>

        <div className="space-y-2 rounded-md border p-2">
          <div className="text-xs font-medium">Layers</div>
          <div className="space-y-1">
            {layers.map((layer, index) => (
              <div
                key={layer.id}
                className={`rounded border px-2 py-1 text-xs ${activeLayerId === layer.id ? 'border-primary bg-primary/5' : 'border-border'}`}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left"
                    onClick={() => setActiveLayerId(layer.id)}
                  >
                    {layer.name}
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded border px-1"
                      onClick={() => updateLayer(layer.id, { visible: !layer.visible })}
                    >
                      {layer.visible ? 'Visible' : 'Hidden'}
                    </button>
                    <button
                      type="button"
                      className="rounded border px-1"
                      onClick={() => updateLayer(layer.id, { locked: !layer.locked })}
                    >
                      {layer.locked ? 'Locked' : 'Unlocked'}
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="rounded border px-1"
                    disabled={index === layers.length - 1}
                    onClick={() => moveLayer(layer.id, 'up')}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="rounded border px-1"
                    disabled={index === 0}
                    onClick={() => moveLayer(layer.id, 'down')}
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className="rounded border px-1"
                    disabled={layers.length <= 1}
                    onClick={() => removeLayer(layer.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
          <Button size="sm" variant="outline" className="w-full" onClick={addLayer}>
            Add layer
          </Button>
        </div>

        {selection?.type === 'face' && selectedFace ? (
          <div className="space-y-2 text-sm">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Face role</span>
              <select
                className="w-full rounded-md border px-2 py-1 text-sm"
                value={faceMeta[selectedFace.key]?.role ?? ''}
                onChange={(event) => assignFaceRole(event.target.value as FaceRole | '')}
              >
                <option value="">None</option>
                <option value="room">room</option>
                <option value="table">table</option>
              </select>
            </label>

            {(faceMeta[selectedFace.key]?.role ?? '') === 'room' ? (
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">ceilingHeight (m)</span>
                <input
                  type="number"
                  className="w-full rounded-md border px-2 py-1 text-sm"
                  min={0.1}
                  step={0.1}
                  value={faceMeta[selectedFace.key]?.ceilingHeight ?? DEFAULT_CEILING_HEIGHT}
                  onChange={(event) => updateFaceHeight('ceilingHeight', Number(event.target.value))}
                />
              </label>
            ) : null}

            {(faceMeta[selectedFace.key]?.role ?? '') === 'table' ? (
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">tableHeight (m)</span>
                <input
                  type="number"
                  className="w-full rounded-md border px-2 py-1 text-sm"
                  min={0.1}
                  step={0.05}
                  value={faceMeta[selectedFace.key]?.tableHeight ?? DEFAULT_TABLE_HEIGHT}
                  onChange={(event) => updateFaceHeight('tableHeight', Number(event.target.value))}
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {selection?.type === 'luminaire' && selectedLuminaire ? (
          <div className="space-y-2 text-sm">
            <div className="text-xs text-muted-foreground">
              Position: ({selectedLuminaire.x.toFixed(2)}, {selectedLuminaire.y.toFixed(2)})
            </div>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">lumensPreset</span>
              <select
                className="w-full rounded-md border px-2 py-1 text-sm"
                value={selectedLuminaire.lumensPreset}
                onChange={(event) => updateLumens(Number(event.target.value) as LumensPreset)}
              >
                {LUMENS_PRESETS.map((preset) => (
                  <option key={preset} value={preset}>
                    {preset}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {selection?.type === 'drawable' && selectedDrawable ? (
          <div className="space-y-2 rounded-md border p-2 text-xs">
            <div className="font-medium">Selected drawing</div>
            <div>Type: {selectedDrawable.type}</div>
            <label className="block space-y-1">
              <span className="text-muted-foreground">Layer</span>
              <select
                className="w-full rounded border px-2 py-1"
                value={selectedDrawable.layerId}
                onChange={(event) => updateSelectedDrawableLayer(event.target.value)}
              >
                {layers.map((layer) => (
                  <option key={layer.id} value={layer.id}>
                    {layer.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => bringSelectedDrawable('front')}>
                Bring front
              </Button>
              <Button size="sm" variant="outline" onClick={() => bringSelectedDrawable('back')}>
                Send back
              </Button>
            </div>
          </div>
        ) : null}

        {selection?.type === 'vertex' ? (
          <div className="text-xs text-muted-foreground">
            Drag vertex to move it. If two vertices overlap, both move together.
          </div>
        ) : null}

        {!selection ? (
          <div className="text-xs text-muted-foreground">
            Selection priority: drawings -&gt; vertex -&gt; segment -&gt; face.
          </div>
        ) : null}
        {selection?.type === 'face' ? (
          <div className="rounded-md border border-sky-700/30 bg-sky-50 px-2 py-1 text-xs text-sky-900">
            Face selected
          </div>
        ) : null}
      </aside>
    </div>
  )
}
