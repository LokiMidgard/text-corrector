
import ping from 'ping';
import wol from 'wake_on_lan';
import fs from 'fs';
import { Ollama } from 'ollama';

import { Agent } from 'undici'

import https from 'https';

import * as svelteEnve from '$env/static/private'

import { z } from 'zod';

import type { BlockContent, DefinitionContent, Paragraph, RootContent } from 'mdast';

import * as git from '$lib/server/git'
import { fireUpdate } from '$lib/trpc/router';
import * as windowsRootCerts from 'node-windows-root-certs-napi';
import { systemCertsSync } from 'system-ca';
import { zodToJsonSchema } from "zod-to-json-schema";

import os from 'os';
import { formatMarkdown, transformFromAst, transformToAst } from '$lib';


type CorrectionInput = {
    context: {
        storyContext: string,
        intendedStyle: string,
        previousParagraph: string | null,
        nextParagraph: string | null,
    }
    paragraphToCorrect: string,
}

const CorrectionResultParser = z.object({
    involvedCharacters: z.array(z.string()),
    corrected: z.string(),
    alternative: z.string(),
    goodPoints: z.string(),
    badPoints: z.string(),
    judgment: z.number(),
});

export type CorrectionResult = z.infer<typeof CorrectionResultParser>;

const envParser = z.object({
    OLLAMA_HOST: z.string(),
    OLLAMA_PROTOCOL: z.string(),
    OLLAMA_PORT: z.string(),
    OLLAMA_MAC: z.string(),
    OLLAMA_IP: z.string().ip(),
    GITHUB_API_TOKEN: z.string(),
    REPO: z.string(),
    PATH_FILTER: z.string().optional(),
    MODEL: z.string().optional(),
    CONTEXT_WINDOW: z.number().optional(),
});
export type Env = z.infer<typeof envParser>;

const ca = os.platform() != "win32"
    ? systemCertsSync()
    : undefined;
// const ca = undefined;
if (os.platform() == "win32") {
    windowsRootCerts.useWindowsCerts();
}

console.log()
const env = envParser.parse({ ...svelteEnve, ...process.env });

// check if all required systems files are present
const requiredFiles = [
    'systems/general.system',
    'systems/desired.system',
    'systems/context.system',
];


const desired = fs.readFileSync('systems/desired.system', 'utf8');
const context = fs.readFileSync('systems/context.system', 'utf8');

const missingFiles = requiredFiles.filter(file => !fs.existsSync(file));

if (missingFiles.length > 0) {
    throw new Error(`Missing system files: ${missingFiles.join(', ')}`);
}




const host = env.OLLAMA_HOST;
const protocol = env.OLLAMA_PROTOCOL;
const port = env.OLLAMA_PORT;
const mac = env.OLLAMA_MAC;
const ip = env.OLLAMA_IP;

const githubApiToken = env.GITHUB_API_TOKEN;
const repo = env.REPO;


const fetchAgent = protocol == 'https' ? new https.Agent({ ca }) : undefined;

const pathFilter = env.PATH_FILTER ? new RegExp(env.PATH_FILTER) : /story\/.*\.md/;
const dispatcher = new Agent({
    headersTimeout: Number.MAX_SAFE_INTEGER,
    connect: {
        ca
    }
});

const noTimeoutFetch = (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const someInit = init || {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return fetch(input, {
        ...someInit,
        keepalive: true,
        dispatcher,
        agent: fetchAgent,
    })
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
    'hf.co/Hasso5703/Mistral-Small-24B-Instruct-2501-Q4_0-GGUF': {
        context_window: 27192,
    },
} as const satisfies Record<string, ModelPropertys>;
// the model to use
const model: keyof typeof model_properties = 'hf.co/Hasso5703/Mistral-Small-24B-Instruct-2501-Q4_0-GGUF';
// manly for debbugging purpus


const context_window = env.CONTEXT_WINDOW ?? model_properties[model].context_window;




async function performWake() {
    // Path to the named pipe (same as in your Bash script)
    const pipePath = '/opt/wol/mac_pipe';

    // Check if the named pipe exists
    if (!fs.existsSync(pipePath)) {
        console.debug(`Named pipe does not exist: ${pipePath}`);
        wol.wake(mac, {
            address: ip,
        }, function (error: unknown) {
            if (error) {
                console.error(error);
            } else {
                console.log('wol packet sent');
            }
        });
    } else {
        // Write the MAC address to the pipe
        fs.writeFile(pipePath, `${mac}\n`, (err) => {
            if (err) {
                console.error(`Failed to write to pipe: ${err.message}`);
            } else {
                console.log(`MAC address ${mac} sent to the pipe.`);
            }
        });
    }
}

async function wake() {
    //check with ping untill pc is online if not successfull send wol
    let state = await ping.promise.probe(ip);
    while (!state.alive) {
        await performWake();

        await new Promise((resolve) => setTimeout(resolve, 5000));


        state = await ping.promise.probe(await ip);
    }

    // wait untill server is healthy
    console.log('wait for server to be healthy');
    const isHealthy = async () => {
        try {
            const httpResponse = await fetch(`${protocol}://${host}:${port}/api/version`, {
                agent: fetchAgent,
                dispatcher,
            });
            console.log(`call ${protocol}://${host}:${port}/api/version`);
            if (!httpResponse.ok) {
                console.log(`${protocol}://${host}:${port}/api/version failed ${httpResponse.status}`);
            }
            return httpResponse.ok;
        } catch (e) {
            console.error(e);
            return false;
        }
    }
    while (!(await isHealthy())) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    console.log('server is healthy');

}




async function createModels() {
    await wake();
    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });
    const models = await ollama.list();

    const generalSystem = fs.readFileSync('systems/general.system', 'utf8');

    if (models.models.every(m => m.name !== 'general')) {
        await ollama.create({ model: 'general', from: model, system: generalSystem, parameters: { num_ctx: context_window } });
    } else {
        await ollama.delete({ model: 'general' });
        await ollama.create({ model: 'general', from: model, system: generalSystem, parameters: { num_ctx: context_window } });
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
                await fetch(`${protocol}://${host}/poweroff`, {
                    method: 'POST',
                    agent: fetchAgent,
                    dispatcher,

                });
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

    const metadata: git.CorrectionMetadata = (await git.tryGetCorrection(path)) ?? {
        time_in_ms: 0,
        messages: [],
        paragraphInfo: paragraphsWithPrefixs(await git.getText(path)).map((v) => {
            return {
                text: { original: formatMarkdown(v.text), },
                involvedCharacters: undefined,
                judgment: undefined,
            };

        }),
    };
    if (metadata.paragraphInfo.every(v => v.judgment !== undefined)) {
        // already corrected
        return false;
    }


    const messages: Array<BlockContent | DefinitionContent>[] = [];
    messages.push(...(metadata.messages ?? []));
    metadata.messages = messages;


    // need to get ast from original so the paragraph count is correct
    fireUpdate(path, metadata);



    await createModels();
    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });
    for (let i = 0; i < metadata.paragraphInfo.length; i++) {
        const startBlock = now();
        if (metadata.paragraphInfo[i]?.judgment !== undefined) {
            continue;
        }
        const text = metadata.paragraphInfo[i].text.original;
        const prev = i > 0 ? metadata.paragraphInfo[i - 1]?.text.original : undefined;
        const next = i < metadata.paragraphInfo.length ? metadata.paragraphInfo[i + 1]?.text.original : undefined;

        const input = {
            context: {
                storyContext: context,
                intendedStyle: desired,
                previousParagraph: prev ?? null,
                nextParagraph: next ?? null,
            },
            paragraphToCorrect: text,
        } satisfies CorrectionInput;
        let currentTime = 0;
        for (let trys = 0; trys < 10; trys++) {

            console.log(`Process Part\n\n${text}\n\n`);
            const result = await ollama.chat({ model: 'general', messages: [{ role: 'user', content: JSON.stringify(input, undefined, 2) }], format: zodToJsonSchema(CorrectionResultParser), stream: true });
            const parts = [] as string[];


            console.log('Response \n\n');

            for await (const part of result) {
                parts.push(part.message.content);
                process.stdout.write(part.message.content);
            }


            console.log(`Response Finished`);
            // console.log( part.message.content);

            const correctionJsonText = parts.join('');
            // console.log( formatMarkdown(corrected));

            const { data: correction, success, error } = CorrectionResultParser.safeParse(JSON.parse(correctionJsonText));



            if (!success) {
                // probably not the result we want
                console.log(`retry  ${trys} of 10`);
                if (!error.isEmpty) {
                    console.error(error.toString());
                    messages.push([ParagrahTexts(error.toString())]);
                }
                try {

                    messages.push([
                        {
                            type: 'paragraph',
                            children: [
                                {
                                    type: 'text',
                                    value: `retry ${trys} of 10 for textpart ${i}`
                                }]
                        },
                        {
                            type: 'blockquote',
                            children: [
                                ...transformToAst(`\`\`\`\n${correctionJsonText}\n\`\`\``).children as BlockContent[]
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

            correction.corrected = formatMarkdown(correction.corrected);
            correction.alternative = formatMarkdown(correction.alternative);

            metadata.paragraphInfo[i].involvedCharacters = correction.involvedCharacters;
            metadata.paragraphInfo[i].judgment = {
                score: correction.judgment,
                goodPoints: correction.goodPoints,
                badPoints: correction.badPoints,
            };
            metadata.paragraphInfo[i].text.correction = correction.corrected;
            metadata.paragraphInfo[i].text.alternative = correction.alternative;


            await git.correctText(path, metadata);
            const endBlock = now();
            currentTime = endBlock.getTime() - startBlock.getTime();
            metadata.time_in_ms += currentTime;
            // we got an updated text just stop now
            break;
        }
        fireUpdate(path, metadata);


        metadata.messages = messages;
        await git.correctText(path, metadata);
    }



    return true;



}


























const paragraphsWithPrefixs = (text: string) => transformToAst(text).children.reverse().reduce((p, c) => {
    if (p.length == 0) {
        // always add it if it has no entrys yet 
        return [[c]];
    } else if (c.type == 'paragraph') {
        return [[c], ...p];
    } else {
        const [first, ...rest] = p;
        return [[c, ...first], ...rest];
    }
}, [] as RootContent[][])
    .map(x => {
        const [first] = x;
        const last = x[x.length - 1];
        return {
            text: transformFromAst({ type: 'root', children: x }),
            start: first.position?.start,
            end: last.position?.end,
        }
    });




const now = () => new Date(Date.now());


function ParagrahTexts(params: string): Paragraph {
    return {
        type: 'paragraph',
        children: [{ type: 'text', value: params }]
    }

}
