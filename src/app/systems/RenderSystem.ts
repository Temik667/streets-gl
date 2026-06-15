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

        // --- 3. APPLY YOUR TILTED SHEAR ANOMALIES ---
        if (sceneSystem.objects.camera && sceneSystem.objects.camera.projectionMatrix) {
            const timePhase = (sceneSystem as any).timeElapsed * 2.0 || 0; 
            
            const tiltX = Math.sin(timePhase) * 0.5;
            const tiltY = Math.cos(timePhase * 0.8) * 0.5;

            sceneSystem.objects.camera.projectionMatrix[8] += tiltX;
            sceneSystem.objects.camera.projectionMatrix[9] += tiltY;
        }

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
        const degradationFactor = 1; 
        
        return new Vec2(
            Math.floor(window.innerWidth * degradationFactor), 
            Math.floor(window.innerHeight * degradationFactor)
        );
    }
}