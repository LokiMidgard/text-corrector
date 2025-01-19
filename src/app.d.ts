// See https://svelte.dev/docs/kit/types#app.d.ts

import type { Env } from "$lib/server/wol";

// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
	namespace NodeJS {
		// eslint-disable-next-line @typescript-eslint/no-empty-object-type
		interface ProcessEnv extends Env {
		}
	}
}

export { };
