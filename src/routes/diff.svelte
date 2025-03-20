<script lang="ts" module>
	// export const kinds = ['correction', 'original', 'alternative', 'edited'] as const;
	export type ParagraphKind = Exclude<
		NewCorrectionMetadata['paragraphInfo'][number]['selectedText'],
		undefined
	>;

	// data.paragraphInfo[0].edited
	export type MetadataType = NewCorrectionMetadata & {
		path: string;
		timestamp: Record<_ToObjectUnit, number>;
	} & {
		paragraphInfo: { editedOriginal?: string }[];
	};
	export type ModelDiagnostic = Exclude<
		MetadataType['paragraphInfo'][number]['corrected'],
		undefined
	>['corrections'][number] & {
		lineStart: number;
		lineEnd: number;
		columnStart: number;
		columnEnd: number;
	};
	export type changeDiagnosticOperation =
		| 'original'
		| 'original with dictionary'
		| { replace: string };
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
		getDiagnostic(this: CorrecedModel, index: monaco.Range): ModelDiagnostic[];
		changeDiagnostic(
			this: CorrecedModel,
			operation: changeDiagnosticOperation,
			diagnostic: ModelDiagnostic
		): void;
		configuredModels: { modelNames: string[]; styles: string[] };
	};
	export function isCorrectedModel(obj: unknown): obj is CorrecedModel {
		return typeof obj == 'object' && obj != undefined && 'getIndexOfDecorationKey' in obj;
	}
</script>

<script lang="ts">
	import type monaco from 'monaco-editor';
	import { onMount, type Snippet } from 'svelte';
	import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
	import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
	import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
	import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
	import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

	import { FontAwesomeIcon } from '@fortawesome/svelte-fontawesome';
	import { faFloppyDisk } from '@fortawesome/free-regular-svg-icons/faFloppyDisk';
	import { faUpload } from '@fortawesome/free-solid-svg-icons/faUpload';

	import { formatMarkdown, reduceDuration, renderMarkdown } from '$lib';
	import type { NewCorrectionMetadata } from '$lib/server/git';
	import { trpc } from '$lib/trpc/client';
	import { DateTime, Duration, type _ToObjectUnit } from 'luxon';
	import type { UpdateData } from '$lib/trpc/router';
	import { monaco_init, updateCodeLens } from '$lib/client/monacoInit';
	import { faHourglassEmpty } from '@fortawesome/free-regular-svg-icons';
	import type { Model } from '$lib/client/localstorage';

	let {
		path,
		mainModel,
		header = $bindable()
	}: { path: string; mainModel: Model; header: Snippet | undefined } = $props();

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

	let lastMessage: undefined | { path: string } = $state();
	let isWorkingOnCurrentFile = $derived(lastMessage?.path == path);

	let now = $state(DateTime.now());
	setInterval(() => {
		now = DateTime.now();
	}, 500);

	let originalModel: CorrecedModel | undefined = $state();
	let correctionModel: CorrecedModel | undefined = $state();

	let configuredModels: { modelNames: string[]; styles: string[] } = $state({
		modelNames: [],
		styles: []
	});

	function updateModel(
		model: 'original' | 'correction',
		meta: ReturnType<Model['getCorrection']>,
		path: string
	) {
		if (Monaco == undefined) {
			throw new Error('Monaco not initialized');
		}
		meta = JSON.parse(JSON.stringify(meta));
		let currentModel = model == 'original' ? originalModel : correctionModel;

		if (currentModel == undefined || currentModel.metadata.path != path) {
			const oldModel = currentModel;
			const text = meta.paragraphInfo
				.map((x) => {
					if (model == 'original' || x.selectedText == 'original') {
						x.selectedText = 'original';
						return [x.original, 'original'] as const;
					} else if (x.selectedText == undefined) {
						if (x.corrected) {
							x.selectedText = 'corrected';
							return [x.corrected.text, 'corrected'] as const;
						}
						const judgment = Object.keys(x.judgment).toSorted()[0];
						if (judgment) {
							x.selectedText = [judgment, 'correction'];
							return [x.judgment[judgment].text.correction, 'correction'] as const;
						} else {
							x.selectedText = 'original';
							return [x.original, 'original'] as const;
						}
					} else if (x.selectedText == 'corrected') {
						if (x.corrected) {
							return [x.corrected.text, 'corrected'] as const;
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
				})
				.map(([text, type]) => {
					if (text.endsWith('\n')) {
						return [text, type] as const;
					} else {
						return [text + '\n', type] as const;
					}
				});

			const joindText = text.map(([x]) => x).join('\n');
			currentModel = Monaco.editor.createModel(joindText, 'markdown') as CorrecedModel;

			currentModel.metadata = JSON.parse(JSON.stringify(meta));

			const cc = currentModel;

			const offsetAndIndexToLineAndColomn = (offset: number, index: number) => {
				const key = cc.getDecorationKeyOfIndex(index);
				if (key == undefined) {
					throw new Error('Failed to get key');
				}
				const range = cc.getDecorationRange(key);
				if (range == undefined) {
					throw new Error('Failed to get range');
				}
				const textInRange = cc.getValueInRange(range);
				const linesInRangeToOffset = textInRange.substring(0, offset).split('\n').length - 1;
				const column = offset - textInRange.substring(0, offset).lastIndexOf('\n');
				return {
					lineNumber: range.startLineNumber + linesInRangeToOffset,
					column: column
				};
			};

			function validateMarkdown(model: monaco.editor.ITextModel) {
				if (!isCorrectedModel(model)) {
					console.log('not corrected model');
					return;
				}

				const indexes = Array.from({ length: model.metadata.paragraphInfo.length }).map(
					(_, i) => i
				);

				const markers = indexes.flatMap((dataIndex) => {
					const currentKind = model.getCurrentKind(dataIndex);
					if (currentKind != 'corrected') {
						return [];
					}
					const paragraphInfo = model.metadata.paragraphInfo[dataIndex];
					if (paragraphInfo.corrected == undefined) {
						return [];
					}

					const actions = paragraphInfo.corrected.corrections.map((entry) => {
						const { lineNumber: startLineNumber, column: startColumn } =
							offsetAndIndexToLineAndColomn(entry.offset, dataIndex);
						const { lineNumber: endLineNumber, column: endColumn } = offsetAndIndexToLineAndColomn(
							entry.offset + entry.length,
							dataIndex
						);
						return {
							startColumn,
							startLineNumber,
							endColumn,
							endLineNumber,
							message: entry.message,
							severity:
								entry.alternativeReplacement.length > 0
									? Monaco!.MarkerSeverity.Error
									: entry.replacedWith
										? Monaco!.MarkerSeverity.Warning
										: Monaco!.MarkerSeverity.Info
						} satisfies monaco.editor.IMarkerData;
					});
					return actions;
				});

				// Apply markers to the editor
				Monaco!.editor.setModelMarkers(model, 'markdown', markers);
			}

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

			currentModel.changeDiagnostic = function (operation, diagnostic) {
				const range = new Monaco!.Range(
					diagnostic.lineStart,
					diagnostic.columnStart,
					diagnostic.lineEnd,
					diagnostic.columnEnd
				);
				const indexes = this.getDecorationsInRange(range)
					.map((x) => x.id)
					.map(this.getIndexOfDecorationKey)
					.filter((x) => x != undefined) as number[];
				if (indexes.length == 0) {
					console.log('no indexes found', diagnostic, range, this.getDecorationsInRange(range));
					return;
				} else if (indexes.length > 1) {
					console.warn('more than one index found');
					return;
				}
				const index = indexes[0];
				if (this.getCurrentKind(index) != 'corrected') {
					throw new Error('Not a corrected model');
				}
				const paragraphInfo = this.metadata.paragraphInfo[index];
				if (paragraphInfo.corrected == undefined) {
					throw new Error('No correction data found');
				}
				const corrected = paragraphInfo.corrected;

				// get original correction
				const possibleOriginal = corrected.corrections.filter(
					(x) =>
						x.offset == diagnostic.offset &&
						x.length == diagnostic.length &&
						x.message == diagnostic.message &&
						x.rule?.category == diagnostic.rule?.category &&
						x.rule?.id == diagnostic.rule?.id
				);
				if (possibleOriginal.length == 0) {
					throw new Error('No original correction found');
				}
				if (possibleOriginal.length > 1) {
					throw new Error('More then one possible match :(');
				}
				const [original] = possibleOriginal;

				// replace the text in corrected
				const newText =
					operation == 'original'
						? diagnostic.original
						: operation == 'original with dictionary'
							? diagnostic.original
							: operation.replace;
				if (newText == undefined) {
					throw new Error('No new text found');
				}

				function replaceText(
					corrected: Exclude<MetadataType['paragraphInfo'][number]['corrected'], undefined>,
					diagnostic: Exclude<
						MetadataType['paragraphInfo'][number]['corrected'],
						undefined
					>['corrections'][number],
					newText: string
				) {
					const currentText = corrected.text.substring(
						diagnostic.offset,
						diagnostic.offset + diagnostic.length
					);
					const textBefore = corrected.text.substring(0, diagnostic.offset);
					const textAfter = corrected.text.substring(diagnostic.offset + diagnostic.length);

					const lengthDelta = newText.length - currentText.length;

					if (diagnostic.replacedWith != undefined && diagnostic.replacedWith != newText) {
						// we change the used text so we need to add it back to alternatives
						diagnostic.alternativeReplacement.push(diagnostic.replacedWith);
					}
					if (diagnostic.alternativeReplacement.includes(newText)) {
						// we do not want to have the current text in the alternatives
						diagnostic.alternativeReplacement = diagnostic.alternativeReplacement.filter(
							(x) => x != newText
						);
					}
					if (diagnostic.original == newText) {
						diagnostic.replacedWith = undefined;
					} else {
						diagnostic.replacedWith = newText;
					}

					// update the diagnostic in this index
					if (lengthDelta != 0) {
						for (let i = 0; i < corrected.corrections.length; i++) {
							const element = corrected.corrections[i];
							// this should alse change the original correction
							//we should also do not have overlaping warnings, so this should be it
							if (element.offset > diagnostic.offset) {
								element.offset += lengthDelta;
							}
						}
					}

					diagnostic.length = newText.length;
					corrected.text = `${textBefore}${newText}${textAfter}`;
				}
				replaceText(corrected, original, newText);

				if (operation == 'original with dictionary') {
					// we will first add the text to the dictionary,
					mainModel.addWordToDictionary(original.original!);

					// we do not wait, since the dictionray should be used when the response from
					// languagetool is processed, not here
					// we just remove the original and every other occuance of the text from diagnostics
					for (let i = this.metadata.paragraphInfo.length - 1; i >= 0; i--) {
						const element = this.metadata.paragraphInfo[i];
						if (!element.corrected) {
							continue;
						}
						for (let j = element.corrected.corrections.length - 1; j >= 0; j--) {
							const diagnosticToCheck = element.corrected.corrections[j];
							if (diagnosticToCheck.original == original.original) {
								replaceText(element.corrected, diagnosticToCheck, original.original);

								// remove the current diagnostic
								element.corrected.corrections.splice(j, 1);
							}
						}
						this.setKind(i, 'corrected');
					}
				}

				// this will refresh the view and gets the new text
				this.setKind(index, 'corrected');

				// this.pushEditOperations(
				// 	[],
				// 	[
				// 		{
				// 			range,
				// 			text: newText
				// 		}
				// 	],
				// 	() => null
				// );
			};
			currentModel.changeDiagnostic.bind(currentModel);

			currentModel.getDiagnostic = function (range) {
				const indexes = this.getDecorationsInRange(range)
					.map((x) => x.id)
					.map(this.getIndexOfDecorationKey)
					.filter((x) => x != undefined) as number[];
				return indexes.flatMap((index) => {
					const paragraphInfo = this.metadata.paragraphInfo[index];
					if (this.getCurrentKind(index) != 'corrected') {
						return [];
					}
					if (paragraphInfo.corrected == undefined) {
						throw new Error('No correction data found');
					}
					const { corrections } = paragraphInfo.corrected;
					const result = corrections
						.map((c) => {
							const { lineNumber: lineStart, column: columnStart } = offsetAndIndexToLineAndColomn(
								c.offset,
								index
							);
							const { lineNumber: lineEnd, column: columnEnd } = offsetAndIndexToLineAndColomn(
								c.offset + c.length,
								index
							);
							return {
								...c,
								lineStart,
								lineEnd,
								columnStart,
								columnEnd
							};
						})
						// filter if range is not overlapping
						.filter(
							(x) =>
								range.startLineNumber <= x.lineStart &&
								x.lineEnd <= range.endLineNumber &&
								(range.startLineNumber != x.lineStart || range.startColumn <= x.columnStart) &&
								(range.endLineNumber != x.lineEnd || range.endColumn >= x.columnEnd)
						);
					return result;
				});
			};
			currentModel.getDiagnostic.bind(currentModel);

			currentModel.getDecorationKeyOfIndex = function (index) {
				return indexLookUp[index];
			};
			currentModel.getDecorationKeyOfIndex.bind(currentModel);

			currentModel.getCurrentKind = function (index) {
				const change = indexLookUp[index];
				if (change == undefined) {
					throw new Error(`No Changes for ${index}`);
				}

				const selected = this.metadata.paragraphInfo[index].selectedText;
				if (selected) {
					return selected;
				}
				if (this.metadata.paragraphInfo[index].corrected) {
					return 'corrected';
				}
				return 'original';
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
					const textInRange = this.getValueInRange(decoration.range);

					const text = textInRange.trimEnd() + '\n';

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
					mainModel.localUpdate(path, this.metadata);
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
				} else if (kind == 'corrected') {
					return info.corrected != undefined;
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
								: kind == 'corrected'
									? info.corrected?.text!
									: kind[1] == 'correction'
										? info.judgment[kind[0]].text.correction
										: kind[1] == 'alternative'
											? info.judgment[kind[0]].text.alternative[kind[2]]
											: undefined;
					if (newTextUnformated == undefined) {
						throw new Error(`Cant find text for ${kind}`);
					}
					// HACK Text should already be formated, but there seems to be some (prebugfix) that are not.
					let newText =
						typeof kind == 'object' ? formatMarkdown(newTextUnformated) : newTextUnformated;
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

			currentModel.onDidChangeContent((e) => {
				e.changes.forEach((change) => {
					cc.handleTextEdits(change);
				});
			});

			validateMarkdown(currentModel);
			currentModel.onDidChangeContent(() => validateMarkdown(cc));

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
				oldParagrapInfo.judgment = newParagrapInfo.judgment;
				oldParagrapInfo.corrected = newParagrapInfo.corrected;
				// the text should not be edited (this is only possible if everything is already set)

				if (
					(oldParagrapInfo.selectedText == undefined ||
						oldParagrapInfo.selectedText == 'original') &&
					oldParagrapInfo.corrected == undefined &&
					newParagrapInfo.corrected != undefined &&
					model == 'correction'
				) {
					currentModel.setKind(i, newParagrapInfo.selectedText ?? 'corrected');
				}
			}
		}
		currentModel.configuredModels = configuredModels;
		updateCodeLens();
	}

	function updateText(selectedPath: string) {
		if (!Monaco) return;
		const meta = mainModel.getCorrection(selectedPath);

		updateModel('original', meta, selectedPath);
		updateModel('correction', meta, selectedPath);
		metadata = JSON.parse(JSON.stringify(meta));
		updateCodeLens();

		console.log('selectedPath', selectedPath);
	}

	onMount(() => {
		header = headerSnipet;
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

		mainModel.onChange('models', (models) => {
			configuredModels = models;
		});
		configuredModels = mainModel.configuredModels;

		mainModel.onChange('content', (content) => {
			if (content.path == path) {
				updateText(path);
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
					.map((x) => [x.id, x.range] as const)
					.map(([key, range]) => {
						if (!correctionModel) {
							throw new Error('No correction model found');
						}
						const index = correctionModel.getIndexOfDecorationKey(key);
						if (index == undefined) {
							return true;
						}

						// readonly if selection is outside of range
						// also not the last line, since that is our seperator
						if (
							e.selection.startLineNumber < range.startLineNumber ||
							e.selection.endLineNumber >= range.endLineNumber
						) {
							return true;
						}

						const shouldBeReadonly =
							correctionModel.hasKind(index, 'edited') &&
							correctionModel.getCurrentKind(index) != 'edited';
						return shouldBeReadonly;
					})
					.every((x) => x);
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

		const commitDetails = {
			author: {
				email: dialog_email,
				name: dialog_name
			},
			message: dialog_message
		};

		console.log('store', text);
		if (openDialog == 'commit') {
			await mainModel.saveCorrection('commit', path, text, commitDetails);
		} else if (openDialog == 'draft') {
			await mainModel.saveCorrection('draft', path, meta, commitDetails);
		}
		openDialog = undefined;
	}
</script>

{#snippet headerSnipet()}
	<header>
		{#if !metadata}
			<span aria-busy="true">Loading…</span>
			<div style="display: none;">
				{path}
				{isWorkingOnCurrentFile}
				{metadata == undefined}
			</div>
		{:else if !isWorkingOnCurrentFile}
			<span data-tooltip="Benötigte Zeit" data-placement="bottom">
				{#if metadata.time_in_ms == 0}
					Nicht gestartet
				{:else}
					{reduceDuration(
						{
							milliseconds: metadata.time_in_ms,
							seconds: 0,
							minutes: 0,
							hours: 0
						},
						{ skip: ['milliseconds'] }
					).toFormat('hh:mm:ss')}
				{/if}</span
			>
		{:else}
			<span aria-busy="true"></span>
		{/if}

		<button
			data-tooltip="Draft Speichern"
			data-placement="bottom"
			class="secondary"
			onclick={() => {
				openDialog = 'draft';
				mainModel.commitDetails.then((data) => {
					dialog_name = data.author.name;
					dialog_email = data.author.email;
					dialog_message = data.message;
				});
			}}
		>
			<FontAwesomeIcon size="2xl" icon={faFloppyDisk} />
		</button>
		<button
			class="secondary"
			data-tooltip="Korrekturen anwenden"
			data-placement="bottom"
			onclick={() => {
				openDialog = 'commit';
				mainModel.commitDetails.then((data) => {
					dialog_name = data.author.name;
					dialog_email = data.author.email;
					dialog_message = data.message;
				});
			}}
		>
			<FontAwesomeIcon size="2xl" icon={faUpload} />
		</button>

		<!-- <div>
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
	</div> -->
	</header>
{/snippet}

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

<div bind:this={divEl} class="h-screen"></div>

<style>
	header {
		display: flex;
		justify-content: flex-end;
		margin-right: 1em;
		align-items: center;
	}
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
		height: 100cqh;
	}
</style>
