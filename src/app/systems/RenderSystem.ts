import Vec2 from "~/lib/math/Vec2";
import System from "../System";
import PickingSystem from "./PickingSystem";
import GBufferPass from "../render/passes/GBufferPass";
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
import CursorStyleSystem from "~/app/systems/CursorStyleSystem";

export default class RenderSystem extends System {
    private renderer: AbstractRenderer;
    private frameCount: number = 0;

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

        // --- 3. TILT/SHEAR ANOMALY INJECTION ---
        // REMOVED: this previously applied a per-frame oscillating sin/cos shear
        // to projectionMatrix[8]/[9] on EVERY frame, regardless of which error
        // type was being generated. That meant the "clean" baseline, aliasing,
        // and shadow-anomaly datasets all silently contained a time-varying
        // shear artifact stacked on top of (and interacting unpredictably with)
        // the tiltX/tiltY values your Python script injects into GBufferPass.ts.
        //
        // If GBufferPass.ts's artificialNear/artificialFar/tiltX/tiltY already
        // implement your intended tilt-clipping error end-to-end (i.e. the
        // shader/projection setup there reads tiltX/tiltY and applies the
        // shear only for that error type), then this block should stay removed
        // entirely. If GBufferPass.ts's tiltX/tiltY constants are NOT actually
        // wired into the projection matrix anywhere, and this was the only
        // place the tilt was ever applied, you need to re-introduce a gated
        // version instead — something like:
        //
        // if (this.errorInjectionMode === 'clipping') {
        //     const pass = <GBufferPass>this.passManager.getPass('GBufferPass');
        //     sceneSystem.objects.camera.projectionMatrix[8] += pass.tiltX;
        //     sceneSystem.objects.camera.projectionMatrix[9] += pass.tiltY;
        // }
        //
        // i.e. driven by the static constants your Python regex already
        // writes, not by a hardcoded sinusoid keyed to elapsed time. Check
        // GBufferPass.ts before deciding which path applies.

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
        // 1.0 is native resolution.
        // 0.5 is half resolution (standard aliasing).
        // 0.25 or lower creates severe, blocky, PS1-era aliasing and flickering geometry.
        // This constant is rewritten in-place by StreetsGL.inject_aliasing() (Python side)
        // via a regex on "const degradationFactor = 1.0;" before the browser is launched.
        // It will NOT pick up changes while the page is already running — the file must
        // be edited before page load/reload, since this getter is just re-read every frame.
        const degradationFactor = 1.0;

        return new Vec2(
            Math.floor(window.innerWidth * degradationFactor),
            Math.floor(window.innerHeight * degradationFactor)
        );
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

    /**
     * Scans the WebGL object-ID buffer for the !gl_FrontFacing emergency flag,
     * which indicates the near plane is clipping/penetrating building geometry
     * somewhere on screen (or the camera itself is inside a building).
     *
     * FIX: the original version used `step = 1`, i.e. a single-pixel
     * `readObjectId` GPU readback call for EVERY pixel on screen — at 1920x1080
     * that's ~2,073,600 synchronous CPU<->GPU sync points per check, which will
     * stall/hang the renderer (and likely the whole tab) for seconds at a time.
     * The comment directly above the loop already described the intended
     * mitigation ("scan every 50 pixels... sparse enough so the synchronous
     * GPU reads do not freeze the browser") — the code just didn't match the
     * comment. This version actually uses that step size.
     *
     * NOTE: this is still O((width/step) * (height/step)) single-pixel GPU
     * reads, which is the right tradeoff only if `PickingSystem.readObjectId`
     * truly only supports single-pixel reads. If your renderer/PickingSystem
     * exposes a way to read the entire objectId render target in ONE call
     * (e.g. a full-viewport gl.readPixels wrapped as something like
     * `pickingSystem.readObjectIdBuffer(pass.objectIdFullBuffer)` returning a
     * Uint32Array you can scan in JS), switch to that instead — it replaces
     * thousands of GPU syncs with exactly one. See the commented-out
     * `isScreenClippedFast` stub below for the shape that would take; you'll
     * need to fill in the actual buffer-read API your engine exposes.
     */
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

    // --- OPTIONAL FAST PATH (not active) ---
    // Sketch only. Uncomment and adapt once you confirm what your renderer/
    // PickingSystem actually expose for a full-buffer read. The goal: ONE
    // GPU readback of the whole objectId target, then scan the typed array
    // in plain JS (cheap, no further GPU sync).
    //
    // public isScreenClippedFast(): boolean {
    //     const pass = <GBufferPass>this.passManager.getPass('GBufferPass');
    //     if (!pass) return false;
    //
    //     const pickingSystem = this.systemManager.getSystem(PickingSystem);
    //     const width = this.resolutionUI.x;
    //     const height = this.resolutionUI.y;
    //
    //     // Hypothetical full-buffer read — replace with your actual API.
    //     // Needs to return a Uint32Array of length width * height, one
    //     // object-id value per pixel, read in a single gl.readPixels call.
    //     const fullBuffer: Uint32Array = pickingSystem.readObjectIdFullBuffer(
    //         pass.objectIdTexture, width, height
    //     );
    //
    //     for (let i = 0; i < fullBuffer.length; i++) {
    //         if (fullBuffer[i] === 4294967295) {
    //             return true;
    //         }
    //     }
    //     return false;
    // }
}