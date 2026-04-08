import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { LUMENS_PRESETS, type LumensPreset, type Point2D, type Polygon2D } from '@/types/scene'
import { useSceneStore } from '@/store/scene-store'

type Tool = 'select' | 'segment' | 'luminaire'

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

type Selection =
  | { type: 'vertex'; id: string }
  | { type: 'segment'; id: string }
  | { type: 'face'; key: string }
  | { type: 'luminaire'; id: string }
  | null

const VIEW_SIZE = 20
const GRID_STEP = 1
const SNAP_DISTANCE = 0.15
const HIT_VERTEX = 0.32
const HIT_SEGMENT = 0.24
const COINCIDENT_DISTANCE = 0.05
const DEFAULT_CEILING_HEIGHT = 3
const DEFAULT_TABLE_HEIGHT = 0.75
const PLAN_EDITOR_STORAGE_KEY = 'light:plan-editor:v1'

type PersistedPlanEditorState = {
  tool: Tool
  vertices: Vertex[]
  segments: Segment[]
  luminaires: Luminaire2D[]
  selection: Selection
  pendingStart: string | null
  faceMeta: Record<string, FaceMeta>
  faceMetaByPolygon?: Record<string, FaceMeta>
}

function createId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function snap(value: number) {
  return Math.round(value / GRID_STEP) * GRID_STEP
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

function parsePersistedPlanEditorState(value: unknown): PersistedPlanEditorState | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Partial<PersistedPlanEditorState>
  const tool: Tool = raw.tool === 'segment' || raw.tool === 'luminaire' ? raw.tool : 'select'

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
  }

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
  }
}

type PlanEditorProps = {
  onRoomAssigned?: () => void
  assignRoomRequest?: number
}

export function PlanEditor({ onRoomAssigned, assignRoomRequest = 0 }: PlanEditorProps) {
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
  const [dragState, setDragState] = useState<{
    vertexIds: string[]
    pointerStart: Point2D
    origin: Map<string, Point2D>
  } | null>(null)

  const svgRef = useRef<SVGSVGElement>(null)
  const pendingFaceMetaByPolygonRef = useRef<Record<string, FaceMeta> | null>(null)
  const assignRoomRequestRef = useRef(assignRoomRequest)

  const setRoom = useSceneStore((state) => state.setRoom)
  const clearRoom = useSceneStore((state) => state.clearRoom)
  const setTablesStore = useSceneStore((state) => state.setTables)
  const setLuminairesStore = useSceneStore((state) => state.setLuminaires)

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
    }

    window.localStorage.setItem(PLAN_EDITOR_STORAGE_KEY, JSON.stringify(stateToPersist))
  }, [isLoadedFromStorage, tool, vertices, segments, luminaires, selection, pendingStart, faceMeta])

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

  useEffect(() => {
    const isTextInputTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return (
        target.isContentEditable ||
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT'
      )
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextInputTarget(event.target)) return

      if (event.key === 'Escape') {
        setPendingStart(null)
        setDragState(null)
      }

      if (event.key === 'Delete' && selection?.type === 'segment') {
        event.preventDefault()
        setSegments((prev) => prev.filter((segment) => segment.id !== selection.id))
        setSelection(null)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selection])

  const upsertVertex = (point: Point2D, pool: Vertex[]) => {
    const existing = pool.find((vertex) => distance(vertex, point) <= SNAP_DISTANCE)
    if (existing) return existing.id
    const id = createId('v')
    pool.push({ id, ...point })
    return id
  }

  const hitTestAtPoint = (point: Point2D): Selection => {
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

  const selectAtPoint = (point: Point2D) => {
    const hit = hitTestAtPoint(point)
    setSelection(hit)
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

  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return

    const rawPoint = toScreenPoint(svg, event.clientX, event.clientY)
    const point = snapPoint(rawPoint)
    setSnappedCursorPoint(point)

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
      setMessage('')
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

    selectAtPoint(point)

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
    if (!dragState) return

    const merged = mergeVertices(vertices, segments)
    setVertices(merged.vertices)
    setSegments(merged.segments)
    setDragState(null)
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

  useEffect(() => {
    if (assignRoomRequest === assignRoomRequestRef.current) return
    assignRoomRequestRef.current = assignRoomRequest

    if (!selectedFace) {
      setMessage('Выберите замкнутый контур в 2D, затем нажмите Assign Selected Face As Room.')
      return
    }

    assignFaceRole('room')
  }, [assignRoomRequest, selectedFace])

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

  const clearEditor = () => {
    setVertices([])
    setSegments([])
    setLuminaires([])
    setFaceMeta({})
    setSelection(null)
    setPendingStart(null)
    setMessage('')
  }

  const invalidTables = roomFace
    ? tableFaces.filter((face) => !isPolygonInside(face.points, roomFace.points)).length
    : tableFaces.length

  const invalidLuminaires = roomFace
    ? luminaires.filter((luminaire) => !pointInPolygon(luminaire, roomFace.points)).length
    : luminaires.length

  return (
    <div className="grid h-full gap-4 lg:grid-cols-[1fr_280px]">
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
          <Button variant="outline" onClick={clearEditor}>
            Clear
          </Button>
          {pendingStart && tool === 'segment' ? (
            <span className="self-center text-xs text-muted-foreground">
              Segment mode: choose end point (Esc to cancel chain)
            </span>
          ) : null}
        </div>

        <div
          className="h-[520px] rounded-lg border bg-card"
        >
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
              <pattern
                id="plan-grid"
                patternUnits="userSpaceOnUse"
                width={GRID_STEP}
                height={GRID_STEP}
              >
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
                <polygon
                  key={face.key}
                  points={points}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={strokeWidth}
                />
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

            {snappedCursorPoint ? (
              <circle
                cx={snappedCursorPoint.x}
                cy={snappedCursorPoint.y}
                r={0.12}
                fill="none"
                stroke="#ef4444"
                strokeWidth={0.05}
              />
            ) : null}
          </svg>
        </div>

        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <span>Vertices: {vertices.length}</span>
          <span>Segments: {segments.length}</span>
          <span>Faces: {faces.length}</span>
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

        {selection?.type === 'face' && selectedFace ? (
          <div className="space-y-2 text-sm">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">Face role</span>
              <select
                className="w-full rounded-md border px-2 py-1 text-sm"
                value={(faceMeta[selectedFace.key]?.role ?? '') === 'room' ? '' : (faceMeta[selectedFace.key]?.role ?? '')}
                onChange={(event) => assignFaceRole(event.target.value as 'table' | '')}
              >
                <option value="">None</option>
                <option value="table">table</option>
              </select>
            </label>

            <div className="text-xs text-muted-foreground">
              Room role is assigned from 3D Viewer button: Assign Selected Face As Room.
            </div>

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

        {selection?.type === 'vertex' ? (
          <div className="text-xs text-muted-foreground">
            Drag vertex to move it. If two vertices overlap, both move together.
          </div>
        ) : null}

        {!selection ? (
          <div className="text-xs text-muted-foreground">
            Selection priority: vertex -&gt; segment -&gt; face.
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
