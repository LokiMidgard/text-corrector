<script lang="ts" module>
	export type MetadataType = UpdateData & { timestamp: DateTime };
</script>

<script lang="ts">
	import type monaco from 'monaco-editor';
	import { onMount } from 'svelte';
	import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
	import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
	import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
	import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
	import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

	import { renderMarkdown } from '$lib';
	import { page } from '$app/stores';
	import type { CorrectionMetadata, Review } from '$lib/server/git';
	import { trpc } from '$lib/trpc/client';
	import { DateTime, Duration } from 'luxon';
	import type { UpdateData } from '$lib/trpc/router';
	import { set } from 'zod';
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
	let correctionModel: monaco.editor.ITextModel | undefined = $state();
	function updateText(selectedPath: string) {
		client.getCorrection.query(selectedPath).then(({ correction, original, metadata: meta }) => {
			if (!originalModel || !correctionModel || !Monaco) return;
			originalModel.setValue(original);
			correctionModel.setValue(correction);

			editor
				.getModifiedEditor()
				.updateOptions({ readOnly: meta.paragraph.value != meta.paragraph.of });
			metadata = meta;
			(correctionModel as any).metadata = metadata;
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

			// if (commandId) {
			// 	const code_lens = Monaco.languages.registerCodeLensProvider(lang, {
			// 		provideCodeLenses: function (model, token) {
			// 			console.log('provideCodeLenses', model, token);
			// 			return {
			// 				lenses: [
			// 					{
			// 						range: {
			// 							startLineNumber: 3,
			// 							startColumn: 1,
			// 							endLineNumber: 4,
			// 							endColumn: 1
			// 						},
			// 						id: 'First Line',
			// 						command: {
			// 							id: commandId,
			// 							title: 'First Line',
			// 							arguments: []
			// 						}
			// 					}
			// 				],
			// 				dispose: () => {}
			// 			};
			// 		},
			// 		resolveCodeLens: function (model, codeLens, token) {
			// 			return codeLens;
			// 		}
			// 	});
			// 	console.log('code_lens', code_lens);
			// }
			originalModel = Monaco.editor.createModel('', lang);
			// make readonly
			editor.getOriginalEditor().updateOptions({ readOnly: true });
			correctionModel = Monaco.editor.createModel('', lang);

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
