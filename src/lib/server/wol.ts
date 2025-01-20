
import { Resolver } from 'dns';
import ping from 'ping';
import wol from 'wake_on_lan';
import fs from 'fs';
import { Ollama } from 'ollama';

import remarkStringify from 'remark-stringify';
import remarkParse from 'remark-parse';
import remarkBreakLine from 'remark-break-line';
import { unified } from 'unified';
import remarkWiki from 'remark-wiki-link';
import { Agent } from 'undici'

import { z } from 'zod';

import type { BlockContent, DefinitionContent, Paragraph, Root } from 'mdast';

import * as git from '$lib/server/git'
import { fireUpdate } from '$lib/trpc/router';

const resolver = new Resolver();

const envParser = z.object({
    OLLAMA_HOST: z.string(),
    OLLAMA_PROTOCOL: z.string(),
    OLLAMA_MAC: z.string(),
    OLLAMA_IP: z.string().ip(),
    GITHUB_API_TOKEN: z.string(),
    REPO: z.string(),
    PATH_FILTER: z.string().optional(),
    MODEL: z.string().optional(),
    CONTEXT_WINDOW: z.number().optional(),
});
export type Env = z.infer<typeof envParser>;


const env = envParser.parse(process.env);

// check if all required systems files are present
const requiredFiles = [
    'systems/spelling.system',
    'systems/correction.system',
    'systems/improvement.system'
];

const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));

if (missingFiles.length > 0) {
    throw new Error(`Missing system files: ${missingFiles.join(', ')}`);
}




const host = env.OLLAMA_HOST;
const protocol = env.OLLAMA_PROTOCOL;
const mac = env.OLLAMA_MAC;
const ip = env.OLLAMA_IP;

const githubApiToken = env.GITHUB_API_TOKEN;
const repo = env.REPO;


const pathFilter = env.PATH_FILTER ? new RegExp(env.PATH_FILTER) : /story\/.*\.md/;

const noTimeoutFetch = (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const someInit = init || {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fetch(input, { ...someInit, keepalive: true, dispatcher: new Agent({ headersTimeout: Number.MAX_SAFE_INTEGER }) as any })
}

type ModelPropertys = {
    context_window: number
}

const model_properties = {
    'qwen2.5:32b': {
        context_window: 27192,
    },
    'gemma2:27b': {
        context_window: 27192,
    },
    'gemma2:9b': {
        context_window: 27192,
    },
    'llama3.2:3b': {
        context_window: 27192,
    },
    'llama3.2:1b': {
        context_window: 27192,
    },
    'llama3.1:32b': {
        context_window: 27192,
    },
} as const satisfies Record<string, ModelPropertys>;
// the model to use
const model: keyof typeof model_properties = 'qwen2.5:32b';
// manly for debbugging purpus


const context_window = env.CONTEXT_WINDOW ?? model_properties[model].context_window;




async function wake() {
    //check with ping untill pc is online if not successfull send wol
    let state = await ping.promise.probe(await ip);
    while (!state.alive) {
        wol.wake(mac, {
            address: await ip,
        }, function (error: unknown) {
            if (error) {
                console.error(error);
            } else {
                console.log('wol packet sent');
            }
        });
        state = await ping.promise.probe(await ip);
    }

    // wait untill server is healthy
    console.log('wait for server to be healthy');
    const isHealthy = async () => {
        try {
            console.log(`call http://${host}/api/version`);
            return (await fetch(`http://${host}/api/version`)).ok;
        } catch {
            return false;
        }
    }
    while (!(await isHealthy())) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.log('server is healthy');

}




async function createModels() {
    await wake();
    const ollama = new Ollama({ host: `http://${host}`, fetch: noTimeoutFetch });
    const models = await ollama.list();


    const spellingSystem = fs.readFileSync('systems/spelling.system', 'utf8');
    const correctionSystem = fs.readFileSync('systems/correction.system', 'utf8');
    const improvementSystem = fs.readFileSync('systems/improvement.system', 'utf8');

    if (models.models.every(m => m.name !== 'spelling')) {
        await ollama.create({ model: 'spelling', from: model, system: spellingSystem, parameters: { num_ctx: context_window } });
    } else {
        await ollama.delete({ model: 'spelling' });
        await ollama.create({ model: 'spelling', from: model, system: spellingSystem, parameters: { num_ctx: context_window } });
    }

    if (models.models.every(m => m.name !== 'correction')) {
        await ollama.create({ model: 'correction', from: model, system: correctionSystem, parameters: { num_ctx: context_window } });
    } else {
        await ollama.delete({ model: 'correction' });
        await ollama.create({ model: 'correction', from: model, system: correctionSystem, parameters: { num_ctx: context_window } });
    }


    if (models.models.every(m => m.name !== 'improvement')) {
        await ollama.create({ model: 'improvement', from: model, system: improvementSystem, parameters: { num_ctx: context_window } });
    } else {
        await ollama.delete({ model: 'improvement' });
        await ollama.create({ model: 'improvement', from: model, system: improvementSystem, parameters: { num_ctx: context_window } });
    }



}

let running = false;



export async function checkRepo(): Promise<never> {
    if (running) {
        throw new Error('Already running');
    }
    running = true;
    while (true) {
        try {

            await git.updateRepo(githubApiToken, repo);
            let workDone = false;
            const files = await git.listFiles();
            for (const file of files) {
                if (pathFilter.test(file.path)) {
                    console.log(`check ${file.path}`);
                    workDone = await correct(file.path) || workDone;
                }
            }
            if (!workDone) {
                console.log('Nothing to do, shutting down remote');
                fetch(`${protocol}://${host}/shutdown`, { method: 'POST' });
            }

            // delay for 30 seconds
            await new Promise((resolve) => setTimeout(resolve, 1000 * 30));
        } catch (error) {
            console.error('Error on background thread wait 1 min', error);
            await new Promise((resolve) => setTimeout(resolve, 1000 * 30 * 2));

        }

    }

};

async function correct(path: string) {


    const { original, correction, metadata } = (await git.tryGetCorrection(path)) ?? {
        metadata: { paragraph: { value: 0, of: undefined }, time_in_ms: 0, messages: [] },
        correction: await git.getText(path),
        original: await git.getText(path)
    };
    if (metadata.paragraph.of === metadata.paragraph.value) {
        // already corrected
        return false;
    }

    let story = correction;
    const messages: Array<BlockContent | DefinitionContent>[] = [];
    messages.push(...(metadata.messages ?? []));

    // need to get ast from original so the paragraph count is correct
    const ast = await transformToAst(original);
    if (ast.children.length !== metadata.paragraph.of) {
        metadata.paragraph.of = ast.children.length;
        await git.correctText(path, story, metadata);
    } else {
        fireUpdate(path, metadata);
    }

    console.log('prepare ollama');
    await createModels();

    const ollama = new Ollama({ host: `http://${host}`, fetch: noTimeoutFetch });

    const textblocks = ast.children.reverse();
    for (let i = 0; i < textblocks.length; i++) {
        const startBlock = now();
        if (i < metadata.paragraph.value) {
            console.log(`skip paragraph ${i}`);
            continue;
        }
        let element = [textblocks[i]];
        while (i + 1 < textblocks.length && textblocks[i + 1].type !== 'paragraph') {
            // add previous non paragraph elements to current
            element = [textblocks[i + 1], ...element];
            i++;
        }
        metadata.paragraph.value = i;
        const text = transformFromAst({ type: 'root', children: element });
        let changes = false;
        let currentTime = 0;
        for (let trys = 0; trys < 10; trys++) {

            console.log(`Process Part\n\n${text}\n\n`);

            const result = await ollama.chat({ model: 'spelling', messages: [{ role: 'user', content: text }], stream: true });
            const parts = [] as string[];


            console.log('Response \n\n');

            for await (const part of result) {
                parts.push(part.message.content);
                process.stdout.write(part.message.content);
            }


            console.log(`Response Finished`);
            // console.log( part.message.content);

            const corrected = parts.join('');
            // console.log( formatMarkdown(corrected));

            if (corrected.length < text.length * 0.8) {
                // probably not the result we want
                console.log(`retry  ${trys} of 10`);
                try {

                    messages.push([
                        {
                            type: 'paragraph',
                            children: [
                                {
                                    type: 'text',
                                    value: `retry ${trys} of 10 for textpart ${textblocks.length - 1}`
                                }]
                        },
                        {
                            type: 'blockquote',
                            children: [
                                ...transformToAst(corrected).children as BlockContent[]
                            ]
                        }
                    ]
                    )
                } catch (error) {
                    // this should always return an valid AST for this method, but to be safe
                    messages.push([ParagrahTexts(JSON.stringify(error))]);
                }
                continue;
            }

            const start_of_text = element[0].position!.start.offset!;
            const end_of_text = element[element.length - 1].position!.end.offset!;

            const newStory = story.substring(0, start_of_text)
                + formatMarkdown(corrected) + (end_of_text < story.length ? (
                    story.substring(end_of_text + 1)) : ''
                );
            await git.correctText(path, newStory, metadata);
            changes = story !== newStory
            story = newStory;
            const endBlock = now();
            currentTime = endBlock.getTime() - startBlock.getTime();
            metadata.time_in_ms += currentTime;
            // we got an updated text just stop now
            break;
        }
        if (!changes) {
            console.log(`No Changes for ${textblocks.length - i} to ${textblocks.length - i + element.length - 1}`);
            if (element.length > 1) {
                messages.push([ParagrahTexts(`No changes for parts ${textblocks.length - i} to ${textblocks.length - i + element.length - 1}`)])
            } else {
                messages.push([ParagrahTexts(`No changes for part ${textblocks.length - i}`)])
            }
        }

        metadata.messages = messages;
        await git.correctText(path, story, metadata);

    }



    return true;



}

























// markdown helper
const transformToAst = (text: string) => unified()
    .use(remarkParse)
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 30,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    }).parse(text);



const formatMarkdown = (text: string) => unified()
    .use(remarkParse)
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 60,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    })
    .use(remarkStringify)
    .processSync(text).value as string;

export const transformFromAst = (ast: Root) => unified()
    .use(remarkWiki, { hrefTemplate: (x: string) => x.toLocaleLowerCase() })
    .use(remarkBreakLine, {
        "removeLinebreaksAndMultipleSpaces": true,
        "maxLineLength": 30,
        "mergableElements": [
            "emphasis",
            "strong"
        ]
    }).use(remarkStringify)
    .stringify(ast)
    ;




const now = () => new Date(Date.now());


function ParagrahTexts(params: string): Paragraph {
    return {
        type: 'paragraph',
        children: [{ type: 'text', value: params }]
    }

}
