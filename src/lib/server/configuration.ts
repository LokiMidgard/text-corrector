
export const paragrapInfo = z.object({
    original: z.string(),
    selectedText: z.enum(['original', 'edited', 'corrected'])
        .or(z.tuple([z.string(), z.enum(['correction'])]).readonly())
        .or(z.tuple([z.string(), z.enum(['alternative']), z.string()]).readonly()).optional(),
    edited: z.string().optional(),
    corrected: z.object({
        text: z.string(),
        corrections: z.array(z.object({
            message: z.string(),
            shortMessage: z.string(),
            offset: z.number(),
            length: z.number(),
            alternativeReplacement: z.array(z.string()),
        })),
    }).optional(),
    judgment: z.record(z.string(), z.object({
        goodPoints: z.array(z.string()),
        badPoints: z.array(z.string()),
        score: z.number(),
        text: z.object({
            correction: z.string(),
            alternative: z.record(z.string(), z.string()),
        }),
        involvedCharacters: z.array(z.string()),
        protocol: z.array(z.object({
            style: z.string(),
            description: z.string(),
            newValue: z.unknown(),
            oldValue: z.unknown(),
        })).optional(),
    })),
})

export type NewParagrapInfo = z.infer<typeof paragrapInfo>;




import * as svelteEnve from '$env/static/private'

import { z } from 'zod';
import ping from 'ping';
import wol from 'wake_on_lan';
import fs from 'fs';



import * as windowsRootCerts from 'node-windows-root-certs-napi';
import { systemCertsSync } from 'system-ca';

import os from 'os';


import { Agent } from 'undici'

import https from 'https';

const envParser = z.object({
    OLLAMA_HOST: z.string(),
    OLLAMA_PROTOCOL: z.string(),
    OLLAMA_PORT: z.string(),
    OLLAMA_MAC: z.string(),
    OLLAMA_IP: z.string().ip(),

    LANGUAGETOOL_HOST: z.string(),
    LANGUAGETOOL_PROTOCOL: z.string(),
    LANGUAGETOOL_PORT: z.string(),
    LANGUAGETOOL_MAC: z.string(),
    LANGUAGETOOL_IP: z.string().ip(),


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
export const env = envParser.parse({ ...svelteEnve, ...process.env });





const fetchAgent = (protocol: string) => protocol == 'https' ? new https.Agent({ ca }) : undefined;

const dispatcher = new Agent({
    headersTimeout: Number.MAX_SAFE_INTEGER,
    connect: {
        ca
    }
});

export const fetchOptions = (protocol: string) => ({
    agent: fetchAgent(protocol),
    dispatcher,
});






async function performWake(mac: string, ip: string) {
    // Path to the named pipe (same as in your Bash script)
    const pipePath = '/opt/wol/mac_pipe';

    // Check if the named pipe exists
    if (!fs.existsSync(pipePath)) {
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

export async function wake({ ip, mac, isHealthy }: { ip: string, mac: string, isHealthy: () => Promise<boolean> }) {
    //check with ping untill pc is online if not successfull send wol
    let state = await ping.promise.probe(ip);
    const startTime = Date.now();
    while (!state.alive) {
        // try for 20 seconds
        if (Date.now() - startTime > 20000) {
            console.error('Failed to wake up');
            throw new Error('Failed to wake up');

        }
        await performWake(mac, ip);

        await new Promise((resolve) => setTimeout(resolve, 5000));


        state = await ping.promise.probe(await ip);
    }

    // wait untill server is healthy
    while (!(await isHealthy())) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }

}

