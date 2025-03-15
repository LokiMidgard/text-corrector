<script lang="ts">
	import Hamburger from '$lib/client/hamburger.svelte';
	import Tree, { type TreeElement } from '$lib/client/tree.svelte';
	import { trpc } from '$lib/trpc/client';
	import { onMount, type Snippet } from 'svelte';
	import Diff, { type MetadataType } from './diff.svelte';
	import Textview from './textview.svelte';
	import Pin from '$lib/client/pin.svelte';
	import { DateTime, Duration } from 'luxon';
	import type { UpdateData } from '$lib/trpc/router';
	import '$lib/default.scss';
	import { reduceDuration } from '$lib';
	import { Model } from '$lib/client/localstorage';

	let open = $state(true);

	let both = $state(true);

	let model: Model | undefined = $state();

	$effect(() => {
		if (open && both) {
			document.body.classList.add('both');
		} else {
			document.body.classList.remove('both');
		}
	});

	type UnwrapPromise<T> = T extends PromiseLike<infer K> ? K : T;
	type fileListType = Model['pathes'];

	let selectedPath: undefined | string = $state();

	let childHeader: undefined | Snippet = $state();

	let fileList: fileListType = $state([]);
	let { root: tree, lookup } = $derived(convertPathsToTree(fileList));

	let configuredModels: { modelNames: string[]; styles: string[] } = $state({
		modelNames: [],
		styles: []
	});

	let connectedToBackend = $state(false);
	let currentState: undefined | ReturnType<Model['getCorrection']> = $state();

	let totelModelWork = $derived(getFileTotalProgress(currentState));
	let calculatedModelWork = $derived(getFileProgress(currentState));
	let stiles = $derived(new Set(configuredModels.styles));
	let modelNames = $derived(new Set(configuredModels.modelNames));

	function getFileTotalProgress(currentState?: MetadataType) {
		return (
			(currentState?.paragraphInfo.length ?? 0) *
			(configuredModels.modelNames.length * (configuredModels.styles.length + 1) + 1)
		);
	}
	function getFileProgress(currentState?: MetadataType) {
		currentState?.paragraphInfo
			.map(
				(x) =>
					Object.entries(x.judgment)
						.filter(([key]) => modelNames.has(key))
						.map(
							([, x]) =>
								// stiele
								Object.entries(x.text.alternative)?.filter(([key]) => stiles.has(key)).length +
								// model corrections
								(x.text.correction == undefined ? 0 : 1)
						)
						.reduce((p, c) => p + c, 0) + (x.corrected == undefined ? 0 : 1)
				//
			)
			.reduce((p, c) => p + c, 0);
	}

	let now = $state(DateTime.now());
	setInterval(() => {
		now = DateTime.now();
	}, 500);

	onMount(async () => {
		model = await Model.getInstance();

		model.onChange('pathes', (newPathes) => {
			fileList = [...newPathes];
		});
		const pathes = model.pathes;
		fileList = [...pathes];

		model.onChange('models', (newModels) => {
			configuredModels = newModels;
		});
		configuredModels = model.configuredModels;

		model.onChange('connected', (connected) => {
			connectedToBackend = connected;
		});
		connectedToBackend = model.connected;
		model.onChange('currentPath', (state) => {
			currentState = model?.getCorrection(state);
		});

		model.onChange('content', (state) => {
			console.log(`File ${state.path} changed with ${getFileProgress(state)}/${getFileTotalProgress(state)}`);
			currentState = state;
		});

		if (model.currentPath) {
			currentState = model.getCorrection(model.currentPath);
		}
	});

	function convertPathsToTree(filePaths: fileListType) {
		const root: TreeElement = {
			children: [],
			id: '',
			label: 'root'
		};
		const lookup: Record<string, TreeElement> = { '': root };

		for (const path of filePaths) {
			let parent: undefined | string = undefined;
			let current: undefined | string = undefined;
			let currentIndex = path.indexOf('/');
			do {
				parent = current ?? '';
				current = path.substring(0, currentIndex);
				if (!lookup[current]) {
					const newTreeElement: TreeElement = {
						children: [],
						id: current,
						label: current.substring(current.lastIndexOf('/') + 1)
					};
					lookup[current] = newTreeElement;
					lookup[parent!].children.push(newTreeElement);
				}
				currentIndex = path.indexOf('/', currentIndex + 1);
			} while (currentIndex > 0);

			parent = current ?? '';
			current = path;
			if (!lookup[current]) {
				const newTreeElement: TreeElement = {
					children: [],
					id: current,
					label: current.substring(current.lastIndexOf('/') + 1)
				};
				lookup[current] = newTreeElement;
				lookup[parent!].children.push(newTreeElement);
			}
		}
		return { root, lookup };
	}

	let assideDrag = $state(false);

	function onMouseMove(e: MouseEvent) {
		if (assideDrag) {
			const width = e.clientX;
			document.documentElement.style.setProperty('--aside-width', `${width}px`);

			e.preventDefault();
		}
	}

	function onStopDrag() {
		assideDrag = false;
	}
</script>

<svelte:body onmousemove={(e) => onMouseMove(e)} onmouseup={() => onStopDrag()} />

<label class="hamburger" class:open class:assideDrag>
	<input type="checkbox" bind:checked={open} />
	<Hamburger bind:active={open} />
</label>
<aside>
	<div class="top">
		<label>
			<input type="checkbox" bind:checked={both} />

			<Pin bind:isPinned={both} />
		</label>
	</div>
	<div class="center">
		{#if tree}
			<Tree bind:selectedElement={selectedPath} {tree} />
		{/if}
	</div>
</aside>

<header class:open>
	<label class="globalHeader">
		{#if currentState}
			<progress value={calculatedModelWork} max={totelModelWork} />
			<small>
				{currentState.path}
				{calculatedModelWork}/{totelModelWork}
				<span style="float: right;">
					{#if !connectedToBackend}
						runtime {Duration.fromDurationLike({
							milliseconds: currentState.time_in_ms,
							seconds: 0,
							minutes: 0,
							hours: 0
						})
							.normalize()
							.toFormat('hh:mm:ss')} waiting for backend to come back.
					{:else if calculatedModelWork == totelModelWork}
						runtime {reduceDuration(
							{
								milliseconds: currentState.time_in_ms,
								seconds: 0,
								minutes: 0,
								hours: 0
							},
							{ skip: ['milliseconds'] }
						).toFormat('hh:mm:ss')}
					{:else}
						runtime {reduceDuration(
							now.diff(DateTime.fromObject(currentState.timestamp)).plus({
								milliseconds: currentState.time_in_ms,
								seconds: 0,
								minutes: 0,
								hours: 0
							}),
							{ skip: ['milliseconds'] }
						).toFormat('hh:mm:ss')}
					{/if}
				</span>
			</small>
		{/if}
	</label>
	<div class="between"><div></div></div>
	<div class="childHeader">
		{#if childHeader}
			{@render childHeader()}
		{/if}
	</div>
</header>
<div class="splittr" class:open onmousedown={() => (assideDrag = true)} />

<main>
	{#if selectedPath && model}
		<Diff path={selectedPath} mainModel={model} bind:header={childHeader} />
	{/if}
</main>

<style lang="scss">
	:global(body) {
		margin: 0;
		padding: 0;
		height: 100vh;
		overflow: hidden;
		width: 100vw;
	}
	:root {
		--aside-width: 15rem;
		--menu-background: var(--pico-primary);
		--header-height: 3rem;
		--splitter-width: 0.5rem;
	}

	header {
		z-index: 100;
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: var(--header-height);
		background-color: var(--pico-primary);
		display: grid;
		justify-content: stretch;
		align-content: stretch;
		align-items: stretch;
		justify-items: stretch;

		// gap: 1em;
		grid-template-columns: calc(var(--header-height) + 1em) 1fr calc(var(--header-height) / 2) 1fr;
		grid-template-areas: 'asside globalHeader between childHeader';

		&.open {
			grid-template-columns: calc(var(--header-height) + 1em) 1fr calc(var(--header-height) / 2) 1fr;
		}

		.globalHeader {
			grid-area: globalHeader;
			width: 100%;
			display: flex;
			flex-direction: column;
			justify-content: stretch;
			height: var(--header-height);
			align-items: stretch;

			> small {
				flex-grow: 1;
			}
			progress {
				width: 100%;
				margin: 0;
				border-top-right-radius: 0;
				border-top-left-radius: 0;
				background-color: var(--pico-primary-hover) !important;
			}
		}
		.between {
			grid-area: between;
			background-color: var(--pico-secondary);
			width: calc(var(--header-height) / 2);
			height: var(--header-height);
			> * {
				width: calc(var(--header-height) / 2);
				height: var(--header-height);
				border-bottom-right-radius: calc(var(--header-height) / 2);
				background-color: var(--pico-primary);
			}
		}
		.childHeader {
			height: var(--header-height);
			grid-area: childHeader;
			height: var(--header-height);
			display: flex;
			background-color: var(--pico-secondary);
			justify-content: end;
			align-items: center;
		}
	}

	.splittr.open {
		position: fixed;
		top: 0;
		left: var(--aside-width);
		width: var(--splitter-width);
		height: 100vh;
		background-color: black;
		cursor: ew-resize;
		z-index: 1000;
	}

	label > input[type='checkbox'] {
		display: none;
	}
	label.hamburger {
		--color: var(--pico-secondary-inverse);

		&:hover {
			// --color: var(--pico-primary-inverse);
			background-color: var(--pico-secondary-hover);
		}

		cursor: pointer;
		position: fixed;
		z-index: 900;
		background-color: var(--pico-secondary);
		top: 0;
		right: calc(100vw - 3rem);
		width: 3rem;
		height: 3rem;
		display: flex;
		justify-content: center;
		align-items: center;
		border-bottom-right-radius: 50%;
		transition: all 1s;
		&.assideDrag {
			transition: none;
		}
		&.open {
			right: calc(100vw - var(--aside-width));
			border-bottom-right-radius: 0;
			background-color: var(--pico-primary);
			--color: var(--pico-primary-inverse);
			&:hover {
				background-color: var(--pico-primary-hover);
			}
		}
	}
	aside {
		z-index: 200;
		position: fixed;
		top: 0;
		bottom: 0;
		left: 0;
		width: var(--aside-width);
		transform: translateX(calc(-1 * var(--aside-width)));
		transition: 1s transform;
		background-color: var(--pico-card-background-color);
		.top {
			height: 3rem;
			width: calc(var(--aside-width) - 3rem);
			background-color: var(--pico-secondary);
		}
		.center {
			overflow-y: auto;
			overflow-x: auto;
			height: calc(100vh - 3rem);
		}
	}
	.hamburger:has(input:checked) + aside {
		transform: translateX(0);
	}
	main {
		z-index: 5;
		top: var(--header-height);
		left: 0;
		right: 0;
		bottom: 0;
		// height: calc(100vh - var(--header-height));
		position: fixed;
		container-name: mainframe;
		container-type: size;
	}

	:global(.both) {
		main {
			left: calc(var(--aside-width) + var(--splitter-width));
		}
		header.open {
			grid-template-columns:
				calc(var(--splitter-width) + var(--aside-width) + 1em) 1fr calc(var(--header-height) / 2)
				1fr;
		}
	}
</style>
