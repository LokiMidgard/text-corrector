<script lang="ts" module>
	export type TreeElement = {
		label: string;
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
			{#if ele === tree}
				{#each ele.children.sort((a, b) => {
					if (a.children.length > 0 && b.children.length === 0) return -1;
					if (a.children.length === 0 && b.children.length > 0) return 1;
					return a.label.localeCompare(b.label);
				}) as child}
					{@render element(child, indentation + 1)}
				{/each}
			{:else}
				<details open>
					<summary>
						{ele.label}
					</summary>
					<ul>
						{#each ele.children.sort((a, b) => {
							if (a.children.length > 0 && b.children.length === 0) return -1;
							if (a.children.length === 0 && b.children.length > 0) return 1;
							return a.label.localeCompare(b.label);
						}) as child}
							{@render element(child, indentation + 1)}
						{/each}
					</ul>
				</details>
			{/if}
		{:else}
			<label title={ele.label}>
				<span>
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
		margin: 0 !important;
		padding: 0 !important;
		display: flex;
		flex-direction: column;
		background-color: var(--pico-dropdown-background-color);
		color: var(--pico-dropdown-color) !important;
	}
	details {
		margin: 0 !important;
		padding: 0 !important;
	}

	details summary::after {
		float: left !important;
	}

	summary,
	label {
		/* width: 100%; */
		margin: 0 !important;
		padding: 0.2em !important;
		display: block;
		padding-left: calc(var(--indentation) * 1rem) !important;
		/* prevent line break and keep everything in ne line */
		white-space: nowrap;
	}
	details:has(> summary:hover),
	details:has(> summary:hover) ul:not(label:has(:checked)),
	label:hover {
		background-color: var(--pico-dropdown-hover-background-color);
	}
	li {
		margin: 0 !important;
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
