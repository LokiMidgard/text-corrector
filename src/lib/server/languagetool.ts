import { transformToAst } from "$lib";
import type { BlockContent, PhrasingContent, RootContent } from "mdast";
import { env, fetchOptions, wake } from "./configuration";


export type LanguageToolResult = {
    software: Software;
    language: Language;
    matches: Match[];
};

type Software = {
    name: string;
    version: string;
    buildDate: string;
    apiVersion: number;
    status: string;
}

type Language = {
    name: string;
    code: string;
    detectedLanguage: {
        name: string;
        code: string;
        confidence: number;
        source: string;
    };
};

type Match = {
    message: string;
    shortMessage: string;
    offset: number;
    length: number;
    replacements: Replacement[];
    context: Context;
    sentence: string;
    rule?: Rule;
};

type Replacement = {
    value?: string;
};

type Context = {
    text: string;
    offset: number;
    length: number;
};

type Rule = {
    id: string;
    subId?: string;
    description: string;
    urls: { value?: string }[];
    issueType?: string;

    category: {
        id?: string;
        name?: string;
    };
};

export async function getLanguageToolResult(text: string): Promise<LanguageToolResult> {
    //curl -X POST --header 'Content-Type: application/x-www-form-urlencoded' --header 'Accept: application/json' -d 'data=data&language=de&enabledOnly=false' 'https://api.languagetoolplus.com/v2/check'

    
    const ip = env.LANGUAGETOOL_IP;
    const port = env.LANGUAGETOOL_PORT;
    const protocol = env.LANGUAGETOOL_PROTOCOL;
    const host = env.LANGUAGETOOL_HOST;
    const mac = env.LANGUAGETOOL_MAC;
    const url = `${protocol}://${host}:${port}/v2/check`;
   
    const isHealthy = async (): Promise<boolean> => {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
            },
            body: new URLSearchParams({
                text: 'test',
                language: 'de-DE',
            }),
            ...fetchOptions(protocol),
        });
        return response.ok;
    };

    await wake({ ip, mac, isHealthy });



    const response = await fetch('https://api.languagetoolplus.com/v2/check', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
        },
        body: new URLSearchParams({
            text: text,
            language: 'de',
        }),
        ...fetchOptions(protocol),
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    return result;
}
