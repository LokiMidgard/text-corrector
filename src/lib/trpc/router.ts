// lib/trpc/router.ts
import type { Context } from '$lib/trpc/context';
import { initTRPC } from '@trpc/server';
import { getCorrection, getReviews, getText, listFiles, type CorrectionMetadata } from '../server/git';
import { z } from 'zod';
import { transformFromAst } from '../server/wol';
import { observable } from '@trpc/server/observable';
import EventEmitter from 'events';

export const t = initTRPC.context<Context>().create();

const ee = new EventEmitter();




export type UpdateData = Omit<CorrectionMetadata, 'messages'> & { path: string, messages: string[], paragraph: { of: number } };

let lastUpdate: UpdateData | null = null;

export function fireUpdate(path: string, metadata: CorrectionMetadata) {
    console.log('fireUpdate', path, metadata);
    lastUpdate = {
        path,
        ...metadata,
        paragraph: { ...metadata.paragraph, of: metadata.paragraph.of ?? 0 },
        messages: metadata.messages.map(x => transformFromAst({ children: x, type: 'root' })),
    };
    ee.emit('update', lastUpdate)
}


export const router = t.router({
    greeting: t.procedure.query(async () => {

        return `Hello tRPC v10 @ ${new Date().toLocaleTimeString()}`;
    }),
 

    listFiles: t.procedure.query(async () => {
        console.log('listFiles');
        const files = await listFiles();
        return files;
    }),
    getCorrection: t.procedure.input(z.string()).query(async ({ input }) => {
        const corrections = await getCorrection(input);
        return {
            ...corrections, metadata: {
                ...corrections.metadata,
                messages: corrections.metadata.messages.map(m => {
                    return transformFromAst({
                        children: m,
                        type: 'root'
                    });
                })

            }
        };
    }),
    getText: t.procedure.input(z.string()).query(async ({ input }) => {
        const text = await getText(input);
        return text;
    }),
    onMessage: t.procedure
        // .output(onProgress)
        // .input(z.string())
        .subscription(() => {
            console.log('subscribing to onMessage');
            return observable<UpdateData>((emit) => {
                const callback = (meta: UpdateData) => {
                    console.log('onMessage', meta);
                    emit.next(meta);
                };
                ee.on('update', callback);
                if (lastUpdate) {
                    emit.next(lastUpdate);
                }

                return () => {
                    ee.off('update', callback);
                }
            });
        }),



    // testData: t.procedure.query(async () => {
    //     const path = 'story/03-das-leben-in-der-stadt.md';
    //     if (await hasCorrection(path)) {
    //         const text = await getText(path);
    //         console.log('text', text);
    //         return false;
    //     } else {
    //         const text = await getText(path);
    //         await correctText(path, text);
    //         return true;
    //     }
    // }),

    // testWol: t.procedure.query(async () => {


    //     return await ip;
    // }),

    listRefiews: t.procedure.query(async () => {

        const reviews = await getReviews();
        return reviews;
    }),
});

export type Router = typeof router;