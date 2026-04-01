import { useMemo } from 'react'
import { Line } from '@react-three/drei'
import { Vector3 } from 'three'
import type { Luminaire, Point2D, Polygon2D, Room, Table } from '@/types/scene'

type SceneWireframeProps = {
  room: Room | null
  tables: Table[]
  luminaires: Luminaire[]
  tableColors?: Record<string, string>
}

type Bounds2D = {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

const TABLE_THICKNESS = 0.08

function map2DTo3D(point: Point2D, y = 0): [number, number, number] {
  return [point.x, y, -point.y]
}

function polygonBounds(points: Polygon2D): Bounds2D {
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

function luminaireGuidePoints(luminaire: Luminaire) {
  const top = new Vector3(luminaire.position.x, luminaire.position.z, -luminaire.position.y)
  const bottom = new Vector3(luminaire.position.x, 0, -luminaire.position.y)
  return [bottom, top]
}

export function SceneWireframe({ room, tables, luminaires, tableColors = {} }: SceneWireframeProps) {
  const tableBoxes = useMemo(() => {
    return tables
      .map((table) => {
        if (table.polygon.length < 3) return null

        const bounds = polygonBounds(table.polygon)
        const width = bounds.maxX - bounds.minX
        const depth = bounds.maxY - bounds.minY
        if (width <= 0 || depth <= 0) return null

        const centerX = (bounds.minX + bounds.maxX) / 2
        const centerZ = -(bounds.minY + bounds.maxY) / 2
        const height = Math.max(TABLE_THICKNESS, Math.min(0.2, table.tableHeight))
        const centerY = Math.max(height / 2, table.tableHeight - height / 2)

        return {
          id: table.id,
          size: [width, height, depth] as [number, number, number],
          position: [centerX, centerY, centerZ] as [number, number, number],
        }
      })
      .filter((value): value is { id: string; size: [number, number, number]; position: [number, number, number] } => value !== null)
  }, [tables])

  const roomEdgeSegments = useMemo(() => {
    if (!room || room.polygon.length < 3 || room.ceilingHeight <= 0) return []

    const segments: { id: string; points: Vector3[] }[] = []
    const roomHeight = room.ceilingHeight

    for (let index = 0; index < room.polygon.length; index += 1) {
      const current = room.polygon[index]
      const next = room.polygon[(index + 1) % room.polygon.length]

      const floorA = new Vector3(current.x, 0, -current.y)
      const floorB = new Vector3(next.x, 0, -next.y)
      const ceilA = new Vector3(current.x, roomHeight, -current.y)
      const ceilB = new Vector3(next.x, roomHeight, -next.y)

      segments.push({ id: `room-floor-${index}`, points: [floorA, floorB] })
      segments.push({ id: `room-ceil-${index}`, points: [ceilA, ceilB] })
      segments.push({ id: `room-vert-${index}`, points: [floorA, ceilA] })
    }

    return segments
  }, [room])

  if (!room || roomEdgeSegments.length === 0) return null

  return (
    <group>
      {roomEdgeSegments.map((segment) => (
        <Line key={segment.id} points={segment.points} color="#0f172a" lineWidth={1} />
      ))}

      {tableBoxes.map((table) => (
        <mesh key={table.id} position={table.position}>
          <boxGeometry args={table.size} />
          <meshBasicMaterial color={tableColors[table.id] ?? '#059669'} />
        </mesh>
      ))}

      {luminaires.map((luminaire) => (
        <group
          key={luminaire.id}
          position={map2DTo3D(
            {
              x: luminaire.position.x,
              y: luminaire.position.y,
            },
            luminaire.position.z,
          )}
        >
          <mesh>
            <octahedronGeometry args={[0.12]} />
            <meshBasicMaterial color="#eab308" wireframe />
          </mesh>
          <Line points={luminaireGuidePoints(luminaire)} color="#f59e0b" lineWidth={1} />
        </group>
      ))}
    </group>
  )
}
