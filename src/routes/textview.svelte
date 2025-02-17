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
	let editor: monaco.editor.IStandaloneCodeEditor | undefined = $state();
	let Monaco: typeof import('monaco-editor') | undefined = $state();

	let metadata: undefined | (UpdateData & { timestamp: DateTime }) = $state();

	let connectedToBackend = $state(false);
	let commandId: string | null= null;

	// let client = $derived(trpc($page));

	// let metadata:
	// 	| {
	// 			paragraph: { value: number; of: number };
	// 			messages: string;
	// 			time_in_ms: number;
	// 	  }
	// 	| undefined = $state();

	let reviewTemplate: HTMLTemplateElement;

	$effect(() => {
		if (path && editor) {
			updateText(path);
		}
	});

	function updateText(selectedPath: string) {
		client.getText.query(selectedPath).then((test) => {
			if (Monaco && editor) {
				editor.setModel(Monaco.editor.createModel(test, 'markdown'));
			}
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
				connectedToBackend = true;
				console.log('connected');
			},
			onStopped() {
				connectedToBackend = false;
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

			editor = Monaco.editor.create(divEl, {
				readOnly: true,
				automaticLayout: true
				// value: ['function x() {', '\tconsole.log("Hello world!");', '}'].join('\n'),
				// language: 'javascript'
				// automaticLayout: true // <<== the important part
			});

			// make readonly
			// const commandId = editor.addCommand(
			// 	0,
			// 	function () {
			// 		// Create a zone over the margin. Uses the trick explained
			// 		// at https://github.com/Microsoft/monaco-editor/issues/373

			// 		// overlay that will be placed over the zone.
			// 		let overlayDom = document.createElement('div');
			// 		overlayDom.id = 'overlayId';
			// 		overlayDom.style.width = '100%';
			// 		overlayDom.style.background = '#ffb275';
			// 		const button = document.createElement('button');
			// 		button.innerHTML = 'Remove';
			// 		overlayDom.appendChild(button);

			// 		// https://microsoft.github.io/monaco-editor/api/interfaces/monaco.editor.ioverlaywidget.html
			// 		let overlayWidget = {
			// 			getId: () => 'overlay.zone.widget',
			// 			getDomNode: () => overlayDom,
			// 			getPosition: () => null
			// 		};
			// 		editor.addOverlayWidget(overlayWidget);

			// 		// Used only to compute the position.
			// 		let zoneNode = document.createElement('div');
			// 		zoneNode.style.background = '#8effc9';
			// 		zoneNode.id = 'zoneId';

			// 		// Can be used to fill the margin
			// 		let marginDomNode = document.createElement('div');
			// 		marginDomNode.style.background = '#ff696e';
			// 		marginDomNode.id = 'zoneMarginId';

			// 		editor.changeViewZones(function (changeAccessor) {
			// 			changeAccessor.addZone({
			// 				afterLineNumber: 1,
			// 				heightInLines: 3,
			// 				domNode: zoneNode,
			// 				marginDomNode: marginDomNode,
			// 				onDomNodeTop: (top) => {
			// 					overlayDom.style.top = top + 'px';
			// 				},
			// 				onComputedHeight: (height) => {
			// 					overlayDom.style.height = height + 'px';
			// 				}
			// 			});
			// 		});
			// 	},
			// 	''
			// );
			// if (commandId)
			// 	Monaco.languages.registerCodeLensProvider('javascript', {
			// 		provideCodeLenses: function (model, token) {
			// 			return {
			// 				lenses: [
			// 					{
			// 						range: {
			// 							startLineNumber: 1,
			// 							startColumn: 1,
			// 							endLineNumber: 2,
			// 							endColumn: 1
			// 						},
			// 						id: 'First Line',
			// 						command: {
			// 							id: commandId,
			// 							title: 'First Line'
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

			
			window.onresize = function () {
				editor.layout();
			};
		});
		return () => {
			editor.dispose();
		};
	});

	async function addReview(line: number, review: Review) {
		const text = await renderMarkdown(review.review);
		const view = reviewTemplate.content.cloneNode(true) as HTMLDivElement;
		const content = document.getElementsByClassName('content')[0];
		content.innerHTML = text;
	}
</script>

<br />
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

<div bind:this={divEl} class="h-screen"></div>

<template bind:this={reviewTemplate}>
	<div class="review">
		<header>
			<button class="close" aria-label="close review">×</button>
			<strong>Review</strong>
		</header>
		<div class="content"></div>
	</div>
</template>

<style>
	:global(body) {
		overflow: hidden;
	}
	.h-screen {
		height: 100vh;
	}
</style>
