<script lang="ts">
	import Hamburger from '$lib/client/hamburger.svelte';
	import Tree, { type TreeElement } from '$lib/client/tree.svelte';
	import { trpc } from '$lib/trpc/client';
	import { onMount } from 'svelte';
	import Diff from './diff.svelte';
	import Textview from './textview.svelte';
	import Pin from '$lib/client/pin.svelte';
	import { DateTime, Duration } from 'luxon';
	import type { UpdateData } from '$lib/trpc/router';
	import '$lib/default.scss';

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

	const client = trpc();
	let fileList: fileListType = $state([]);
	let { root: tree, lookup } = $derived(convertPathsToTree(fileList));

	let connectedToBackend = $state(false);
	let currentState: undefined | (UpdateData & { timestamp: DateTime }) = $state();

	let now = $state(DateTime.now());
	setInterval(() => {
		now = DateTime.now();
	}, 500);

	onMount(() => {
		client.listFiles.query().then((files) => {
			fileList = files;
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

				if (lookup[message.path] && !lookup[message.path].hasCorrection) {
					lookup[message.path].hasCorrection = true;
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

<header>
	<div>
		{#if currentState}
			<div>Working on {currentState.path}</div>
			<div>
				Progress {currentState.paragraphInfo.reduce(
					(p, c) => p + Object.keys(c.judgment).length,
					0
				)}/{currentState.paragraphInfo.length}
			</div>
			{#if !connectedToBackend}
				<div>
					runtime {Duration.fromDurationLike({
						milliseconds: currentState.time_in_ms,
						seconds: 0,
						minutes: 0,
						hours: 0
					})
						.normalize()
						.toHuman()} waiting for backend to come back.
				</div>
			{:else if currentState.paragraphInfo.filter((x) => x.judgment).length == currentState.paragraphInfo.length}
				<div>
					runtime {Duration.fromDurationLike({
						milliseconds: currentState.time_in_ms,
						seconds: 0,
						minutes: 0,
						hours: 0
					})
						.normalize()
						.toHuman()}
				</div>
			{:else}
				<div>
					runtime {now
						.diff(currentState.timestamp)
						.plus({ milliseconds: currentState.time_in_ms, seconds: 0, minutes: 0, hours: 0 })
						.normalize()
						.toHuman({
							useGrouping: true,
							listStyle: 'short',
							notation: 'compact',
							compactDisplay: 'short'
						})}
				</div>
			{/if}
		{/if}
	</div>
</header>
<div class="splittr" class:open onmousedown={() => (assideDrag = true)} />

<main>
	{#if selectedPath}
		{#if lookup[selectedPath].hasCorrection}
			<Diff path={selectedPath} {client} />
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
		display: flex;
		justify-content: center;
		align-items: center;
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
	}
</style>
