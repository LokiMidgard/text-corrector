<script lang="ts" module>
	export const kinds = ['corrected', 'oiginal', 'alternative', 'edited'] as const;
	export type ParagraphKind = (typeof kinds)[number];
	export type MetadataType = UpdateData & { timestamp: DateTime };
	export type CorrecedModel = monaco.editor.ITextModel & {
		metadata: MetadataType;
		getIndexOfDecorationKey(this: CorrecedModel, key: string): number | undefined;
		getCurrentKind(this: CorrecedModel, index: number): ParagraphKind;
		hasKind(this: CorrecedModel, index: number, kind: ParagraphKind): boolean;
		setKind(this: CorrecedModel, index: number, kind: ParagraphKind): void;
		getIndexOfPosition(this: CorrecedModel, type: 'line', line: number): number;
		getIndexOfPosition(this: CorrecedModel, type: 'offset', offset: number): number;
		handleTextEdits(this: CorrecedModel, edits: monaco.editor.IModelContentChange): void;
	};
	export function isCorrectedModel(obj: unknown): obj is CorrecedModel {
		return typeof obj == 'object' && obj != undefined && 'getIndexOfDecorationKey' in obj;
	}
</script>

<script lang="ts">
	import type monaco from 'monaco-editor';
	import { onMount } from 'svelte';
	import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
	import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
	import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
	import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
	import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

	import { formatMarkdown, renderMarkdown } from '$lib';
	import { page } from '$app/stores';
	import type { CorrectionMetadata, Review } from '$lib/server/git';
	import { trpc } from '$lib/trpc/client';
	import { DateTime, Duration } from 'luxon';
	import type { UpdateData } from '$lib/trpc/router';
	import { number, object, set, unknown } from 'zod';
	import { monaco_init } from '$lib/client/monacoInit';

	let { path, client }: { path: string; client: ReturnType<typeof trpc> } = $props();

	let divEl: HTMLDivElement;
	let editor: monaco.editor.IStandaloneDiffEditor;
	let Monaco: typeof import('monaco-editor') | undefined = $state();

	let metadata: undefined | MetadataType = $state();

	let openDialog: undefined | 'draft' | 'commit' = $state();
	let dialog_name = $state('');
	let dialog_email = $state('');
	let dialog_message = $state('');

	$effect(() => {
		if (path && originalModel && correctionModel) {
			updateText(path);
		}
	});

	let now = $state(DateTime.now());
	setInterval(() => {
		now = DateTime.now();
	}, 500);

	let originalModel: monaco.editor.ITextModel | undefined = $state();
	let correctionModel: CorrecedModel | undefined = $state();
	function updateText(selectedPath: string) {
		client.getCorrection.query(selectedPath).then(({ correction, original, metadata: meta }) => {
			if (!originalModel || !correctionModel || !Monaco) return;
			originalModel.setValue(original);
			correctionModel.setValue(correction);

			const entries = Object.entries(meta.paragraphInfo);

			const keys = correctionModel.deltaDecorations(
				[],
				entries.map(([key, value]) => {
					return {
						options: {
							blockClassName: 'corrected' satisfies ParagraphKind
						},
						range: {
							endColumn: 1,
							startColumn: 1,
							endLineNumber: value.lines.end,
							startLineNumber: value.lines.start
						}
					} satisfies monaco.editor.IModelDeltaDecoration;
				})
			);

			const indexLookUp = {} as Record<number, string>;
			const keyLookup = {} as Record<string, number>;
			let internalUpdate = false;
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				const index = parseInt(entries[i][0]);
				indexLookUp[index] = key;
				keyLookup[key] = index;
			}

			editor
				.getModifiedEditor()
				.updateOptions({ readOnly: meta.paragraph.value != meta.paragraph.of });
			metadata = meta as MetadataType;

			correctionModel.metadata = metadata;
			correctionModel.getIndexOfDecorationKey = function (key) {
				return keyLookup[key];
			};
			correctionModel.getIndexOfDecorationKey.bind(correctionModel);
			correctionModel.getCurrentKind = (index) => {
				const change = indexLookUp[index];
				if (change == undefined) {
					throw new Error(`No Changes for ${index}`);
				}
				const blockClassName = correctionModel?.getDecorationOptions(change)?.blockClassName;
				if (blockClassName == undefined) {
					throw new Error(`Unable to get class of ${change} for ${index}`);
				}
				return blockClassName as ParagraphKind;
			};
			correctionModel.getCurrentKind.bind(correctionModel);
			correctionModel.handleTextEdits = function (change) {
				if (internalUpdate) {
					return;
				}
				const decorations = this.getDecorationsInRange(change.range).filter(
					(x) => this.getIndexOfDecorationKey(x.id) != undefined
				);

				decorations.forEach((decoration) => {
					const index = this.getIndexOfDecorationKey(decoration.id);
					if (index == undefined) {
						throw new Error('Unable to get index');
					}
					this.metadata.paragraphInfo[index].lines.start = decoration.range.startLineNumber;
					this.metadata.paragraphInfo[index].lines.end = decoration.range.endLineNumber;

					// get text in decoration
					const text = this.getValueInRange(decoration.range);
					this.metadata.paragraphInfo[index].edited = text;
					const newKey = this.deltaDecorations(
						[decoration.id],
						[
							{
								options: {
									blockClassName: 'edited'
								},
								range: decoration.range
							}
						]
					);
					if (newKey.length != 1) {
						throw new Error(`Expected 1 key got ${newKey.length}`);
					}
					delete keyLookup[decoration.id];
					indexLookUp[index] = newKey[0];
					keyLookup[newKey[0]] = index;
				});
			};
			correctionModel.handleTextEdits.bind(correctionModel);
			correctionModel.hasKind = (index, kind) => {
				const info = metadata?.paragraphInfo[index];
				if (info == undefined) {
					throw new Error(`Unable to get metadata for ${index}`);
				}
				if (kind == 'alternative') {
					return (
						info.alternative != undefined &&
						info.alternative != info.corrected &&
						info.alternative != info.original
					);
				} else if (kind == 'corrected') {
					return info.corrected != undefined && info.corrected != info.original;
				} else if (kind == 'edited') {
					return info.edited != undefined;
				} else if (kind == 'oiginal') {
					return true;
				} else {
					throw new Error(`Unknown kind ${kind}`);
				}
			};
			correctionModel.hasKind.bind(correctionModel);
			correctionModel.setKind = function (index, kind) {
				internalUpdate = true;
				try {
					const info = this.metadata.paragraphInfo[index];
					if (info == undefined) {
						throw new Error(`could not find data for ${index}`);
					}
					if (!this.hasKind(index, kind)) {
						throw new Error(`Kind ${kind} not available for ${index}`);
					}
					// const currentKind = this.getCurrentKind(index);
					// const currentText =
					// 	currentKind == 'alternative'
					// 		? info.alternative
					// 		: currentKind == 'corrected'
					// 			? info.corrected
					// 			: currentKind == 'oiginal'
					// 				? info.original
					// 				: currentKind == 'edited'
					// 					? info.edited
					// 					: undefined;
					// if (currentText == undefined) {
					// 	throw new Error(`Cant find text for ${currentKind}`);
					// }
					const newTextUnformated =
						kind == 'alternative'
							? info.alternative
							: kind == 'corrected'
								? info.corrected
								: kind == 'oiginal'
									? info.original
									: kind == 'edited'
										? info.edited
										: undefined;
					if (newTextUnformated == undefined) {
						throw new Error(`Cant find text for ${kind}`);
					}
					const newText = formatMarkdown(newTextUnformated);

					const newTextLines = newText.split('\n').length - 1;
					const oldTextLines = info.lines.end - info.lines.start;
					const delta = newTextLines - oldTextLines;

					this.applyEdits([
						{
							range: {
								startColumn: 1,
								endColumn: 1,
								startLineNumber: info.lines.start,
								endLineNumber: info.lines.end
							},
							text: newText
						}
					]);
					info.lines.end += delta;
					Object.keys(this.metadata.paragraphInfo)
						.map((x) => parseInt(x))
						.filter((x) => x > index)
						.forEach((i) => {
							this.metadata.paragraphInfo[i].lines.end + delta;
							this.metadata.paragraphInfo[i].lines.start + delta;
						});

					const key = indexLookUp[index];
					console.log(`new lines ${info.lines.start} ${info.lines.end}`, info.lines);
					const newKey = this.deltaDecorations(
						[key],
						[
							{
								options: {
									blockClassName: kind
								},
								range: {
									endColumn: 1,
									startColumn: 1,
									endLineNumber: info.lines.end,
									startLineNumber: info.lines.start
								}
							}
						]
					);
					this.getAllDecorations()
						.filter((x) => x.id == newKey[0])
						.forEach((x) => {
							console.log('new decoration range', x.range);
						});
					if (newKey.length != 1) {
						throw new Error(`Expected 1 key got ${newKey.length}`);
					}
					console.log(`old key ${key} newKey ${newKey[0]}`);
					delete keyLookup[key];
					indexLookUp[index] = newKey[0];
					keyLookup[newKey[0]] = index;
				} finally {
					internalUpdate = false;
				}
			};
			correctionModel.setKind.bind(correctionModel);
		});
		console.log('selectedPath', selectedPath);
	}

	onMount(() => {
		// @ts-ignore
		self.MonacoEnvironment = {
			getWorker: function (_moduleId: any, label: string) {
				if (label === 'json') {
					return new jsonWorker();
				}
				if (label === 'css' || label === 'scss' || label === 'less') {
					return new cssWorker();
				}
				if (label === 'html' || label === 'handlebars' || label === 'razor') {
					return new htmlWorker();
				}
				if (label === 'typescript' || label === 'javascript') {
					return new tsWorker();
				}

				return new editorWorker();
			}
		};

		client.onMessage.subscribe(undefined, {
			onStarted() {
				console.log('connected');
			},
			onStopped() {
				console.log('disconnected');
			},
			onError(error) {
				console.error('error connection faild', error);
			},
			onComplete() {
				console.log('complete');
			},
			onData(message) {
				console.log('message', message);
				if (
					metadata &&
					metadata.path == path &&
					message.paragraph.value !== metadata.paragraph.value
				) {
					// update text
					updateText(path);
				}
			}
		});

		monaco_init().then((monaco) => {
			if (!divEl) return;
			Monaco = monaco;

			const lang = 'markdown';

			editor = Monaco.editor.createDiffEditor(divEl, {
				automaticLayout: true,
				// value: ['function x() {', '\tconsole.log("Hello world!");', '}'].join('\n'),
				// language: 'javascript'
				// automaticLayout: true // <<== the important part
				diffCodeLens: true
			});

			originalModel = Monaco.editor.createModel('', lang);
			// make readonly
			editor.getOriginalEditor().updateOptions({ readOnly: true });
			correctionModel = Monaco.editor.createModel('', lang);
			correctionModel?.onDidChangeContent((e) => {
				e.changes.forEach((change) => {
					const model = correctionModel;
					if (!isCorrectedModel(model)) {
						return;
					}
					model.handleTextEdits(change);
				});
			});

			editor.setModel({
				original: originalModel,
				modified: correctionModel
			});

			window.onresize = function () {
				editor.layout();
			};
		});
		return () => {
			editor.dispose();
		};
	});

	async function store() {
		const text = correctionModel?.getValue();
		if (!text) {
			throw new Error('No text found');
		}
		console.log('store', text);
		if (openDialog == 'commit') {
			await client.finishText.query({
				path,
				text,
				commitDetails: {
					author: {
						email: dialog_email,
						name: dialog_name
					},
					message: dialog_message
				}
			});
			updateText(path);
		} else if (openDialog == 'draft') {
			await client.updateText.query({
				path,
				text,
				commitDetails: {
					author: {
						email: dialog_email,
						name: dialog_name
					},
					message: dialog_message
				}
			});
		}
		openDialog = undefined;
	}
</script>

<dialog open={openDialog != undefined}>
	<article>
		<header>
			<button rel="prev">x</button>
			{#if openDialog == 'commit'}
				<strong>Complete Review</strong>
			{:else if openDialog == 'draft'}
				<strong>Store Draft</strong>
			{/if}
		</header>
		<form>
			<label>
				Name
				<input type="text" bind:value={dialog_name} />
			</label>
			<label>
				E-Mail
				<input type="text" bind:value={dialog_email} />
			</label>
			<label>
				Message
				<textarea bind:value={dialog_message} />
			</label>
		</form>
		<footer>
			<button onclick={() => store()}>Save</button><button
				onclick={() => (openDialog = undefined)}
				class="outline">Cancel</button
			>
		</footer>
	</article>
</dialog>

<header>
	<button
		onclick={() => {
			openDialog = 'draft';
		}}>Save Draft</button
	>
	<button
		onclick={() => {
			openDialog = 'commit';
		}}>Complete Review</button
	>
	<div>
		{#if metadata}
			<div>Progress {metadata.paragraph.value}/{metadata.paragraph.of}</div>

			<div>
				{#each metadata.messages as message}
					<div>{message}</div>
				{/each}
			</div>
		{/if}
	</div>
</header>

<div bind:this={divEl} class="h-screen"></div>

<style>
	:root {
		--header-hight: 3rem;
	}
	dialog {
		z-index: 1000;
	}
	:global(body) {
		overflow: hidden;
	}
	:global(main) > header {
		height: var(--header-hight);
	}
	.h-screen {
		height: calc(100cqh - var(--header-hight));
	}
</style>
