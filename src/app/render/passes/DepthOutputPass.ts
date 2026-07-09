import Pass from './Pass';
import * as RG from "~/lib/render-graph";
import RenderPassResource from '../render-graph/resources/RenderPassResource';
import PassManager from '../PassManager';
import AbstractMaterial from '~/lib/renderer/abstract-renderer/AbstractMaterial';
import AbstractTexture2D from '~/lib/renderer/abstract-renderer/AbstractTexture2D';
import FullScreenTriangle from '../../objects/FullScreenTriangle';
import {UniformMatrix4} from "~/lib/renderer/abstract-renderer/Uniform";
import DepthOutputMaterialContainer from "../materials/DepthOutputMaterialContainer";

export interface DepthBufferResult {
	width: number;
	height: number;
	data: Float32Array;
}

export default class DepthOutputPass extends Pass<{
	GBuffer: {
		type: RG.InternalResourceType.Input;
		resource: RenderPassResource;
	};
	DepthOutput: {
		type: RG.InternalResourceType.Output;
		resource: RenderPassResource;
	};
}> {
	private depthOutputMaterial: AbstractMaterial;
	private fullScreenTriangle: FullScreenTriangle;

	public constructor(manager: PassManager) {
		super('DepthOutputPass', manager, {
			GBuffer: {type: RG.InternalResourceType.Input, resource: manager.getSharedResource('GBufferRenderPass')},
			DepthOutput: {type: RG.InternalResourceType.Output, resource: manager.getSharedResource('DepthOutput')}
		});

		this.init();
	}

	private init(): void {
		this.depthOutputMaterial = new DepthOutputMaterialContainer(this.renderer).material;
		this.fullScreenTriangle = new FullScreenTriangle(this.renderer);
	}

	public render(): void {
		const camera = this.manager.sceneSystem.objects.camera;
		const depthTexture = <AbstractTexture2D>this.getPhysicalResource('GBuffer').depthAttachment.texture;

		this.depthOutputMaterial.getUniform('tDepth').value = depthTexture;
		this.depthOutputMaterial.getUniform<UniformMatrix4>('projectionMatrixInverse', 'MainBlock').value =
			new Float32Array(camera.jitteredProjectionMatrixInverse.values);
		this.depthOutputMaterial.updateUniformBlock('MainBlock');

		this.renderer.beginRenderPass(this.getPhysicalResource('DepthOutput'));
		this.renderer.useMaterial(this.depthOutputMaterial);

		this.fullScreenTriangle.mesh.draw();
	}

	/**
	 * Reads back the full-resolution linear depth buffer (distance from the
	 * camera in meters, per pixel) produced by the last render.
	 *
	 * Call from Playwright:
	 *   await page.evaluate("window.renderSystem.getDepthBuffer()")
	 */
	public async readDepthBuffer(): Promise<DepthBufferResult> {
		const resource = this.getPhysicalResource('DepthOutput');
		const texture = <AbstractTexture2D>resource.colorAttachments[0].texture;
		const width = texture.width;
		const height = texture.height;
		const rows = new Float32Array(width * height);

		await resource.readColorAttachmentPixel(0, rows, 0, 0, width, height);

		// readColorAttachmentPixel comes back in OpenGL's bottom-to-top row
		// order; flip it here so data[0] is the top-left pixel, matching the
		// paired screenshot's row order.
		const data = new Float32Array(width * height);

		for (let row = 0; row < height; row++) {
			const srcRow = height - row - 1;

			data.set(rows.subarray(srcRow * width, srcRow * width + width), row * width);
		}

		return {width, height, data};
	}

	public setSize(width: number, height: number): void {

	}
}
