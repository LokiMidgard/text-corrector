<script lang="ts" module>
	export type TreeElement = {
		label: string;
		hasCorrection?: boolean;
		id: string;
		children: TreeElement[];
	};
</script>

<script lang="ts">
	let {
		tree,
		selectedElement = $bindable()
	}: { tree: TreeElement; selectedElement: undefined | string } = $props();

	// let selectedElement: undefined | string = $state('prolog');
</script>

{#if tree}
	<ul>
		{@render element(tree)}
	</ul>
{/if}
{#snippet element(ele: TreeElement, indentation = 0)}
	<li style="--indentation:{indentation}">
		{#if ele.children.length > 0}
			<details open>
				<summary>
					{ele.label}
				</summary>
				<ul>
					{#each ele.children as child}
						{@render element(child, indentation + 1)}
					{/each}
				</ul>
			</details>
		{:else}
			<label title={ele.label}>
				<span class:hasCorrection={ele.hasCorrection}>
					{ele.label}
				</span>
				<input type="radio" name="selectedElement" bind:group={selectedElement} value={ele.id} />
				<!-- {#if ele.hasCorrection}
					<span>🔴</span>
				{/if} -->
			</label>
		{/if}
	</li>
{/snippet}

<style lang="scss">
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		background-color: var(--pico-dropdown-background-color);
		color: var(--pico-dropdown-color) !important;
	}
	summary,
	label {
		/* width: 100%; */
		margin: 0;
		padding: 0;
		display: block;
		padding-left: calc(var(--indentation) * 1rem);
		/* prevent line break and keep everything in ne line */
		white-space: nowrap;
	}
	details:has(> summary:hover),
	details:has(> summary:hover) ul:not(label:has(:checked)),
	label:hover {
		background-color: var(--pico-dropdown-hover-background-color);
	}
	li {
		display: grid;
		justify-items: stretch;
		align-items: stretch;
		justify-content: stretch;
		align-content: stretch;
	}
	label {
		display: flex !important;
		align-items: center !important;
		width: unset !important;
		height: 100%;
		margin-bottom: 0 !important;
		&:has(:checked) {
			background-color: var(--pico-primary);
			color: var(--pico-primary-inverse);
			&:hover {
				background-color: var(--pico-primary-hover);
			}
		}
	}
	input {
		display: none;
	}
	.hasCorrection {
		position: relative;
		display: flex;
		align-content: center;
		&::before {
			align-self: center;
			opacity: 0.5;
			content: ' ';
			background-color: red;
			width: 0.6rem;
			height: 0.6rem;
			position: absolute;
			left: -0.8rem;
			border-radius: 0.3rem;
		}
		&:hover::before {
			opacity: 1;
		}
	}
</style>
