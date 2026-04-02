import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { Box3, PerspectiveCamera, Vector3 } from 'three'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { PlanEditor } from '@/components/plan-editor'
import { SceneWireframe } from '@/components/scene-wireframe'
import { useTheme } from '@/hooks/use-theme'
import {
  MAX_LIGHTING_GRID,
  MIN_LIGHTING_GRID,
  calculateLighting,
  DEFAULT_LIGHTING_EPSILON,
  DEFAULT_LIGHTING_GRID_X,
  DEFAULT_LIGHTING_GRID_Y,
  type LightingReport,
} from '@/lib/lighting'
import type { Luminaire, Room, Table } from '@/types/scene'
import { useSceneStore } from '@/store/scene-store'

const VIEWER_CAMERA_STORAGE_KEY = 'light:viewer-camera:v1'
const DEFAULT_CAMERA_POSITION: [number, number, number] = [7, 6, 7]
const DEFAULT_CAMERA_TARGET: [number, number, number] = [0, 0, 0]
const LIGHTING_DEBOUNCE_MS = 350

const HEATMAP_LOW_COLOR = '#1d4ed8'
const HEATMAP_HIGH_COLOR = '#dc2626'

type PersistedCameraState = {
  position: [number, number, number]
  target: [number, number, number]
}

type ViewerCameraControlsProps = {
  room: Room | null
  tables: Table[]
  luminaires: Luminaire[]
  zoomToFitRequest: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isVec3(value: unknown): value is [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) return false
  return isFiniteNumber(value[0]) && isFiniteNumber(value[1]) && isFiniteNumber(value[2])
}

function parsePersistedCameraState(raw: string | null): PersistedCameraState | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedCameraState>
    if (!isVec3(parsed.position) || !isVec3(parsed.target)) return null
    return {
      position: parsed.position,
      target: parsed.target,
    }
  } catch {
    return null
  }
}

function computeSceneBounds(room: Room | null, tables: Table[], luminaires: Luminaire[]): Box3 | null {
  const box = new Box3()
  let hasPoints = false

  const expand = (x: number, y: number, z: number) => {
    box.expandByPoint(new Vector3(x, y, z))
    hasPoints = true
  }

  if (room) {
    const roomHeight = Math.max(0.1, room.ceilingHeight)
    room.polygon.forEach((point) => {
      expand(point.x, 0, -point.y)
      expand(point.x, roomHeight, -point.y)
    })
  }

  tables.forEach((table) => {
    const tableHeight = Math.max(0.1, table.tableHeight)
    table.polygon.forEach((point) => {
      expand(point.x, 0, -point.y)
      expand(point.x, tableHeight, -point.y)
    })
  })

  luminaires.forEach((luminaire) => {
    expand(luminaire.position.x, luminaire.position.z, -luminaire.position.y)
  })

  return hasPoints ? box : null
}

function interpolateHexColor(fromHex: string, toHex: string, t: number) {
  const clampT = Math.max(0, Math.min(1, t))
  const from = fromHex.replace('#', '')
  const to = toHex.replace('#', '')
  const fromRgb = [
    Number.parseInt(from.slice(0, 2), 16),
    Number.parseInt(from.slice(2, 4), 16),
    Number.parseInt(from.slice(4, 6), 16),
  ]
  const toRgb = [
    Number.parseInt(to.slice(0, 2), 16),
    Number.parseInt(to.slice(2, 4), 16),
    Number.parseInt(to.slice(4, 6), 16),
  ]

  const mixed = fromRgb.map((start, index) => Math.round(start + (toRgb[index] - start) * clampT))
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
}

function ViewerCameraControls({ room, tables, luminaires, zoomToFitRequest }: ViewerCameraControlsProps) {
  const controlsRef = useRef<OrbitControlsImpl>(null)
  const { camera, invalidate } = useThree()
  const sceneBounds = useMemo(
    () => computeSceneBounds(room, tables, luminaires),
    [room, tables, luminaires],
  )

  const persistCameraState = useCallback(() => {
    if (!(camera instanceof PerspectiveCamera)) return
    const controls = controlsRef.current
    if (!controls) return

    const payload: PersistedCameraState = {
      position: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
    }
    window.localStorage.setItem(VIEWER_CAMERA_STORAGE_KEY, JSON.stringify(payload))
  }, [camera])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!(camera instanceof PerspectiveCamera)) return

    const controls = controlsRef.current
    if (!controls) return

    const persisted = parsePersistedCameraState(window.localStorage.getItem(VIEWER_CAMERA_STORAGE_KEY))
    const initialPosition = persisted?.position ?? DEFAULT_CAMERA_POSITION
    const initialTarget = persisted?.target ?? DEFAULT_CAMERA_TARGET

    camera.position.set(...initialPosition)
    controls.target.set(...initialTarget)
    camera.updateProjectionMatrix()
    controls.update()
    persistCameraState()
    invalidate()
  }, [camera, invalidate, persistCameraState])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!(camera instanceof PerspectiveCamera)) return

    const controls = controlsRef.current
    if (!controls) return

    const onChange = () => {
      persistCameraState()
    }

    controls.addEventListener('change', onChange)
    return () => {
      controls.removeEventListener('change', onChange)
    }
  }, [camera, persistCameraState])

  useEffect(() => {
    if (zoomToFitRequest <= 0) return
    if (!(camera instanceof PerspectiveCamera)) return

    const controls = controlsRef.current
    if (!controls) return

    if (!sceneBounds) {
      camera.position.set(...DEFAULT_CAMERA_POSITION)
      controls.target.set(...DEFAULT_CAMERA_TARGET)
      camera.updateProjectionMatrix()
      controls.update()
      persistCameraState()
      invalidate()
      return
    }

    const center = sceneBounds.getCenter(new Vector3())
    const size = sceneBounds.getSize(new Vector3())

    const direction = camera.position.clone().sub(controls.target)
    if (direction.lengthSq() < 1e-9) {
      direction.set(1, 1, 1)
    }
    direction.normalize()

    const verticalFov = (camera.fov * Math.PI) / 180
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect)
    const fitHeightDistance = size.y / (2 * Math.tan(verticalFov / 2))
    const fitWidthDistance = Math.max(size.x, size.z) / (2 * Math.tan(horizontalFov / 2))
    const diagonalDistance = size.length() * 0.5
    const distance = Math.max(fitHeightDistance, fitWidthDistance, diagonalDistance, 1) * 1.35

    controls.target.copy(center)
    camera.position.copy(center.clone().add(direction.multiplyScalar(distance)))
    camera.updateProjectionMatrix()
    controls.update()
    persistCameraState()
    invalidate()
  }, [zoomToFitRequest, camera, invalidate, sceneBounds, persistCameraState])

  return <OrbitControls ref={controlsRef} makeDefault />
}

function App() {
  const { theme, toggle } = useTheme()
  const room = useSceneStore((state) => state.room)
  const tables = useSceneStore((state) => state.tables)
  const luminaires = useSceneStore((state) => state.luminaires)
  const resetScene = useSceneStore((state) => state.resetScene)
  const [zoomToFitRequest, setZoomToFitRequest] = useState(0)
  const [lightingGridX, setLightingGridX] = useState(DEFAULT_LIGHTING_GRID_X)
  const [lightingGridY, setLightingGridY] = useState(DEFAULT_LIGHTING_GRID_Y)
  const [autoRecalculate, setAutoRecalculate] = useState(true)
  const [lightingReport, setLightingReport] = useState<LightingReport | null>(null)
  const [lightingMessage, setLightingMessage] = useState<string>('Нажмите Recalculate для первого расчёта.')

  const recalculateLighting = useCallback(() => {
    const result = calculateLighting(
      {
        room,
        tables,
        luminaires,
      },
      {
        grid: { x: lightingGridX, y: lightingGridY },
        epsilon: DEFAULT_LIGHTING_EPSILON,
      },
    )

    if (result.status === 'blocked') {
      setLightingReport(null)
      setLightingMessage(result.reason)
      return
    }

    setLightingReport(result.report)
    setLightingMessage('')
  }, [room, tables, luminaires, lightingGridX, lightingGridY])

  const avgLuxRange = useMemo(() => {
    if (!lightingReport || lightingReport.tableStats.length === 0) return null
    const values = lightingReport.tableStats.map((stats) => stats.avgLux)
    return {
      min: Math.min(...values),
      max: Math.max(...values),
    }
  }, [lightingReport])

  const tableHeatmapColors = useMemo(() => {
    if (!lightingReport || !avgLuxRange) return {}

    const span = Math.max(1e-6, avgLuxRange.max - avgLuxRange.min)
    return lightingReport.tableStats.reduce<Record<string, string>>((acc, stats) => {
      const t = (stats.avgLux - avgLuxRange.min) / span
      acc[stats.tableId] = interpolateHexColor(HEATMAP_LOW_COLOR, HEATMAP_HIGH_COLOR, t)
      return acc
    }, {})
  }, [lightingReport, avgLuxRange])

  useEffect(() => {
    if (!autoRecalculate) return

    const timeoutId = window.setTimeout(() => {
      recalculateLighting()
    }, LIGHTING_DEBOUNCE_MS)

    return () => window.clearTimeout(timeoutId)
  }, [autoRecalculate, recalculateLighting])

  return (
    <main className="h-screen bg-muted/30 p-4">
      <section className="grid h-full gap-4 lg:grid-cols-[1fr_1fr_320px]">
        <Card className="min-h-[320px]">
          <CardHeader>
            <CardTitle>2D Plan Editor</CardTitle>
          </CardHeader>
          <CardContent className="h-[calc(100%-4.25rem)]">
            <PlanEditor onRoomAssigned={() => setZoomToFitRequest((request) => request + 1)} />
          </CardContent>
        </Card>

        <Card className="min-h-[320px]">
          <CardHeader>
            <CardTitle>3D Viewer (Wireframe)</CardTitle>
          </CardHeader>
          <CardContent className="h-[calc(100%-4.25rem)]">
            <div className="relative h-full overflow-hidden rounded-lg border bg-card">
              <Canvas camera={{ position: DEFAULT_CAMERA_POSITION, fov: 50 }}>
                <color attach="background" args={[theme === 'dark' ? '#1c1c1c' : '#ffffff']} />
                <ambientLight intensity={0.7} />
                <SceneWireframe
                  room={room}
                  tables={tables}
                  luminaires={luminaires}
                  tableColors={tableHeatmapColors}
                />
                <ViewerCameraControls
                  room={room}
                  tables={tables}
                  luminaires={luminaires}
                  zoomToFitRequest={zoomToFitRequest}
                />
              </Canvas>
              {!room ? (
                <div className="pointer-events-none absolute left-3 top-3 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
                  Назначьте роль <span className="font-medium">room</span> замкнутому контуру в 2D
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card className="min-h-[320px]">
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <CardTitle>Properties</CardTitle>
            <Button
              variant="ghost"
              size="icon"
              onClick={toggle}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Room</span>
                <span>{room ? 'Assigned' : 'Not assigned'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Tables</span>
                <span>{tables.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Luminaires</span>
                <span>{luminaires.length}</span>
              </div>
            </div>
            <Separator />
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Sampling grid</span>
                <span>
                  {lightingGridX}x{lightingGridY}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Grid X</span>
                  <input
                    type="number"
                    className="w-full rounded-md border px-2 py-1 text-sm"
                    min={MIN_LIGHTING_GRID}
                    max={MAX_LIGHTING_GRID}
                    step={1}
                    value={lightingGridX}
                    onChange={(event) =>
                      setLightingGridX(
                        Math.max(
                          MIN_LIGHTING_GRID,
                          Math.min(MAX_LIGHTING_GRID, Number(event.target.value) || MIN_LIGHTING_GRID),
                        ),
                      )
                    }
                  />
                </label>
                <label className="space-y-1 text-xs">
                  <span className="text-muted-foreground">Grid Y</span>
                  <input
                    type="number"
                    className="w-full rounded-md border px-2 py-1 text-sm"
                    min={MIN_LIGHTING_GRID}
                    max={MAX_LIGHTING_GRID}
                    step={1}
                    value={lightingGridY}
                    onChange={(event) =>
                      setLightingGridY(
                        Math.max(
                          MIN_LIGHTING_GRID,
                          Math.min(MAX_LIGHTING_GRID, Number(event.target.value) || MIN_LIGHTING_GRID),
                        ),
                      )
                    }
                  />
                </label>
              </div>
              <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={autoRecalculate}
                  onChange={(event) => setAutoRecalculate(event.target.checked)}
                />
                Auto recalculate (debounce {LIGHTING_DEBOUNCE_MS} ms)
              </label>
              <Button variant="default" className="w-full" onClick={recalculateLighting}>
                Recalculate
              </Button>
            </div>
            <Separator />
            <div className="space-y-2 text-xs">
              <div className="text-muted-foreground">
                {lightingReport
                  ? `Updated: ${new Date(lightingReport.computedAt).toLocaleTimeString('ru-RU')}`
                  : lightingMessage}
              </div>
              {lightingReport ? (
                <>
                  {avgLuxRange ? (
                    <div className="space-y-1 rounded-md border p-2">
                      <div
                        className="h-2 rounded-sm"
                        style={{
                          background: `linear-gradient(to right, ${HEATMAP_LOW_COLOR}, ${HEATMAP_HIGH_COLOR})`,
                        }}
                      />
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                        <span>{avgLuxRange.min.toFixed(1)} lx</span>
                        <span>avg lux heatmap</span>
                        <span>{avgLuxRange.max.toFixed(1)} lx</span>
                      </div>
                    </div>
                  ) : null}

                  <div className="max-h-48 space-y-1 overflow-auto rounded-md border p-2">
                    {lightingReport.tableStats.map((stats) => (
                      <div key={stats.tableId} className="rounded bg-muted/50 p-2">
                        <div className="mb-1 flex items-center justify-between">
                          <div className="font-medium">{stats.tableId.slice(0, 10)}</div>
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full border border-foreground/20"
                            style={{ backgroundColor: tableHeatmapColors[stats.tableId] ?? '#059669' }}
                          />
                        </div>
                        <div className="text-muted-foreground">samples: {stats.sampleCount}</div>
                        <div>min: {stats.minLux.toFixed(1)} lx</div>
                        <div>avg: {stats.avgLux.toFixed(1)} lx</div>
                        <div>max: {stats.maxLux.toFixed(1)} lx</div>
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
            <Separator />
            <Button
              variant="outline"
              className="w-full"
              onClick={() => setZoomToFitRequest((request) => request + 1)}
            >
              Zoom to fit
            </Button>
            <Button variant="outline" className="w-full" onClick={resetScene}>
              Reset Scene
            </Button>
          </CardContent>
        </Card>
      </section>
    </main>
  )
}

export default App
