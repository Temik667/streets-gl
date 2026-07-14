import Vec2 from "~/lib/math/Vec2";
import System from "../System";
import PickingSystem from "./PickingSystem";
import GBufferPass from "../render/passes/GBufferPass";
import DepthOutputPass, {DepthBufferResult} from "../render/passes/DepthOutputPass";
import WebGL2Renderer from "~/lib/renderer/webgl2-renderer/WebGL2Renderer";
import AbstractRenderer from "~/lib/renderer/abstract-renderer/AbstractRenderer";
import * as RG from "~/lib/render-graph";
import RenderGraphResourceFactory from "../render/render-graph/RenderGraphResourceFactory";
import PassManager from '../render/PassManager';
import SceneSystem from './SceneSystem';
import TAAPass from '../render/passes/TAAPass';
import ShadowMappingPass from "../render/passes/ShadowMappingPass";
import ShadingPass from "../render/passes/ShadingPass";
import ScreenPass from "../render/passes/ScreenPass";
import SSAOPass from "../render/passes/SSAOPass";
import SelectionPass from "../render/passes/SelectionPass";
import LabelPass from "../render/passes/LabelPass";
import AtmosphereLUTPass from "../render/passes/AtmosphereLUTPass";
import SSRPass from "../render/passes/SSRPass";
import DoFPass from "../render/passes/DoFPass";
import TerrainTexturesPass from "../render/passes/TerrainTexturesPass";
import BloomPass from "../render/passes/BloomPass";
import FullScreenTriangle from "../objects/FullScreenTriangle";
import Node from "../../lib/render-graph/Node";
import SettingsSystem from "~/app/systems/SettingsSystem";
import SlippyMapPass from "~/app/render/passes/SlippyMapPass";
import AbstractTexture2D from "~/lib/renderer/abstract-renderer/AbstractTexture2D";
import ResourceLoader from "~/app/world/ResourceLoader";
import {RendererTypes} from "~/lib/renderer/RendererTypes";
import ControlsSystem from "~/app/systems/ControlsSystem";
import TerrainSystem from "~/app/systems/TerrainSystem";
import CursorStyleSystem from "~/app/systems/CursorStyleSystem";
import Vec3 from "~/lib/math/Vec3";
import AABB3D from "~/lib/math/AABB3D";
import Tile from "../objects/Tile";

export interface BuildingInjectionResult {
    tileLocalId: number;
    buildingIdA: number;
    buildingIdB: number;
    dx: number;
    dy: number;
    dz: number;
    overlapFraction: number;
}

export default class RenderSystem extends System {
    private renderer: AbstractRenderer;
    private frameCount: number = 0;
    // Aliasing anomaly parameter, settable at runtime via setDegradationFactor().
    // 1.0 = native resolution; 0.25 or lower = severe, blocky, PS1-era aliasing.
    public degradationFactor: number = 1.0;

    private renderGraph: RG.RenderGraph;
    private renderGraphResourceFactory: RenderGraphResourceFactory;
    private passManager: PassManager;
    public fullScreenTriangle: FullScreenTriangle;

    public postInit(): void {
        const canvas = <HTMLCanvasElement>document.getElementById('canvas');

        // FORCE NEAREST-NEIGHBOR UPSCALING
        // This prevents the browser from blurring your low-res aliased output
        canvas.style.imageRendering = 'pixelated';

        this.renderer = new WebGL2Renderer(canvas.getContext('webgl2', {
            powerPreference: "high-performance",
            antialias: false // Hardware MSAA stays off
        }));
        this.renderer.setSize(this.resolutionUI.x, this.resolutionUI.y);

        console.log(`Vendor: ${this.renderer.rendererInfo[0]} \nRenderer: ${this.renderer.rendererInfo[1]}`);

        window.addEventListener('resize', () => this.resize());

        this.initScene();
        (window as any).renderSystem = this;
    }

    private initScene(): void {
        this.fullScreenTriangle = new FullScreenTriangle(this.renderer);

        this.renderGraph = new RG.RenderGraph();
        this.renderGraphResourceFactory = new RenderGraphResourceFactory(this.renderer);
        this.passManager = new PassManager(
            this.systemManager,
            this.renderer,
            this.renderGraphResourceFactory,
            this.renderGraph,
            this.systemManager.getSystem(SettingsSystem).settings
        );

        this.passManager.addPasses(
            new GBufferPass(this.passManager),
            new DepthOutputPass(this.passManager),
            new TAAPass(this.passManager),
            new ShadowMappingPass(this.passManager),
            new ShadingPass(this.passManager),
            new ScreenPass(this.passManager),
            new SSAOPass(this.passManager),
            new SelectionPass(this.passManager),
            new LabelPass(this.passManager),
            new AtmosphereLUTPass(this.passManager),
            new SSRPass(this.passManager),
            new DoFPass(this.passManager),
            new BloomPass(this.passManager),
            new TerrainTexturesPass(this.passManager),
            new SlippyMapPass(this.passManager)
        );

        this.passManager.listenToSettings();
    }

    private resize(): void {
        const {x: widthUI, y: heightUI} = this.resolutionUI;
        const {x: widthScene, y: heightScene} = this.resolutionUI;

        this.renderer.setSize(widthUI, heightUI);
        this.passManager.resize();

        for (const pass of this.passManager.passes) {
            pass.setSize(widthScene, heightScene);
        }
    }

    public update(deltaTime: number): void {
        const controlsSystem = this.systemManager.getSystem(ControlsSystem);
        const sceneSystem = this.systemManager.getSystem(SceneSystem);
        const settings = this.systemManager.getSystem(SettingsSystem).settings;
        const tiles = sceneSystem.objects.tiles;

        // --- 1. DISABLE LENS AND BLUR EFFECTS ---
        // const opticalSettings = ['taa', 'dof', 'bloom', 'ssr'];
        // for (const key of opticalSettings) {
        //     const setting = settings.get(key);
        //     if (setting && setting.statusValue !== 'off') {
        //         setting.statusValue = 'off';
        //     }
        // }

        // --- 2. PERMANENTLY DISABLE UI LABELS (TEXT) ---
        if (settings.get('labels').statusValue !== 'off') {
            settings.get('labels').statusValue = 'off';
        }

        // Force jitter to 0 to keep the camera mathematically still
        const jitterFactor = 0;

        this.passManager.updateRenderGraph(
            controlsSystem.isSlippyMapVisible,
            controlsSystem.isTilesVisible
        );

        // Because we forced it off above, the engine will safely skip calculating the text meshes entirely
        if (settings.get('labels').statusValue === 'on') {
            sceneSystem.objects.labels.updateFromTiles(tiles, sceneSystem.objects.camera, this.resolutionScene);
        }

        for (const object of sceneSystem.getObjectsToUpdateMesh()) {
            object.updateMesh(this.renderer);
        }

        sceneSystem.objects.camera.updateJitteredProjectionMatrix(
            this.frameCount,
            this.resolutionScene.x,
            this.resolutionScene.y,
            jitterFactor
        );

        sceneSystem.objects.camera.updateFrustum();

        this.renderGraph.render();

        this.pickObjectId();

        ++this.frameCount;
    }

    public getLastRenderGraph(): Set<RG.Node> {
        return this.renderGraph.lastGraph;
    }

    public getLastRenderGraphPassList(): RG.Pass<any>[] {
        return this.renderGraph.lastSortedPassList;
    }

    public getRenderGraphNodeConnectionSets(): {
        indegree: Map<Node, Set<Node>>;
        outdegree: Map<Node, Set<Node>>;
    } {
        return {
            indegree: this.renderGraph.indegreeSets,
            outdegree: this.renderGraph.outdegreeSets
        };
    }

    public createTileTexture(image: HTMLImageElement): AbstractTexture2D {
        return this.renderer.createTexture2D({
            width: image.width,
            height: image.height,
            data: image,
            minFilter: RendererTypes.MinFilter.Linear,
            magFilter: RendererTypes.MagFilter.Linear,
            wrap: RendererTypes.TextureWrap.ClampToEdge,
            format: RendererTypes.TextureFormat.RGBA8Unorm,
            mipmaps: false,
            flipY: false
        });
    }

    private pickObjectId(): void {
        const pickingSystem = this.systemManager.getSystem(PickingSystem);
        const controlsSystem = this.systemManager.getSystem(ControlsSystem);
        const pass = <GBufferPass>this.passManager.getPass('GBufferPass');

        if (!pass || !controlsSystem.isTilesVisible) {
            pickingSystem.clearHoveredObjectId();
            return;
        }

        pass.objectIdX = pickingSystem.pointerPosition.x;
        pass.objectIdY = pickingSystem.pointerPosition.y;

        pickingSystem.readObjectId(pass.objectIdBuffer);
    }

    public get resolutionUI(): Vec2 {
        const pixelRatio = window.devicePixelRatio;
        return new Vec2(window.innerWidth * pixelRatio, window.innerHeight * pixelRatio);
    }

    public get resolutionScene(): Vec2 {
        // --- SENSOR DEGRADATION ---
        // degradationFactor is a public field set at runtime by setDegradationFactor()
        // (called from Playwright via window.renderSystem) — no source rewrite needed.
        return new Vec2(
            Math.floor(window.innerWidth * this.degradationFactor),
            Math.floor(window.innerHeight * this.degradationFactor)
        );
    }

    /**
     * Runtime anomaly setters for automated dataset generation. Each replaces a
     * former source-constant rewrite (Python regex + webpack rebuild per image),
     * which leaked dev-server memory and eventually OOM'd Node on long runs.
     *
     * Call from Playwright, e.g.:
     *   await page.evaluate("window.renderSystem.setDegradationFactor(0.25)")
     */
    public setDegradationFactor(factor: number): void {
        this.degradationFactor = factor;
        // Render targets are only sized on resize events, so re-run it now.
        this.resize();
    }

    /** Tilts are tangent gradients (tan of the tilt angle), not degrees. */
    public setClippingParams(near: number, far: number, tiltX: number, tiltY: number): void {
        const pass = <GBufferPass>this.passManager.getPass('GBufferPass');

        if (!pass) return;

        pass.errorNearClip = near;
        pass.errorFarClip = far;
        pass.planeTiltX = tiltX;
        pass.planeTiltY = tiltY;
    }

    public setShadowBiases(shadowBias: number, normalBias: number): void {
        const sceneSystem = this.systemManager.getSystem(SceneSystem);

        sceneSystem.injectedShadowBias = shadowBias;
        sceneSystem.injectedNormalBias = normalBias;
    }

    /**
     * Call this from your automated dataset generation script after rendering a frame.
     * Returns true if the camera spawned inside a building.
     */
    public async isCameraInsideBuilding(): Promise<boolean> {
        const pass = <GBufferPass>this.passManager.getPass('GBufferPass');

        if (!pass) return false;

        const centerX = Math.floor(this.resolutionUI.x / 2);
        const centerY = Math.floor(this.resolutionUI.y / 2);

        // requestObjectIdAt waits for the NEXT real render before resolving,
        // so this always reflects a fresh read at dead-center — never stale
        // data left over from the mouse-hover picker.
        const objectId = await pass.requestObjectIdAt(centerX, centerY);

        // 4294967295 is the emergency flag we set in the fragment shader
        return objectId === 4294967295;
    }
    public async isScreenClipped(): Promise<boolean> {
        const pass = <GBufferPass>this.passManager.getPass('GBufferPass');
        if (!pass) return false;

        const width = this.resolutionUI.x;
        const height = this.resolutionUI.y;
        const step = 50;

        for (let x = 0; x < width; x += step) {
            for (let y = 0; y < height; y += step) {
                const objectId = await pass.requestObjectIdAt(x, y);

                if (objectId === 4294967295) {
                    return true; // Penetration detected!
                }
            }
        }

        // Always check the exact dead-center just in case the stride skipped over it
        const centerId = await pass.requestObjectIdAt(width / 2, height / 2);

        return centerId === 4294967295;
    }

    /**
     * Returns true when the camera sits below the terrain surface (plus a small
     * margin), which produces garbage frames where the ground is see-through.
     * Uses the same TerrainHeightProvider the free-camera navigator clamps
     * against, so the height convention (mercator-scaled meters) matches
     * camera.position exactly.
     *
     * Returns false when height data isn't loaded yet for this spot — the check
     * is deliberately permissive rather than rejecting shots on missing data.
     *
     * Call from Playwright:
     *   await page.evaluate("window.renderSystem.isCameraUnderTerrain()")
     */
    /**
     * Counts the distinct buildings visible in the current frame by reading the
     * G-buffer's object-id attachment (only building fragments write non-zero
     * ids). Buildings covering fewer than minPixels pixels are ignored so that
     * distant slivers on the horizon don't inflate the count.
     *
     * Used by the intersection-anomaly generator to keep only sparse scenes
     * where the injected building overlap is clearly identifiable.
     *
     * Call from Playwright:
     *   await page.evaluate("window.renderSystem.countVisibleBuildings()")
     */
    public async countVisibleBuildings(minPixels: number = 30): Promise<number | null> {
        const pass = <GBufferPass>this.passManager.getPass('GBufferPass');

        if (!pass) return null;

        const ids = await pass.requestVisibleObjectIds();
        const pixelsPerId = new Map<number, number>();

        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];

            if (id === 0 || id === 4294967295) continue;

            pixelsPerId.set(id, (pixelsPerId.get(id) ?? 0) + 1);
        }

        let count = 0;

        for (const pixels of pixelsPerId.values()) {
            if (pixels >= minPixels) count++;
        }

        return count;
    }

    public isCameraUnderTerrain(margin: number = 1.0): boolean {
        const camera = this.systemManager.getSystem(SceneSystem).objects.camera;
        const terrainSystem = this.systemManager.getSystem(TerrainSystem);

        const terrainHeight = terrainSystem.terrainHeightProvider.getHeightGlobalInterpolated(
            camera.position.x,
            camera.position.z,
            true
        );

        if (terrainHeight === null) return false;

        return camera.position.y < terrainHeight + margin;
    }

    /**
     * Returns the per-pixel linear depth (distance from the camera, in meters)
     * for the last rendered frame, at the resolution of the 3D scene (see
     * resolutionScene — this shrinks when aliasing degradation is injected).
     *
     * `data` is a flat, JSON-friendly row-major array of length width * height,
     * top-left origin, one float per pixel — pair it with the screenshot to get
     * ground-truth depth alongside the RGB image.
     *
     * Call from Playwright:
     *   await page.evaluate("window.renderSystem.getDepthBuffer()")
     */
    public async getDepthBuffer(): Promise<{ width: number; height: number; data: number[] } | null> {
        const pass = <DepthOutputPass>this.passManager.getPass('DepthOutputPass');

        if (!pass) return null;

        const result: DepthBufferResult = await pass.readDepthBuffer();

        return {
            width: result.width,
            height: result.height,
            data: Array.from(result.data)
        };
    }

    /**
     * Checks whether a tile-local point is within the camera's visible frustum.
     * Uses the engine's own isFrustumIntersectsBoundingBox method (same one
     * RenderableObject3D.inCameraFrustum uses) rather than hand-rolled NDC math,
     * since this engine uses a floating-origin coordinate convention where
     * camera.matrixWorldInverse does NOT encode absolute world translation —
     * GBufferPass.getCameraPositionRelativeToTile handles that offset manually.
     */
    private isPointInFrustum(camera: Camera, tile: Tile, tileLocalPoint: Vec3): boolean {
        const padding = 1.0;
        const min = new Vec3(
            tileLocalPoint.x - padding,
            tileLocalPoint.y - padding,
            tileLocalPoint.z - padding
        );
        const max = new Vec3(
            tileLocalPoint.x + padding,
            tileLocalPoint.y + padding,
            tileLocalPoint.z + padding
        );
        const box = new AABB3D(min, max);

        return camera.isFrustumIntersectsBoundingBox(box.toSpace(tile.matrixWorld));
    }
    /**
     * Finds two buildings currently visible in the camera frustum and
     * translates one toward the other to create a visible intersection/
     * z-fighting anomaly. Returns true if an injection was successfully made,
     * false if no suitable on-screen building pair was found (e.g. camera
     * over water or empty terrain).
     *
     * Call from the browser console:
     *   window.renderSystem.injectBuildingIntersection()
     * or from Playwright:
     *   await page.evaluate("window.renderSystem.injectBuildingIntersection()")
     */
    public injectBuildingIntersection(overlapFraction: number = 1, maxAttempts: number = 20, maxCameraDistance: number = 400): BuildingInjectionResult | null {
        const sceneSystem = this.systemManager.getSystem(SceneSystem);
        const tiles = sceneSystem.objects.tiles;
        const camera = sceneSystem.objects.camera;

        // Filter to tiles that are loaded, in-frustum, and have at least 2 buildings.
        const candidateTiles = tiles.filter(tile =>
            tile.inFrustum &&
            tile.extrudedMesh &&
            tile.buildingOffsetMap.size >= 2
        );

        if (candidateTiles.length === 0) {
            console.warn('[injectBuildingIntersection] No candidate tiles found.');
            return null;
        }

        // Sort by distance so we bias toward buildings close to and likely
        // visible from the camera.
        candidateTiles.sort((a, b) =>
            (a.distanceToCamera ?? Infinity) - (b.distanceToCamera ?? Infinity)
        );

        // The camera's position in the camera-relative space tile.matrixWorld maps to.
        const cameraRelativePos = new Vec3(0, camera.position.y, 0);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // Cycle through tiles rather than hammering one repeatedly.
            const tile = candidateTiles[attempt % candidateTiles.length];
            const buildingIds = Array.from(tile.buildingOffsetMap.keys());

            if (buildingIds.length < 2) {
                continue;
            }

            const indexA = Math.floor(Math.random() * buildingIds.length);
            let indexB = Math.floor(Math.random() * buildingIds.length);
            while (indexB === indexA) {
                indexB = Math.floor(Math.random() * buildingIds.length);
            }

            const idA = buildingIds[indexA];
            const idB = buildingIds[indexB];

            const centroidA = tile.getBuildingCentroid(idA);
            const centroidB = tile.getBuildingCentroid(idB);

            if (!centroidA || !centroidB) {
                continue;
            }

            // Per-building frustum check using the engine's own method,
            // passing tile-local centroids — toSpace(tile.matrixWorld) inside
            // isPointInFrustum handles the coordinate conversion correctly.
            if (!this.isPointInFrustum(camera, tile, centroidA) ||
                !this.isPointInFrustum(camera, tile, centroidB)) {
                continue;
            }

            // Reject far-away pairs: a distant intersection isn't practically
            // visible to a human even if it changes enough pixels to pass
            // verification. tile.matrixWorld yields camera-relative coords, so
            // compare against cameraRelativePos, not the absolute camera.position.
            const worldA = Vec3.applyMatrix4(centroidA, tile.matrixWorld);
            if (Vec3.distance(worldA, cameraRelativePos) > maxCameraDistance) {
                continue;
            }

            const dx = (centroidB.x - centroidA.x) * overlapFraction;
            const dy = (centroidB.y - centroidA.y) * overlapFraction;
            const dz = (centroidB.z - centroidA.z) * overlapFraction;

            const success = tile.translateBuilding(idA, dx, dy, dz);

            if (!success) {
                continue;
            }

            console.log(`[injectBuildingIntersection] attempt ${attempt + 1}: tile ${tile.localId}, ` +
                `moving building ${idA} by dx=${dx.toFixed(1)}, dy=${dy.toFixed(1)}, dz=${dz.toFixed(1)}`);

            return {
                tileLocalId: tile.localId,
                buildingIdA: idA,
                buildingIdB: idB,
                dx,
                dy,
                dz,
                overlapFraction
            };
        }

        console.warn(`[injectBuildingIntersection] Gave up after ${maxAttempts} attempts — no on-screen pair found.`);
        return null;
    }

    /**
     * Like injectBuildingIntersection, but engineered to produce true z-fighting
     * rather than clean interpenetration seams. Z-fighting needs two surfaces at
     * (nearly) identical depth, so this picks two FLAT-ROOFED buildings, slides
     * one horizontally into the other, and shifts it vertically so both roof
     * planes are EXACTLY coplanar. The two roofs have different triangulations,
     * so their interpolated depths differ by sub-precision amounts across the
     * overlap area — the classic stitching/shimmering artifact.
     *
     * Call from Playwright:
     *   await page.evaluate("window.renderSystem.injectBuildingZFighting()")
     */
    public injectBuildingZFighting(
        overlapFraction: number = 0.85,
        maxTiles: number = 8,
        maxRoofHeightDelta: number = 8,
        minFlatVertices: number = 6,
        maxPairDistance: number = 60,
        minPairDistance: number = 1.5,
        maxCameraDistance: number = 400
    ): BuildingInjectionResult | null {
        const sceneSystem = this.systemManager.getSystem(SceneSystem);
        const tiles = sceneSystem.objects.tiles;
        const camera = sceneSystem.objects.camera;

        const candidateTiles = tiles.filter(tile =>
            tile.inFrustum &&
            tile.extrudedMesh &&
            tile.buildingOffsetMap.size >= 2
        );

        if (candidateTiles.length === 0) {
            console.warn('[injectBuildingZFighting] No candidate tiles found.');
            return null;
        }

        // Nearest tiles first so the z-fight lands close to the camera.
        candidateTiles.sort((a, b) =>
            (a.distanceToCamera ?? Infinity) - (b.distanceToCamera ?? Infinity)
        );

        // The camera's position in the camera-relative space tile.matrixWorld maps to.
        const cameraRelativePos = new Vec3(0, camera.position.y, 0);

        for (const tile of candidateTiles.slice(0, maxTiles)) {
            // Collect every flat-roofed, on-screen building in this tile.
            const suitable: {id: number; centroid: Vec3; maxY: number; roofSignature: number}[] = [];

            for (const id of tile.buildingOffsetMap.keys()) {
                const centroid = tile.getBuildingCentroid(id);
                const roof = tile.getBuildingRoofInfo(id);

                if (!centroid || !roof) continue;
                if (roof.flatVertexCount < minFlatVertices) continue;
                if (roof.roofSignature < 0) continue;
                if (!this.isPointInFrustum(camera, tile, centroid)) continue;

                // Reject buildings too far from the camera: a distant z-fight,
                // even if it changes enough pixels to pass verification, is not
                // practically visible to a human. tile.matrixWorld yields
                // CAMERA-RELATIVE coords (the tile hierarchy is offset by
                // -camera.x/-camera.z via the scene wrapper), so the camera sits
                // at (0, camera.position.y, 0) in this space — NOT at the absolute
                // mercator camera.position.
                const worldCentroid = Vec3.applyMatrix4(centroid, tile.matrixWorld);
                if (Vec3.distance(worldCentroid, cameraRelativePos) > maxCameraDistance) continue;

                suitable.push({id, centroid, maxY: roof.maxY, roofSignature: roof.roofSignature});
            }

            if (suitable.length < 2) {
                continue;
            }

            // Find the CLOSEST compatible pair. A small separation keeps the
            // horizontal slide short, so building A stays near B and on screen —
            // the failure mode we're avoiding is teleporting A hundreds of metres
            // into a far-away partner, which produces a tiny z-fight in the
            // distance instead of a prominent near-field one.
            let best: {a: typeof suitable[0]; b: typeof suitable[0]; dist: number} | null = null;

            for (let i = 0; i < suitable.length; i++) {
                for (let j = i + 1; j < suitable.length; j++) {
                    const a = suitable[i];
                    const b = suitable[j];

                    if (Math.abs(a.maxY - b.maxY) > maxRoofHeightDelta) continue;

                    // Require DIFFERENT roof appearance, else the coplanar overlap
                    // renders identically whichever surface wins and the z-fight is
                    // invisible ("normalized"). This is the fix the user asked for:
                    // only place roofs of different textures/colors together.
                    if (a.roofSignature === b.roofSignature) continue;

                    const ddx = b.centroid.x - a.centroid.x;
                    const ddz = b.centroid.z - a.centroid.z;
                    const dist = Math.sqrt(ddx * ddx + ddz * ddz);

                    // Below minPairDistance the two ids are almost always parts of
                    // the SAME physical building (Simple 3D Buildings splits a
                    // building into parts sharing a footprint) — overlapping those
                    // is a no-op, so require a real gap between distinct buildings.
                    if (dist < minPairDistance || dist > maxPairDistance) continue;

                    if (!best || dist < best.dist) {
                        best = {a, b, dist};
                    }
                }
            }

            if (!best) {
                continue;
            }

            // Move the taller-index building toward the other, aligning roofs exactly.
            const {a, b} = best;
            const dx = (b.centroid.x - a.centroid.x) * overlapFraction;
            const dz = (b.centroid.z - a.centroid.z) * overlapFraction;
            const dy = b.maxY - a.maxY;

            const success = tile.translateBuilding(a.id, dx, dy, dz);

            if (!success) {
                continue;
            }

            console.log(`[injectBuildingZFighting] tile ${tile.localId}, ` +
                `moving building ${a.id} by dx=${dx.toFixed(1)}, dy=${dy.toFixed(3)}, dz=${dz.toFixed(1)} ` +
                `(pair ${best.dist.toFixed(1)}m apart, roof planes aligned at y=${b.maxY.toFixed(2)})`);

            return {
                tileLocalId: tile.localId,
                buildingIdA: a.id,
                buildingIdB: b.id,
                dx,
                dy,
                dz,
                overlapFraction
            };
        }

        console.warn(`[injectBuildingZFighting] Gave up — no nearby flat-roofed on-screen pair found.`);
        return null;
    }

    /**
     * Replays a previously recorded building injection deterministically.
     * Pass the BuildingInjectionResult object saved from a prior
     * injectBuildingIntersection call to reproduce the exact same visual error.
     * Returns true if the tile and building were found and the patch was applied.
     */
    public replayBuildingIntersection(result: BuildingInjectionResult): boolean {
        const sceneSystem = this.systemManager.getSystem(SceneSystem);
        const tiles = sceneSystem.objects.tiles;

        const tile = tiles.find(t => t.localId === result.tileLocalId);

        if (!tile) {
            console.warn(`[replayBuildingIntersection] Tile ${result.tileLocalId} not found — is the same URL loaded?`);
            return false;
        }

        if (!tile.extrudedMesh) {
            console.warn(`[replayBuildingIntersection] Tile ${result.tileLocalId} has no extrudedMesh yet — tiles still loading?`);
            return false;
        }

        return tile.translateBuilding(result.buildingIdA, result.dx, result.dy, result.dz);
    }
}