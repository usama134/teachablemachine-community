/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */
import * as tf from "@tensorflow/tfjs";
import * as posenet from "@tensorflow-models/posenet";
import { PosenetInput, Padding } from "@tensorflow-models/posenet/dist/types";
import {
	padAndResizeTo,
	scaleAndFlipPoses,
	getInputTensorDimensions,
	toTensorBuffers3D
} from "@tensorflow-models/posenet/dist/util";
import { util, SymbolicTensor } from "@tensorflow/tfjs";
import { version } from "./version";
import { decodeMultiplePoses } from "@tensorflow-models/posenet";
/**
 * the metadata to describe the model's creation,
 * includes the labels associated with the classes
 * and versioning information from training.
 */
export interface Metadata {
	tfjsVersion: string;
	tmVersion?: string;
	tmSupportVersion: string;
	modelName?: string;
	timeStamp?: string;
	labels: string[];
	userMetadata?: {};
}

const MAX_PREDICTIONS = 3;
/**
 * Receives a Metadata object and fills in the optional fields such as timeStamp
 * @param data a Metadata object
 */
const fillMetadata = (data: Partial<Metadata>) => {
	// util.assert(
	// 	typeof data.tfjsVersion === "string",
	// 	() => `metadata.tfjsVersion is invalid`
	// );
	data.tmSupportVersion = data.tmSupportVersion || version;
	data.timeStamp = data.timeStamp || new Date().toISOString();
	data.userMetadata = data.userMetadata || {};
	data.modelName = data.modelName || "untitled";
	data.labels = data.labels || [];
	return data as Metadata;
};
// tslint:disable-next-line:no-any
const isMetadata = (c: any): c is Metadata =>
	!!c &&
	typeof c.tmVersion === "string" &&
	typeof c.tmSupportVersion === "string" &&
	Array.isArray(c.labels);

/**
 * process either a URL string or a Metadata object
 * @param metadata a url to load metadata or a Metadata object
 */
const processMetadata = async (metadata: string | Metadata) => {
	let metadataJSON: Metadata;
	if (typeof metadata === "string") {
		util.assert(
			metadata.indexOf("http") === 0,
			() => "metadata is a string but not a valid url"
		);
		metadataJSON = await (await fetch(metadata)).json();
	} else if (isMetadata(metadata)) {
		metadataJSON = metadata;
	} else {
		throw new Error("Invalid Metadata provided");
	}
	return fillMetadata(metadataJSON);
};

export type ClassifierInputSource = PosenetInput;

/**
 * Computes the probabilities of the topK classes given logits by computing
 * softmax to get probabilities and then sorting the probabilities.
 * @param logits Tensor representing the logits from MobileNet.
 * @param topK The number of top predictions to show.
 */
export async function getTopKClasses(
	labels: string[],
	logits: tf.Tensor<tf.Rank>,
	topK = 3
) {
	const values = await logits.data();
	return tf.tidy(() => {
		topK = Math.min(topK, values.length);
		const valuesAndIndices = [];
		for (let i = 0; i < values.length; i++) {
			valuesAndIndices.push({ value: values[i], index: i });
		}
		valuesAndIndices.sort((a, b) => {
			return b.value - a.value;
		});
		const topkValues = new Float32Array(topK);
		const topkIndices = new Int32Array(topK);
		for (let i = 0; i < topK; i++) {
			topkValues[i] = valuesAndIndices[i].value;
			topkIndices[i] = valuesAndIndices[i].index;
		}
		const topClassesAndProbs = [];
		for (let i = 0; i < topkIndices.length; i++) {
			topClassesAndProbs.push({
				className: labels[topkIndices[i]], //IMAGENET_CLASSES[topkIndices[i]],
				probability: topkValues[i]
			});
		}
		return topClassesAndProbs;
	});
}
export class CustomPoseNet {
	protected _metadata: Metadata;
	// public model: tf.LayersModel;

	public getMetadata() {
		return this._metadata;
	}

	constructor(
		public model: tf.LayersModel,
		public posenetModel: posenet.PoseNet,
		metadata: Partial<Metadata>
	) {
		this._metadata = fillMetadata(metadata);
	}
	/**
	 * get the total number of classes existing within model
	 */
	getTotalClasses() {
		const output = this.model.output as SymbolicTensor;
		const totalClasses = output.shape[1];
		return totalClasses;
	}

	public async estimatePose(sample: PosenetInput, flipHorizontal = false) {
		const {
			heatmapScores,
			offsets,
			displacementFwd,
			displacementBwd,
			padding
		} = await this.estimatePoseOutputs(sample);

		const posenetOutput = this.poseOutputsToAray(
			heatmapScores,
			offsets,
			displacementFwd,
			displacementBwd
		);

		const pose = await this.poseOutputsToKeypoints(
			sample,
			heatmapScores,
			offsets,
			displacementFwd,
			displacementBwd,
			padding,
			flipHorizontal
		);

		return { pose, posenetOutput };
	}

	// for multi pose
	// taken from: https://github.com/tensorflow/tfjs-models/blob/master/posenet/src/posenet_model.ts
	public async estimatePoseOutputs(sample: PosenetInput) {
		const inputResolution = this.posenetModel.inputResolution;

		const { resized, padding } = padAndResizeTo(sample, [
			inputResolution,
			inputResolution
		]);

		const {heatmapScores, offsets, displacementFwd, displacementBwd} 
			= await this.posenetModel.baseModel.predict(resized);

		resized.dispose();

		return {heatmapScores, offsets, displacementFwd, displacementBwd, padding};
	}

	public poseOutputsToAray(
		heatmapScores: tf.Tensor3D,
		offsets: tf.Tensor3D,
		displacementFwd: tf.Tensor3D,
		displacementBwd: tf.Tensor3D
	) {
		const axis = 2;
		const concat = tf.concat([heatmapScores, offsets], axis);
		const concatArray = concat.dataSync() as Float32Array;

		concat.dispose();
		
		return concatArray;
	}

	public async poseOutputsToKeypoints(
		input: PosenetInput,
		heatmapScores: tf.Tensor3D,
		offsets: tf.Tensor3D,
		displacementFwd: tf.Tensor3D,
		displacementBwd: tf.Tensor3D,
		padding: Padding,
		flipHorizontal = false
	) {
		const config = {
			maxDetections: MAX_PREDICTIONS,
			scoreThreshold: 0.5,
			nmsRadius: 20
		};

		const [height, width] = getInputTensorDimensions(input);

		const outputStride = this.posenetModel.baseModel.outputStride;
		const inputResolution = this.posenetModel.inputResolution;

		const [scoresBuffer, offsetsBuffer, displacementsFwdBuffer, displacementsBwdBuffer] 
			= await toTensorBuffers3D([heatmapScores, offsets, displacementFwd, displacementBwd]);

		const poses = await decodeMultiplePoses(scoresBuffer, offsetsBuffer, displacementsFwdBuffer,
			displacementsBwdBuffer, outputStride, config.maxDetections, config.scoreThreshold, config.nmsRadius);

		const resultPoses = scaleAndFlipPoses(poses, [height, width], [inputResolution, inputResolution],
			padding, flipHorizontal);

		heatmapScores.dispose();
		offsets.dispose();
		displacementFwd.dispose();
		displacementBwd.dispose();
		
		return resultPoses[0];
	}

	/**
	 * Given an image element, makes a prediction through mobilenet returning the
	 * probabilities of the top K classes.
	 * @param image the image to classify
	 * @param maxPredictions the maximum number of classification predictions
	 */
	async predict(
		poseOutput: Float32Array,
		flipped = false,
		maxPredictions = MAX_PREDICTIONS
	) {
		// const embeddingsArray = await this.predictPosenet(image);
		// let embeddings = tf.tensor([embeddingsArray]);
	    const embeddings = tf.tensor([poseOutput]);
		const logits = this.model.predict(embeddings) as tf.Tensor;

		const topKClasses = await getTopKClasses(
			this._metadata.labels,
			logits,
			maxPredictions
		);

		embeddings.dispose();
		logits.dispose();

		return topKClasses;
	}

	public dispose() {
		this.posenetModel.dispose();
	}
}

export async function loadPoseNet() {
	const posenetModel = await posenet.load({
		architecture: "MobileNetV1",
		outputStride: 16,
		inputResolution: 257,
		multiplier: 0.75
	});
	return posenetModel;
}

export async function load(checkpoint: string, metadata?: string | Metadata) {
	const customModel = await tf.loadLayersModel(checkpoint);
	const metadataJSON = metadata ? await processMetadata(metadata) : null;
	const posenetModel = await loadPoseNet();
	return new CustomPoseNet(customModel, posenetModel, metadataJSON);
}
