// hooks.server.ts
import { createContext } from '$lib/trpc/context';
import { router } from '$lib/trpc/router';
import { checkRepo } from '$lib/server/wol';
import type { Handle } from '@sveltejs/kit';
import { createTRPCHandle } from 'trpc-sveltekit';
import { building } from '$app/environment';
import { createTRPCWebSocketServer } from 'trpc-sveltekit/websocket';




if (!building) createTRPCWebSocketServer({ router, createContext });


console.log('Initializing server'); 
checkRepo().catch(console.error);

