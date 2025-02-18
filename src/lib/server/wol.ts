
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

import https from 'https';

import * as svelteEnve from '$env/static/private'

import { z } from 'zod';

import type { BlockContent, DefinitionContent, Paragraph, Root, RootContent } from 'mdast';

import * as git from '$lib/server/git'
import { fireUpdate } from '$lib/trpc/router';
import * as windowsRootCerts from 'node-windows-root-certs-napi';
import { systemCertsSync } from 'system-ca';
import { zodToJsonSchema } from "zod-to-json-schema";

import os from 'os';


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
const resolver = new Resolver();

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
const env = envParser.parse(svelteEnve);

// check if all required systems files are present
const requiredFiles = [
    'systems/general.system',
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
} as const satisfies Record<string, ModelPropertys>;
// the model to use
const model: keyof typeof model_properties = 'qwen2.5:32b';
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


    const spellingSystem = fs.readFileSync('systems/spelling.system', 'utf8');
    const correctionSystem = fs.readFileSync('systems/correction.system', 'utf8');
    const improvementSystem = fs.readFileSync('systems/improvement.system', 'utf8');
    const generalSystem = fs.readFileSync('systems/general.system', 'utf8');

    if (models.models.every(m => m.name !== 'general')) {
        await ollama.create({ model: 'general', from: model, system: generalSystem, parameters: { num_ctx: context_window } });
    } else {
        await ollama.delete({ model: 'general' });
        await ollama.create({ model: 'general', from: model, system: generalSystem, parameters: { num_ctx: context_window } });
    }
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

    const { original, correction, metadata } = (await git.tryGetCorrection(path)) ?? {
        metadata: { paragraph: { value: 0, of: undefined }, time_in_ms: 0, messages: [], paragraphInfo: {} },
        correction: await git.getText(path),
        original: await git.getText(path)
    };
    if (metadata.paragraph.of === metadata.paragraph.value) {
        // already corrected
        return false;
    }

    const desiredStyle = `
    Du bewertest und verbesserst Textabschnitte, indem du sie inhaltlich und stilistisch überarbeitest.
Dabei soll der verbesserte Text emotional, bildlich und plastisch wirken, sofern nicht anders festgelegt.
`;
    const storyContext = `
    
# Formatierung und Struktur

- Der Text ist in Markdown geschrieben, du gibst auch Markdown zurück
- Der Text besitzt nur Überschriften, Fett, Kursiv und Wörtlicherede (\`"\`) als Formatierung
- Vor der Wörtlichenrede ist immer ein Marker der angibt wer gerade Spricht.
  Wenn der Charakter Fay etwas sagt, sieht das so aus [[Fay]]"Hallo."
- Fehlt der Marker vor der Wörtlichenrede ist dies ein Fehler.

# Deine Aufgabe

- Zu dem Eingabetext eine Fassung dieses zurückzuliefern,
  bei der Grammatikfehler und Rechtschreibfehler korrigiert sind.
- Fehlende Marker zur Wörtlichen Rede Ergänzen. Wenn möglich versuche
  die redende Person abzuleiten und in den Marker zu schreiben.
- Gliederung der Absätze verbessern. Zu lange Absätze wenn möglich und
  Sinnvoll in kürzere Aufteilen.
- Der Zurückgegebene Text enthält sonst keine weiteren Anmerkungen.
- Wenn keine Änderungen gemacht werden müssen, gibst du den Eingabetext
  unverändert zurück.

# Informationen zur Geschichte

- Die Texte sind in Deutsch geschrieben.
- Der Protagonist heißt Fay
- In der Geschichte existiert eine Spezies namens Telchinen
- Telchine haben kein Geschlecht
- Ausschließlich für Telchine wird die Geschlechtsneutrale Sprache nach De-e-System verwendet
- Die Geschichte ist in der dritten Person in der Vergangenheit geschrieben
- Der Erzähler beschre


# Wiederkehrende Charaktere

**Fay**:
Protagonist Männlich

**Dio**:
Männlich

**Pho**:
Telchin

**Tia**
Weiblich

**Ren**
Weiblich

# Beispiel Geschlechtsneutraler Sprache

\`\`\`
Pho sprang direkt darauf an und verwickelte ihn
in ein Gespräch. Er überlegte ob seine Herangehensweise dabei korrekt war.
Für einen Handwerker war er jedenfalls geschickt.
\`\`\`

wird nach De-e-System umgeschrieben zu

\`\`\`
Pho sprang direkt darauf an und verwickelte en
in ein Gespräch. En überlegte ob ense Herangehensweise dabei korrekt war.
Für ein Handwerkere war en jedenfalls geschickt.
\`\`\`
    `;


    let story = correction;
    const messages: Array<BlockContent | DefinitionContent>[] = [];
    messages.push(...(metadata.messages ?? []));

    // need to get ast from original so the paragraph count is correct

    const paragraphsReversed = await paragraphsWithPrefixs(original).reverse();



    if (paragraphsReversed.length !== metadata.paragraph.of) {
        metadata.paragraph.of = paragraphsReversed.length;
        await git.correctText(path, story, metadata);
    } else {
        fireUpdate(path, metadata);
    }

    console.log('prepare ollama');
    await createModels();

    const ollama = new Ollama({ host: `${protocol}://${host}:${port}`, fetch: noTimeoutFetch });

    for (let i = 0; i < paragraphsReversed.length; i++) {
        const startBlock = now();
        if (i < metadata.paragraph.value) {
            console.log(`skip paragraph ${i}`);
            continue;
        }
        const element = paragraphsReversed[i];
        metadata.paragraph.value = i;
        const text = element.text;
        const prev = i < paragraphsReversed.length ? paragraphsReversed[i + 1]?.text : undefined;
        const next = i > 0 ? paragraphsReversed[i - 1]?.text : undefined;
        const input = {
            context: {
                storyContext: storyContext,
                intendedStyle: desiredStyle,
                previousParagraph: prev ?? null,
                nextParagraph: next ?? null,
            },
            paragraphToCorrect: text,
        } satisfies CorrectionInput;
        let changes = false;
        let currentTime = 0;
        for (let trys = 0; trys < 10; trys++) {

            console.log(`Process Part\n\n${text}\n\n`);
            // eslint-disable-next-line no-debugger
            //  debugger;
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

            const start_of_text = element.start!.offset!;
            const end_of_text = element.end!.offset!;


            const start_line_of_removed_text = element.start!.line!;
            const end_line_of_removed_text = element.end!.line!;

            const number_of_lines_removed = end_line_of_removed_text - start_line_of_removed_text + 1;
            const number_of_lines_added = correction.corrected.split('\n').length - 1;

            const line_delta = number_of_lines_added - number_of_lines_removed;



            const newStory = story.substring(0, start_of_text)
                + formatMarkdown(correction.corrected) + (end_of_text < story.length ? (
                    story.substring(end_of_text + 1)) : ''
                );

            const correction_metadata_with_line_count = {
                ...correction,
                lines: {
                    start: start_line_of_removed_text,
                    end: start_line_of_removed_text + number_of_lines_added,
                }

            };

            const current_index = paragraphsReversed.length - i - 1;
            metadata.paragraphInfo[current_index] = correction_metadata_with_line_count;

            // update the metadata of previous added paragarphs that follow this so the line numbers are correct
            for (let j = current_index + 1; j < paragraphsReversed.length; j++) {
                const info = metadata.paragraphInfo[j];
                if (info) {
                    metadata.paragraphInfo[j] = {
                        ...info,
                        lines: {
                            start: info.lines.start + line_delta,
                            end: info.lines.end + line_delta,
                        }
                    }
                }
            }

            metadata.paragraph.value = i + 1
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
            console.log(`No Changes for paragraph ${paragraphsReversed.length - i}`);
            messages.push([ParagrahTexts(`No changes for part ${paragraphsReversed.length - i}`)])
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
