import Object3D from "~/lib/core/Object3D";
import MathUtils from "~/lib/math/MathUtils";
import Camera from "~/lib/core/Camera";
import Vec2 from "~/lib/math/Vec2";
import TileExtrudedMesh from "./TileExtrudedMesh";
import TileProjectedMesh from "./TileProjectedMesh";
import TileLabelBuffers from "./TileLabelBuffers";
import Tile3DBuffers, {
	Tile3DBuffersExtruded,
	Tile3DBuffersLabels
} from "~/lib/tile-processing/tile3d/buffers/Tile3DBuffers";
import TileHuggingMesh from "~/app/objects/TileHuggingMesh";
import AABB3D from "~/lib/math/AABB3D";
import Vec3 from "~/lib/math/Vec3";
import {
	InstanceStructureSchemas,
	Tile3DInstanceLODConfig,
	Tile3DInstanceType
} from "~/lib/tile-processing/tile3d/features/Tile3DInstance";
import InstancedObject from "~/app/objects/InstancedObject";
import TerrainMask from "~/app/objects/TerrainMask";
import EventEmitter from "~/app/EventEmitter";

export type InstanceBufferInterleaved = Float32Array;

export type TileInstanceBuffers = Map<Tile3DInstanceType, {
	rawLOD0: InstanceBufferInterleaved;
	rawLOD1: InstanceBufferInterleaved;
	transformedLOD0: InstanceBufferInterleaved;
	transformedLOD1: InstanceBufferInterleaved;
	transformOriginLOD0: Vec2;
	transformOriginLOD1: Vec2;
	boundingBoxLOD0: AABB3D;
	boundingBoxLOD1: AABB3D;
}>;

export default class Tile extends Object3D {
	private static counter = 0;

	public readonly x: number;
	public readonly y: number;
	public readonly localId: number;

	public readonly emitter: EventEmitter<{
		delete: () => void;
	}> = new EventEmitter();

	public readonly buildingLocalToPackedMap: Map<number, number> = new Map();
	public readonly buildingPackedToLocalMap: Map<number, number> = new Map();
	public readonly buildingOffsetMap: Map<number, [number, number]> = new Map();
	public readonly buildingVisibilityMap: Map<number, boolean> = new Map();

	public inFrustum: boolean = true;
	public distanceToCamera: number = null;
	public disposed = false;
	public readonly labelBuffersList: TileLabelBuffers[] = [];
	public labelsAABB: AABB3D = null;
	public readonly instanceBuffers: TileInstanceBuffers = new Map();

	public extrudedMesh: TileExtrudedMesh;
	public projectedMesh: TileProjectedMesh;
	public huggingMesh: TileHuggingMesh;
	public terrainMaskMesh: TerrainMask;

	public readonly usedHeightTiles: Vec2[] = [];

	public terrainMaskSliceIndex: number = null;

	public constructor(x: number, y: number) {
		super();

		this.x = x;
		this.y = y;

		this.localId = Tile.counter++;

		if (Tile.counter > 65535) {
			Tile.counter = 0;
		}

		this.updatePosition();
	}

	private updatePosition(): void {
		const positionInMeters = MathUtils.tile2meters(this.x, this.y + 1);

		this.position.set(positionInMeters.x, 0, positionInMeters.y);
		this.updateMatrix();
	}

	public load(buffers: Tile3DBuffers): void {
		this.updateExtrudedGeometryOffsets(buffers.extruded);

		this.extrudedMesh = new TileExtrudedMesh(buffers.extruded);
		this.projectedMesh = new TileProjectedMesh(buffers.projected);
		this.huggingMesh = new TileHuggingMesh(buffers.hugging);
		this.terrainMaskMesh = new TerrainMask(buffers.terrainMask.positionBuffer);

		this.add(this.extrudedMesh, this.projectedMesh, this.huggingMesh);
		this.updateLabelBufferList(buffers.labels);

		for (const [key, instanceBuffers] of Object.entries(buffers.instances)) {
			const LOD0 = instanceBuffers.interleavedBufferLOD0;
			const LOD1 = instanceBuffers.interleavedBufferLOD1;

			const config = Tile3DInstanceLODConfig[key as Tile3DInstanceType];
			const schema = InstanceStructureSchemas[config.structure];

			const boundingBoxLOD0 = new AABB3D();
			for (let i = 0; i < LOD0.length; i += schema.componentsPerInstance) {
				boundingBoxLOD0.includePoint(new Vec3(LOD0[i], LOD0[i + 1], LOD0[i + 2]));
			}

			const boundingBoxLOD1 = new AABB3D();
			for (let i = 0; i < LOD1.length; i += schema.componentsPerInstance) {
				boundingBoxLOD1.includePoint(new Vec3(LOD1[i], LOD1[i + 1], LOD1[i + 2]));
			}

			this.instanceBuffers.set(key as Tile3DInstanceType, {
				rawLOD0: LOD0,
				rawLOD1: LOD1,
				transformedLOD0: new Float32Array(LOD0),
				transformedLOD1: new Float32Array(LOD1),
				transformOriginLOD0: new Vec2(NaN, NaN),
				transformOriginLOD1: new Vec2(NaN, NaN),
				boundingBoxLOD0: boundingBoxLOD0,
				boundingBoxLOD1: boundingBoxLOD1
			});
		}
	}

	public updateInstancesBoundingBoxes(instancedObjects: Map<string, InstancedObject>): void {
		for (const [key, buffers] of this.instanceBuffers) {
			buffers.boundingBoxLOD0 = instancedObjects.get(key).getInstancesAABB(buffers.rawLOD0);
			buffers.boundingBoxLOD1 = instancedObjects.get(key).getInstancesAABB(buffers.rawLOD1);
		}
	}

	public getInstancesBoundingBox(instanceName: Tile3DInstanceType, lod: number): AABB3D {
		const buffers = this.instanceBuffers.get(instanceName);

		if (!buffers) {
			return null;
		}

		const lodKey = lod === 0 ? 'LOD0' : 'LOD1';

		return buffers[`boundingBox${lodKey}`];
	}

	public getInstanceBufferWithTransform(instanceName: Tile3DInstanceType, lod: number, origin: Vec2): InstanceBufferInterleaved {
		const buffers = this.instanceBuffers.get(instanceName);

		if (!buffers) {
			return null;
		}

		const lodKey = lod === 0 ? 'LOD0' : 'LOD1';
		const transformed = buffers[`transformed${lodKey}`];
		const transformOrigin = buffers[`transformOrigin${lodKey}`];

		if (transformOrigin.equals(origin)) {
			return transformed;
		}

		const raw = buffers[`raw${lodKey}`];
		const config = Tile3DInstanceLODConfig[instanceName];
		const structure = InstanceStructureSchemas[config.structure];

		for (let i = 0; i < raw.length; i += structure.componentsPerInstance) {
			transformed[i] = raw[i] - origin.x + this.position.x;
			transformed[i + 2] = raw[i + 2] - origin.y + this.position.z;
		}

		transformOrigin.x = origin.x;
		transformOrigin.y = origin.y;

		return transformed;
	}

	private updateLabelBufferList(buffers: Tile3DBuffersLabels): void {
		for (let i = 0; i < buffers.text.length; i++) {
			const text = buffers.text[i];
			const priority = buffers.priority[i];
			const mercatorScale = MathUtils.getMercatorScaleFactorForTile(this.x, this.y, 16);
			const x = this.position.x + buffers.position[i * 3];
			const y = this.position.y + buffers.position[i * 3 + 1] * mercatorScale;
			const z = this.position.z + buffers.position[i * 3 + 2];

			const label = new TileLabelBuffers({
				text,
				priority,
				x,
				y,
				z
			});
			this.labelBuffersList.push(label);
		}

		const box = buffers.boundingBox;
		this.labelsAABB = new AABB3D(
			new Vec3(box.minX, box.minY, box.minZ),
			new Vec3(box.maxX, box.maxY, box.maxZ)
		);
	}

	public updateDistanceToCamera(camera: Camera): void {
		const worldPosition = MathUtils.tile2meters(this.x + 0.5, this.y + 0.5);
		this.distanceToCamera = Math.sqrt((worldPosition.x - camera.position.x) ** 2 + (worldPosition.y - camera.position.z) ** 2);
	}

	private updateExtrudedGeometryOffsets(extrudedBuffers: Tile3DBuffersExtruded): void {
		const ids = extrudedBuffers.idBuffer;
		const offsets = extrudedBuffers.offsetBuffer;
		const vertexCount = extrudedBuffers.positionBuffer.length / 3;

		for (let i = 0; i < ids.length; i += 2) {
			const id = MathUtils.shiftLeft(ids[i + 1] & 0x7FFFF, 32) + ids[i];
			const type = ids[i + 1] >> 19;

			const packedId = Tile.packFeatureId(id, type);

			const offset = offsets[i / 2];
			const nextOffset = offsets[i / 2 + 1] || vertexCount;
			this.buildingLocalToPackedMap.set(i / 2, packedId);
			this.buildingPackedToLocalMap.set(packedId, i / 2);
			this.buildingOffsetMap.set(packedId, [offset, nextOffset - offset]);
			this.buildingVisibilityMap.set(packedId, true);
		}
	}

	public hideBuilding(id: number): void {
		const [start, size] = this.buildingOffsetMap.get(id);

		this.extrudedMesh.addDisplayBufferPatch({start, size, value: 255});
		this.buildingVisibilityMap.set(id, false);
	}

	public showBuilding(id: number): void  {
		const [start, size] = this.buildingOffsetMap.get(id);

		this.extrudedMesh.addDisplayBufferPatch({start, size, value: 0});
		this.buildingVisibilityMap.set(id, true);
	}
	public translateBuilding(packedId: number, dx: number, dy: number, dz: number): boolean {
    const offset = this.buildingOffsetMap.get(packedId);

    if (!offset) {
        return false;
    }

    const [start, size] = offset;
    this.extrudedMesh.addPositionPatch({start, size, dx, dy, dz});

    return true;
	}

	/**
	 * Returns the roof plane height of a building, how many of its vertices sit
	 * on that plane, and a "roof signature" identifying the roof's appearance.
	 * A flat-roofed extruded building has its entire roof polygon (plus the top
	 * wall ring) at maxY, so a high flatVertexCount is a cheap signal that the
	 * roof is flat rather than pitched/gabled.
	 *
	 * roofSignature packs the dominant texture id and RGB color of the upward-
	 * facing roof vertices into one number; two roofs with equal signatures look
	 * identical, so overlapping them coplanar would z-fight invisibly (the winner
	 * looks the same either way). Comparing signatures lets the injector require a
	 * VISIBLE fight — different roof textures/colors placed together.
	 */
	public getBuildingRoofInfo(packedId: number): {maxY: number; flatVertexCount: number; roofSignature: number} | null {
		const offset = this.buildingOffsetMap.get(packedId);

		if (!offset) {
			return null;
		}

		const [start, size] = offset;
		const buffers = this.extrudedMesh['buffers'];
		const positions = buffers.positionBuffer;
		const normals = buffers.normalBuffer;
		const textureIds = buffers.textureIdBuffer;
		const colors = buffers.colorBuffer;

		let maxY = -Infinity;

		for (let i = start; i < start + size; i++) {
			maxY = Math.max(maxY, positions[i * 3 + 1]);
		}

		let flatVertexCount = 0;
		// Tally the (textureId, color) of upward-facing roof-plane vertices and
		// take the most common one as the roof's visible signature.
		const signatureCounts = new Map<number, number>();

		for (let i = start; i < start + size; i++) {
			const onRoofPlane = positions[i * 3 + 1] > maxY - 0.01;

			if (!onRoofPlane) {
				continue;
			}

			flatVertexCount++;

			// normal.y > 0.5 keeps wall-top vertices (which also sit at maxY but
			// face sideways) out of the roof-appearance tally.
			if (normals[i * 3 + 1] <= 0.5) {
				continue;
			}

			const sig = (textureIds[i] << 24) | (colors[i * 3] << 16) | (colors[i * 3 + 1] << 8) | colors[i * 3 + 2];
			signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);
		}

		let roofSignature = -1;
		let bestCount = 0;

		for (const [sig, count] of signatureCounts) {
			if (count > bestCount) {
				bestCount = count;
				roofSignature = sig;
			}
		}

		return {maxY, flatVertexCount, roofSignature};
	}

	public getBuildingCentroid(packedId: number): Vec3 | null {
		const offset = this.buildingOffsetMap.get(packedId);

		if (!offset) {
			return null;
		}

		const [start, size] = offset;
		const positions = this.extrudedMesh['buffers'].positionBuffer;

		let sumX = 0, sumY = 0, sumZ = 0;

		for (let i = start; i < start + size; i++) {
			sumX += positions[i * 3];
			sumY += positions[i * 3 + 1];
			sumZ += positions[i * 3 + 2];
		}

		return new Vec3(sumX / size, sumY / size, sumZ / size);
	}

	public isBuildingVisible(id: number): boolean {
		return this.buildingVisibilityMap.get(id);
	}

	public dispose(): void  {
		this.disposed = true;

		if (this.extrudedMesh) {
			this.extrudedMesh.dispose();
			this.extrudedMesh = null;
		}

		if (this.projectedMesh) {
			this.projectedMesh.dispose();
			this.projectedMesh = null;
		}

		if (this.huggingMesh) {
			this.huggingMesh.dispose();
			this.huggingMesh = null;
		}

		if (this.parent) {
			this.parent.remove(this);
		}

		this.emitter.emit('delete');
	}

	public static packFeatureId(id: number, type: number): number {
		return MathUtils.shiftLeft(type, 51) + id;
	}

	public static unpackFeatureId(packedId: number): [number, number] {
		const type = MathUtils.shiftRight(packedId, 51);
		let id = packedId;

		if (id >= 2 ** 52) {
			id -= 2 ** 52;
		}
		if (id >= 2 ** 51) {
			id -= 2 ** 51;
		}

		return [type, id];
	}
}
