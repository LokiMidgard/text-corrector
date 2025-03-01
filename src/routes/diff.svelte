<script lang="ts" module>
	// export const kinds = ['correction', 'original', 'alternative', 'edited'] as const;
	export type ParagraphKind = Exclude<
		NewCorrectionMetadata['paragraphInfo'][number]['selectedText'],
		undefined
	>;
	export type MetadataType = UpdateData & { timestamp: DateTime };
	export type CorrecedModel = monaco.editor.ITextModel & {
		metadata: MetadataType;
		getDecorationKeyOfIndex(this: CorrecedModel, index: number): string | undefined;
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
	import type { NewCorrectionMetadata, Review } from '$lib/server/git';
	import { trpc } from '$lib/trpc/client';
	import { DateTime, Duration } from 'luxon';
	import type { UpdateData } from '$lib/trpc/router';
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
		if (path && Monaco) {
			updateText(path);
		}
	});

	let now = $state(DateTime.now());
	setInterval(() => {
		now = DateTime.now();
	}, 500);

	let originalModel: CorrecedModel | undefined = $state();
	let correctionModel: CorrecedModel | undefined = $state();

	function updateModel(
		model: 'original' | 'correction',
		meta: NewCorrectionMetadata,
		path: string
	) {
		if (Monaco == undefined) {
			throw new Error('Monaco not initialized');
		}
		meta = JSON.parse(JSON.stringify(meta));
		let currentModel = model == 'original' ? originalModel : correctionModel;

		if (currentModel == undefined || currentModel.metadata.path != path) {
			const oldModel = currentModel;
			const text = meta.paragraphInfo.map((x) => {
				if (model == 'original' || x.selectedText == 'original') {
					x.selectedText = 'original';
					return [x.original, 'original'] as const;
				} else if (x.selectedText == undefined) {
					const judgment = Object.keys(x.judgment).toSorted()[0];
					if (judgment) {
						x.selectedText = [judgment, 'correction'];
						return [x.judgment[judgment].text.correction, 'correction'] as const;
					} else {
						x.selectedText = 'original';
						return [x.original, 'original'] as const;
					}
				} else if (x.selectedText == 'edited') {
					if (x.edited) {
						return [x.edited, 'edited'] as const;
					} else {
						x.selectedText = 'original';
						return [x.original, 'original'] as const;
					}
				} else if (x.selectedText[1] == 'correction') {
					return [x.judgment[x.selectedText[0]].text.correction, 'correction'] as const;
				} else if (x.selectedText[1] == 'alternative') {
					return [
						x.judgment[x.selectedText[0]].text.alternative[x.selectedText[2]],
						'alternative'
					] as const;
				} else {
					// we do not set the selected text here
					// so it will change as soon the correction is available
					return [x.original, 'original'] as const;
				}
			});
			currentModel = Monaco.editor.createModel(
				text.map(([x]) => x).join('\n'),
				'markdown'
			) as CorrecedModel;

			currentModel.metadata = {
				messages: meta.messages,
				path: path,
				paragraphInfo: meta.paragraphInfo,
				time_in_ms: meta.time_in_ms,
				timestamp: DateTime.now()
			};
			let lines = 0;
			const keys = currentModel.deltaDecorations(
				[],
				text.map(([value, type]) => {
					const currentLines = value.split('\n').length;

					const data = {
						options: {
							blockClassName: type
						},
						range: {
							endColumn: 1,
							startColumn: 1,
							startLineNumber: lines + 1,
							endLineNumber: lines + currentLines + 1
						}
					} satisfies monaco.editor.IModelDeltaDecoration;
					lines += currentLines;
					return data;
				})
			);
			let internalUpdate = false;
			const indexLookUp = {} as Record<number, string>;
			const keyLookup = {} as Record<string, number>;
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				const index = i;
				indexLookUp[index] = key;
				keyLookup[key] = index;
			}
			currentModel.getIndexOfDecorationKey = function (key) {
				return keyLookup[key];
			};
			currentModel.getIndexOfDecorationKey.bind(currentModel);

			currentModel.getDecorationKeyOfIndex = function (index) {
				return indexLookUp[index];
			};
			currentModel.getDecorationKeyOfIndex.bind(currentModel);

			currentModel.getCurrentKind = function (index) {
				const change = indexLookUp[index];
				if (change == undefined) {
					throw new Error(`No Changes for ${index}`);
				}
				const current = this.metadata.paragraphInfo[index].judgment
					? (this.metadata.paragraphInfo[index].selectedText ?? 'original')
					: 'original';
				return current;
			};
			currentModel.getCurrentKind.bind(currentModel);

			currentModel.handleTextEdits = function (change) {
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

					// get text in decoration
					const text = this.getValueInRange(decoration.range);
					this.metadata.paragraphInfo[index].edited = text;
					const [newKey] = this.deltaDecorations(
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
					this.metadata.paragraphInfo[index].selectedText = 'edited';
					if (newKey != decoration.id) {
						delete keyLookup[decoration.id];
						indexLookUp[index] = newKey;
						keyLookup[newKey] = index;
					}
				});
			};
			currentModel.handleTextEdits.bind(currentModel);

			currentModel.hasKind = function (index, kind) {
				const info = this.metadata?.paragraphInfo[index];
				if (info == undefined) {
					throw new Error(`Unable to get metadata for ${index}`);
				}

				if (kind == 'original') {
					return true;
				} else if (kind == 'edited') {
					return info.edited != undefined;
				} else if (kind[1] == 'correction') {
					return (
						info.judgment[kind[0]] != undefined &&
						info.judgment[kind[0]].text.correction != info.original
					);
				} else if (kind[1] == 'alternative') {
					return (
						info.judgment[kind[0]].text.alternative[kind[2]] != undefined &&
						info.judgment[kind[0]].text.alternative[kind[2]] != info.original
					);
				} else {
					// we should have all cases
					throw new Error('Sholud not happen');
				}
			};
			currentModel.hasKind.bind(currentModel);

			currentModel.setKind = function (index, kind) {
				internalUpdate = true;
				try {
					const info = this.metadata.paragraphInfo[index];
					if (info == undefined) {
						throw new Error(`could not find data for ${index}`);
					}
					if (!this.hasKind(index, kind)) {
						throw new Error(`Kind ${kind} not available for ${index}`);
					}
					const newTextUnformated =
						kind == 'original'
							? info.original
							: kind == 'edited'
								? info.edited!
								: kind[1] == 'correction'
									? info.judgment[kind[0]].text.correction
									: kind[1] == 'alternative'
										? info.judgment[kind[0]].text.alternative[kind[2]]
										: undefined;
					if (newTextUnformated == undefined) {
						throw new Error(`Cant find text for ${kind}`);
					}
					let newText = formatMarkdown(newTextUnformated);
					const oldText = this.getValueInRange(
						this.getDecorationRange(this.getDecorationKeyOfIndex(index)!)!
					);
					const newLinesAtEndOld = oldText.match(/\n*$/)![0].length;
					const newLinesAtEndNew = newText.match(/\n*$/)![0].length;

					//ensure exactly one newline at the end
					if (newLinesAtEndNew > 1) {
						newText = newText.slice(0, -newLinesAtEndNew + 1);
					} else if (newLinesAtEndNew < 1) {
						newText = newText + '\n';
					}

					const decorationKey = this.getDecorationKeyOfIndex(index);
					if (decorationKey == undefined) {
						throw new Error(`Could not find decoration key for ${index}`);
					}
					const range = this.getDecorationRange(decorationKey);
					if (range == undefined) {
						throw new Error(`Could not find decoration for ${decorationKey}`);
					}
					// replace only up to one new line from the old text
					const endLineNumber = range.endLineNumber - (newLinesAtEndOld - 1);

					this.metadata.paragraphInfo[index].selectedText = kind;

					this.applyEdits([
						{
							range: {
								...range,
								endLineNumber
							},
							text: newText
						}
					]);
					const rangeAfterChange = this.getDecorationRange(decorationKey);

					console.log(
						`range ${JSON.stringify(range)} rangeAfterChange ${JSON.stringify(rangeAfterChange)}`
					);
					if (rangeAfterChange == undefined) {
						throw new Error(`Could not find decoration for ${decorationKey}`);
					}

					const [newKey] = this.deltaDecorations(
						[decorationKey],
						[
							{
								options: {
									blockClassName: typeof kind == 'string' ? kind : kind[1]
								},
								range: rangeAfterChange
							}
						]
					);

					// console.log(`old key ${decorationKey} newKey ${newKey[0]}`);
					if (newKey != decorationKey) {
						delete keyLookup[decorationKey];
						indexLookUp[index] = newKey;
						keyLookup[newKey] = index;
					}
				} finally {
					internalUpdate = false;
				}
			};
			currentModel.setKind.bind(currentModel);

			const cc = currentModel;
			currentModel.onDidChangeContent((e) => {
				e.changes.forEach((change) => {
					cc.handleTextEdits(change);
				});
			});

			if (model == 'original') {
				originalModel = currentModel;
				editor.setModel({
					original: originalModel,
					modified: correctionModel ?? Monaco.editor.createModel('', 'markdown')
				});
				editor.getOriginalEditor().updateOptions({ readOnly: true });
				editor.getModifiedEditor().updateOptions({
					readOnly: !(correctionModel?.metadata.paragraphInfo.every((x) => x.judgment) ?? false)
				});
			} else {
				correctionModel = currentModel;
				editor.setModel({
					original: originalModel ?? Monaco.editor.createModel('', 'markdown'),
					modified: correctionModel
				});
				editor.getOriginalEditor().updateOptions({ readOnly: true });
				editor.getModifiedEditor().updateOptions({
					readOnly: !currentModel.metadata.paragraphInfo.every((x) => x.judgment)
				});
			}
			if (oldModel) {
				oldModel.dispose();
			}
		} else {
			const oldMetadata = currentModel.metadata;

			for (let i = 0; i < oldMetadata.paragraphInfo.length; i++) {
				const oldParagrapInfo = oldMetadata.paragraphInfo[i];
				const newParagrapInfo = meta.paragraphInfo[i];
				if (newParagrapInfo.original != oldParagrapInfo.original) {
					throw new Error('Original text should not be changed');
				}
				if (oldParagrapInfo.judgment || !newParagrapInfo.judgment) {
					continue;
					// Data should not be changed if it existed before
				}
				// everything but original sholud be changed…
				(oldParagrapInfo as any).judgment = newParagrapInfo.judgment;
				// the text should not be edited (this is only possible if everything is already set)
				const firstModel = Object.keys(newParagrapInfo.judgment).toSorted()[0];
				currentModel.setKind(
					i,
					model == 'original'
						? 'original'
						: (newParagrapInfo.selectedText ?? [firstModel, 'correction'])
				);
			}
		}
	}

	function updateText(selectedPath: string) {
		client.getCorrection.query(selectedPath).then((wrongMeta) => {
			if (!Monaco) return;
			const meta = wrongMeta as NewCorrectionMetadata;

			updateModel('original', meta, selectedPath);
			updateModel('correction', meta, selectedPath);
			metadata = { ...meta, path: selectedPath, timestamp: DateTime.now() };
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
				if (metadata && metadata.path == path) {
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

			// make readonly
			editor.getOriginalEditor().updateOptions({ readOnly: true });

			editor.getModifiedEditor().onDidChangeCursorSelection((e) => {
				if (!correctionModel) {
					return;
				}

				const shouldBeReadonly = correctionModel
					.getDecorationsInRange(e.selection)
					.map((x) => x.id)
					.map((key) => {
						if (!correctionModel) {
							throw new Error('No correction model found');
						}
						const index = correctionModel.getIndexOfDecorationKey(key);
						if (index == undefined) {
							return false;
						}
						const shouldBeReadonly =
							correctionModel.hasKind(index, 'edited') &&
							correctionModel.getCurrentKind(index) != 'edited';
						return shouldBeReadonly;
					})
					.some((x) => x);
				if (shouldBeReadonly) {
					editor.getModifiedEditor().updateOptions({ readOnly: true });
				} else {
					editor.getModifiedEditor().updateOptions({ readOnly: false });
				}

				// const index = correctionModel.getIndexOfPosition('line', e.selection.startLineNumber);
				// if (index == undefined) {
				// 	return;
				// }
				// const kind = correctionModel.getCurrentKind(index);
				// if (kind == 'edited') {
				// 	correctionModel?.setKind(index, 'correction');
				// }
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
		if (!correctionModel) {
			throw new Error('No correction model found');
		}

		const meta = JSON.parse(JSON.stringify(correctionModel.metadata)) as MetadataType;

		// HACK to ensure that the model is set
		// old version of backend did not yet set the model
		for (const element of meta.paragraphInfo) {
			if (element.judgment) {
				element.judgment.model = element.judgment.model ?? 'unknown';
			}
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
				metadata: meta,
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
			client.getCommitData.query().then((data) => {
				dialog_name = data.author.name;
				dialog_email = data.author.email;
				dialog_message = data.message;
			});
		}}>Save Draft</button
	>
	<button
		onclick={() => {
			openDialog = 'commit';
		}}>Complete Review</button
	>
	<div>
		{#if metadata}
			<div>
				Progress {metadata.paragraphInfo.filter((x) => x.judgment)}/{metadata.paragraphInfo.length}
			</div>

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
