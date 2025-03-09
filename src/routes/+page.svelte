<script lang="ts">
	import Hamburger from '$lib/client/hamburger.svelte';
	import Tree, { type TreeElement } from '$lib/client/tree.svelte';
	import { trpc } from '$lib/trpc/client';
	import { onMount, type Snippet } from 'svelte';
	import Diff from './diff.svelte';
	import Textview from './textview.svelte';
	import Pin from '$lib/client/pin.svelte';
	import { DateTime, Duration } from 'luxon';
	import type { UpdateData } from '$lib/trpc/router';
	import '$lib/default.scss';
	import { reduceDuration } from '$lib';

	let open = $state(true);

	let both = $state(true);

	$effect(() => {
		if (open && both) {
			document.body.classList.add('both');
		} else {
			document.body.classList.remove('both');
		}
	});

	type UnwrapPromise<T> = T extends PromiseLike<infer K> ? K : T;
	type fileListType = UnwrapPromise<ReturnType<typeof client.listFiles.query>>;

	let selectedPath: undefined | string = $state();

	let childHeader: undefined | Snippet = $state();

	const client = trpc();
	let fileList: fileListType = $state([]);
	let { root: tree, lookup } = $derived(convertPathsToTree(fileList));

	let configuredModels: { modelNames: string[]; styles: string[] } = $state({
		modelNames: [],
		styles: []
	});

	let connectedToBackend = $state(false);
	let currentState: undefined | (UpdateData & { timestamp: DateTime }) = $state();

	let totelModelWork = $derived(
		(currentState?.paragraphInfo.length ?? 0) *
			(configuredModels.modelNames.length * configuredModels.styles.length + 1)
	);
	let stiles = $derived(new Set(configuredModels.styles));
	let modelNames = $derived(new Set(configuredModels.modelNames));
	let calculatedModelWork = $derived(
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
			.reduce((p, c) => p + c, 0)
	);

	let now = $state(DateTime.now());
	setInterval(() => {
		now = DateTime.now();
	}, 500);

	onMount(() => {
		client.listFiles.query().then((files) => {
			fileList = files;
		});

		client.onModelChange.subscribe(undefined, {
			onData(message) {
				configuredModels = message;
			}
		});

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
				currentState = { ...message, timestamp: DateTime.now() };
				// set correction for newly started work
				const file = fileList.filter((x) => x.path == message.path)[0];
				if (file && !file.hasCorrection) {
					file.hasCorrection = true;
				}
			}
		});
	});

	function convertPathsToTree(filePaths: fileListType) {
		const root: TreeElement = {
			children: [],
			id: '',
			label: 'root'
		};
		const lookup: Record<string, TreeElement> = { '': root };

		for (const { path, hasCorrection } of filePaths) {
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
					hasCorrection: hasCorrection,
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
			tree {selectedPath}
			<Tree bind:selectedElement={selectedPath} {tree} />
		{/if}
	</div>
</aside>

<header class:open>
	<label class="globalHeader">
		{#if currentState}
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
							now.diff(currentState.timestamp).plus({
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
			<progress value={calculatedModelWork} max={totelModelWork} />
		{/if}
	</label>
	{#if childHeader}
		<div class="childHeader">
			{@render childHeader()}
		</div>
	{/if}
</header>
<div class="splittr" class:open onmousedown={() => (assideDrag = true)} />

<main>
	{#if selectedPath}
		{#if lookup[selectedPath].hasCorrection}
			<Diff path={selectedPath} {client} bind:header={childHeader} />
		{:else}
			<Textview path={selectedPath} {client} />
		{/if}
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
		background-color: var(--menu-background);
		display: grid;
		justify-content: center;
		align-items: center;

		gap: 1em;
		grid-template-columns: var(--header-height) 1fr 1fr;
		grid-template-areas: 'asside globalHeader childHeader';

		&.open {
			grid-template-columns: calc(var(--splitter-width) + var(--aside-width)) 1fr 1fr;
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
				border-bottom-right-radius: 0;
				border-bottom-left-radius: 0;
			}
		}
		.childHeader {
			grid-area: childHeader;
			width: 100%;
			height: var(--header-height);
			display: flex;
			background-color: var(--pico-secondary);
			justify-content: center;
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
		cursor: pointer;
		position: fixed;
		z-index: 900;
		background-color: var(--menu-background);
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
		}
		.center {
			overflow-y: auto;
			overflow-x: hidden;
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
			grid-template-columns: var(--header-height) 1fr 1fr;
		}
	}
</style>
